/**
 * Stream Controller
 */

import type { StremioStream, StreamRequest, StreamResponse } from '../models/stream-model.js';
import type { SourceStream, StreamContext } from '../models/source-model.js';
import type { DebridProvider } from '../models/debrid-model.js';
import { RealDebridService } from '../services/realdebrid-service.js';
import { SourceService } from '../services/source-service.js';
import { StreamService } from '../services/stream-service.js';
import { ConfigService } from '../services/config-service.js';
import { TorboxService } from '../services/torbox-service.js';
import { DEBRID_MAX_WAIT_MS, REQUEST_BUDGET_MS, onLateResults } from '../services/torrent-indexer-shared.js';

// O orçamento do pedido (REQUEST_BUDGET_MS) é o mesmo da busca no torrent-indexer,
// contado desde a chegada do pedido; estourar o timeout do addon no AIOStreams
// descarta todos os streams do GuIndex. Depois da busca, a consulta de cache do
// debrid espera até o fim do orçamento (ou DEBRID_MAX_WAIT_MS, se definido): com
// o TorBox lento, a resposta sai sem o selo e a consulta termina em segundo plano.
// Folga, no fim do orçamento, para montar a resposta depois dessa espera.
const DEBRID_SAFETY_MS = 200;

/** Resolve `true` se a promise terminar dentro de `ms`, `false` se o prazo vencer antes. */
export async function finishesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

// Cache da resposta inteira do /stream. Dentro de STREAM_CACHE_TTL_MS a resposta
// sai do cache; depois disso, até STREAM_CACHE_STALE_MS, sai a versão antiga na
// hora e uma busca nova roda em segundo plano (stale-while-revalidate). Se a busca
// nova voltar vazia, a antiga continua valendo (stale-if-error).
const STREAM_CACHE_TTL_MS = parseNonNegativeInt(process.env.STREAM_CACHE_TTL_MS, 2 * 60 * 1000);
const STREAM_CACHE_STALE_MS = parseNonNegativeInt(process.env.STREAM_CACHE_STALE_MS, 30 * 60 * 1000);
const STREAM_CACHE_MAX_ENTRIES = 500;

interface StreamCacheEntry {
  response: StreamResponse;
  freshUntil: number;
  staleUntil: number;
  /** Sem a checagem de cache do debrid: nasce velha, e o próximo pedido refaz em segundo plano */
  partial: boolean;
  /** Hashes que a busca achou (antes dos cortes da resposta) */
  sourceHashes?: Set<string>;
}

/** `have` tem todos os hashes de `need`; `null` são hashes desconhecidos. */
const hasAllHashes = (have: Set<string> | undefined, need: Set<string> | null): boolean =>
  need !== null && have !== undefined && [...need].every((hash) => have.has(hash));

/** O que monta uma resposta de novo: os streams das fontes e o debrid do pedido. */
interface ResponseSources {
  streams: SourceStream[];
  provider?: DebridProvider;
  token?: string;
  extra?: StreamRequest['extra'];
  /** Fim da consulta ao debrid, que grava cada resposta nos streams */
  settled?: Promise<unknown>;
}

export class StreamController {
  private static streamCache = new Map<string, StreamCacheEntry>();

  // O multi terminou depois da resposta com streams novos (o 4K que o cache não
  // tinha, por exemplo): descarta a resposta guardada desse título que não os
  // tem, para que o próximo pedido, já com o Meilisearch atualizado, busque de
  // novo. A busca desse título ainda em andamento também pode não tê-los: se
  // não tiver, a resposta dela vai para quem pediu, mas não fica guardada.
  private static readonly stopLateResults = onLateResults((type, id, hashes) => {
    const prefix = `${type}|${id}|`;
    const late = hashes?.length ? new Set(hashes.map((hash) => hash.toLowerCase())) : null;
    for (const [key, entry] of [...StreamController.streamCache]) {
      if (key.startsWith(prefix) && !hasAllHashes(entry.sourceHashes, late)) StreamController.streamCache.delete(key);
    }
    const outdated = StreamController.outdatedRefreshes;
    for (const key of StreamController.streamRefreshInFlight.keys()) {
      if (!key.startsWith(prefix)) continue;
      const previous = outdated.get(key);
      outdated.set(key, late && previous !== null ? new Set([...(previous ?? []), ...late]) : null);
    }
  });
  private static streamRefreshInFlight = new Map<string, Promise<StreamResponse>>();
  /** Buscas em andamento e os hashes que o multi atrasado trouxe depois que elas começaram */
  private static outdatedRefreshes = new Map<string, Set<string> | null>();
  /** Hashes que cada busca achou, para comparar com os do multi atrasado */
  private static sourceHashes = new WeakMap<StreamResponse, Set<string>>();
  /** hash + contexto de cada stream entregue, para reaplicar o filtro de bloqueio do RD no cache */
  private static streamOrigins = new WeakMap<StremioStream, { hash: string; context?: StreamContext }>();
  /** Respostas montadas sem a checagem de cache do debrid completa */
  private static partialResponses = new WeakSet<StreamResponse>();
  /**
   * Streams de origem de cada resposta parcial, enquanto a consulta ao debrid
   * segue em segundo plano e grava as respostas neles. Quando ela termina, a
   * resposta guardada é remontada e eles são soltos.
   */
  private static pendingSources = new WeakMap<StreamResponse, ResponseSources>();


  private config = ConfigService.loadConfig();
  private readonly resolveBaseUrl = this.config.baseUrl;
  private readonly torboxStreamLimit = this.config.torboxStreamLimit ?? 12;

  async handleStreamRequest(args: StreamRequest): Promise<StreamResponse> {
    if (STREAM_CACHE_TTL_MS === 0) {
      return this.computeStreams(args);
    }

    const key = this.streamCacheKey(args);
    const now = Date.now();
    const cached = StreamController.streamCache.get(key);
    if (cached && !args.extra?.forceFresh) {
      if (now < cached.freshUntil) {
        console.info(`[GuIndex] ♻️ Stream do cache: ${args.type}/${args.id}`);
        return this.withoutBlocked(cached.response);
      }
      if (now < cached.staleUntil) {
        console.info(`[GuIndex] ♻️ Stream do cache (antigo, atualizando em segundo plano): ${args.type}/${args.id}`);
        void this.refreshStreams(key, args).catch(() => undefined);
        return this.fromCache(key, cached);
      }
    }

    const response = await this.refreshStreams(key, args);
    if (response.streams.length === 0 && cached && now < cached.staleUntil) {
      console.info(`[GuIndex] ♻️ Busca nova voltou vazia; mantendo a resposta anterior: ${args.type}/${args.id}`);
      return this.fromCache(key, cached);
    }
    return response;
  }

  /** Resposta guardada; a parcial sai remontada com o que o debrid respondeu depois dela. */
  private fromCache(key: string, entry: StreamCacheEntry): StreamResponse {
    const sources = entry.partial ? StreamController.pendingSources.get(entry.response) : undefined;
    return this.withoutBlocked(sources ? this.rebuildPartial(key, entry, sources, false) : entry.response);
  }

  /**
   * Remonta a resposta parcial guardada com o que o debrid respondeu depois dela e
   * com o cache de disponibilidade do TorBox, na hora e sem consultar nada.
   * Completa, ela substitui a guardada. Com a consulta já terminada (`settled`),
   * substitui de qualquer jeito e solta os streams de origem. Uma parcial que não
   * foi guardada (`replaces` é a completa que ficou no lugar dela) só a substitui
   * completa.
   */
  private rebuildPartial(
    key: string,
    entry: StreamCacheEntry,
    sources: ResponseSources,
    settled: boolean,
    replaces: StreamCacheEntry = entry
  ): StreamResponse {
    let rebuilt: StreamResponse;
    try {
      this.applyKnownAvailability(sources);
      rebuilt = this.formatResponse(sources);
    } catch (error) {
      console.error(`[GuIndex] Falha ao remontar a resposta guardada: ${error instanceof Error ? error.message : error}`);
      return entry.response;
    }
    const complete = !StreamController.partialResponses.has(rebuilt);
    if (settled) StreamController.pendingSources.delete(rebuilt);
    const cache = StreamController.streamCache;
    if ((complete || (settled && replaces === entry)) && cache.get(key) === replaces) {
      // A busca é de quando a parcial foi guardada; completa, vale o TTL desde então
      const storedAt = entry.staleUntil - Math.max(STREAM_CACHE_TTL_MS, STREAM_CACHE_STALE_MS);
      cache.set(key, {
        ...entry,
        response: rebuilt,
        partial: !complete,
        freshUntil: complete ? Math.max(entry.freshUntil, storedAt + STREAM_CACHE_TTL_MS) : entry.freshUntil
      });
    }
    return rebuilt;
  }

  /**
   * Cache-Control da resposta do /stream. É `private` porque os links de resolve
   * levam o token do usuário; vazio ou sem a checagem do debrid não fica guardado.
   */
  static cacheControlFor(response: StreamResponse): string {
    if (STREAM_CACHE_TTL_MS === 0 || response.streams.length === 0 || StreamController.partialResponses.has(response)) {
      return 'no-store';
    }
    const maxAge = Math.floor(STREAM_CACHE_TTL_MS / 1000);
    const stale = Math.floor(Math.max(0, STREAM_CACHE_STALE_MS - STREAM_CACHE_TTL_MS) / 1000);
    return `private, max-age=${maxAge}, stale-while-revalidate=${stale}, stale-if-error=${stale}`;
  }

  private streamCacheKey(args: StreamRequest): string {
    const { type, id, extra } = args;
    const token = extra?.token ?? extra?.realdebridToken ?? extra?.torboxToken ?? '';
    return [type, id, extra?.debridProvider ?? '', token, extra?.requestBaseUrl ?? ''].join('|');
  }

  /**
   * Uma busca por chave; resultado não vazio entra no cache. Resposta sem a
   * checagem do debrid entra já velha: o próximo pedido sai dela na hora, sem
   * esperar outra busca, e a refaz em segundo plano com a disponibilidade pronta.
   * Ela não substitui uma resposta completa ainda válida, a não ser que fique
   * completa quando a consulta ao debrid terminar.
   */
  private refreshStreams(key: string, args: StreamRequest): Promise<StreamResponse> {
    const inFlight = StreamController.streamRefreshInFlight.get(key);
    if (inFlight) {
      return inFlight;
    }
    const pending = this.computeStreams(args)
      .then((response) => {
        const sourceHashes = StreamController.sourceHashes.get(response);
        const late = StreamController.outdatedRefreshes.get(key);
        if (late !== undefined && !hasAllHashes(sourceHashes, late)) {
          console.info(`[GuIndex] ♻️ Multi chegou durante a busca; a resposta não fica no cache: ${args.type}/${args.id}`);
          return response;
        }
        if (response.streams.length === 0) return response;
        const cache = StreamController.streamCache;
        const now = Date.now();
        const partial = StreamController.partialResponses.has(response);
        const entry: StreamCacheEntry = {
          response,
          freshUntil: partial ? now : now + STREAM_CACHE_TTL_MS,
          staleUntil: now + Math.max(STREAM_CACHE_TTL_MS, STREAM_CACHE_STALE_MS),
          partial,
          sourceHashes
        };
        // Quando a consulta ao debrid terminar, a parcial é remontada com as respostas
        const sources = partial ? StreamController.pendingSources.get(response) : undefined;
        const existing = cache.get(key);
        if (partial && existing && !existing.partial && now < existing.staleUntil) {
          // A completa guardada fica até a busca nova ficar completa
          void sources?.settled?.then(() => {
            if (StreamController.streamCache.get(key) === existing) this.rebuildPartial(key, entry, sources, true, existing);
          });
          return response;
        }
        cache.delete(key);
        if (cache.size >= STREAM_CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, entry);
        void sources?.settled?.then(() => {
          if (StreamController.streamCache.get(key) === entry) this.rebuildPartial(key, entry, sources, true);
        });
        return response;
      })
      .finally(() => {
        StreamController.streamRefreshInFlight.delete(key);
        StreamController.outdatedRefreshes.delete(key);
      });
    StreamController.streamRefreshInFlight.set(key, pending);
    return pending;
  }

  /**
   * Corta a lista já ordenada em `limit`, mas guarda o melhor stream de cada
   * qualidade: com 15+ 1080p prontos no TorBox, o 4K ainda não baixado não some.
   */
  static limitKeepingEachQuality(streams: StremioStream[], limit: number): StremioStream[] {
    if (streams.length <= limit) return streams;
    const keep = new Set<StremioStream>();
    const qualities = new Set<string>();
    for (const stream of streams) {
      const quality = stream.quality ?? 'Unknown';
      if (qualities.has(quality)) continue;
      qualities.add(quality);
      keep.add(stream);
    }
    for (const stream of streams) {
      if (keep.size >= limit) break;
      keep.add(stream);
    }
    return streams.filter((stream) => keep.has(stream));
  }

  /** Tira do cache os streams que o RD bloqueou depois que a resposta foi guardada. */
  private withoutBlocked(response: StreamResponse): StreamResponse {
    const streams = response.streams.filter((stream) => {
      const origin = StreamController.streamOrigins.get(stream);
      return !origin || !RealDebridService.isBlocked(origin.hash, origin.context);
    });
    if (streams.length === response.streams.length) return response;
    const filtered = { streams };
    if (StreamController.partialResponses.has(response)) StreamController.partialResponses.add(filtered);
    return filtered;
  }

  private async computeStreams(args: StreamRequest): Promise<StreamResponse> {
    const { type, id, extra } = args;
    const requestStartedAt = Date.now();

    try {
      console.info(`[GuIndex] 📥 Processando requisição de stream: ${type}/${id}`);
      
      // Fetch streams from all configured sources
      const debridSelection = StreamService.resolveDebridSelection({
        query: {},
        headers: {},
        extra,
        env: {
          realdebridToken: process.env.REALDEBRID_TOKEN,
          torboxToken: process.env.TORBOX_TOKEN
        }
      });
      const selectedProvider = debridSelection.provider;
      const selectedToken = debridSelection.token;
      const forceFresh = extra?.forceFresh === true;
      const fetchOptions = selectedToken
        ? {
            debridProvider: selectedProvider,
            realdebridToken: selectedProvider === 'realdebrid' ? selectedToken : undefined,
            torboxToken: selectedProvider === 'torbox' ? selectedToken : undefined,
            forceFresh
          }
        : forceFresh
          ? { forceFresh }
          : undefined;
      const sourceStreams = await SourceService.fetchStreamsFromAllSources(type, id, fetchOptions);
      
      // Split streams by transport type
      const processableStreams = sourceStreams.filter((stream) =>
        stream.magnet ||
        stream.infoHash ||
        (stream.url && (stream.url.startsWith('magnet:') || stream.url.startsWith('https://')))
      );

      if (processableStreams.length === 0) {
        console.info(`[GuIndex] ⚠️ Nenhum stream processável/magnet encontrado para ${type}/${id}`);
        return { streams: [] };
      }

      console.info(`[GuIndex] 🔄 Preparando ${processableStreams.length} streams brutos para verificação Debrid`);

      const sources: ResponseSources = {
        streams: processableStreams,
        provider: selectedProvider,
        token: selectedToken,
        extra
      };
      // A espera pelo debrid vai até o fim do orçamento do pedido, menos a folga
      // para montar a resposta. Sem resposta a tempo, os streams seguem como não
      // cacheados; a consulta continua em segundo plano, grava cada resposta nos
      // streams e enche o cache de disponibilidade.
      const debridWaitMs = Math.min(
        DEBRID_MAX_WAIT_MS,
        requestStartedAt + REQUEST_BUDGET_MS - DEBRID_SAFETY_MS - Date.now()
      );
      const availabilityStart = Date.now();
      sources.settled = this.ensureDebridAvailability(processableStreams, selectedProvider, selectedToken).catch(
        () => undefined
      );
      const availabilityDone = await finishesWithin(sources.settled, debridWaitMs);
      if (availabilityDone) {
        console.info(`[GuIndex] ⏱️ Verificação de cache no Debrid levou ${Date.now() - availabilityStart}ms`);
      } else {
        console.info(
          `[GuIndex] ⏰ Verificação de cache no Debrid passou do prazo (${Math.max(0, debridWaitMs)}ms); os streams sem resposta seguem como não cacheados`
        );
      }
      this.applyKnownAvailability(sources);
      const response = this.formatResponse(sources);
      const hashes = processableStreams.map((stream) => this.getStreamInfoHash(stream));
      StreamController.sourceHashes.set(response, new Set(hashes.filter((hash): hash is string => Boolean(hash))));
      return response;
    } catch (error) {
      console.error(`Stream processing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { streams: [] };
    }
  }

  /**
   * Aplica, sem consultar nada, o que já se sabe: o cache de disponibilidade do
   * TorBox ou a lista da conta do Real-Debrid já em memória.
   */
  private applyKnownAvailability(sources: ResponseSources): void {
    if (!sources.token) return;
    const account = sources.provider === 'torbox' ? undefined : RealDebridService.knownAccountTorrents(sources.token);
    if (sources.provider !== 'torbox' && !account) return;
    for (const stream of sources.streams) {
      if (stream.cached !== undefined) continue;
      const hash = this.getStreamInfoHash(stream);
      if (!hash) continue;
      const known = account ? account.has(hash) : TorboxService.knownAvailability(hash);
      if (known !== undefined) stream.cached = known;
    }
  }

  /**
   * Monta a resposta com o status de cache que os streams têm agora. Hash ainda
   * sem resposta do debrid deixa a resposta parcial, com os streams de origem
   * guardados para remontá-la quando o debrid responder.
   */
  private formatResponse(sources: ResponseSources): StreamResponse {
    const { streams: processableStreams, provider: selectedProvider, token: selectedToken, extra } = sources;

    // Hash sem resposta do debrid (prazo vencido ou consulta com erro): a resposta
    // não é a definitiva.
    const unresolved = processableStreams.filter(
      (stream) => stream.cached === undefined && this.getStreamInfoHash(stream)
    ).length;
    if (selectedToken && unresolved > 0) {
      console.info(`[GuIndex] ⚠️ Debrid sem resposta para ${unresolved} streams; seguem como não cacheados`);
    }

    if (!selectedToken) {
      console.info(`[GuIndex] ⚠️ Sem token Debrid. Retornando em modo fallback (Magnets diretos)`);
    }

    let blockedCount = 0;
    let streamMetadata: StremioStream[] = processableStreams
      .map((stream) => {
        const magnet = this.extractStreamMagnet(stream);
        const isHttpStream = stream.url?.startsWith('https://');
        const isCached = stream.cached === true;

        const commonOptions = {
          fallbackMagnet: magnet,
          forceNotWebReady:
            selectedProvider === 'torbox' ? false : !isCached || !selectedToken,
          realDebridReady: selectedProvider === 'realdebrid' ? isCached : undefined,
          torboxReady: selectedProvider === 'torbox' ? isCached : undefined,
          debridProvider: selectedProvider ?? 'realdebrid',
          viaDebrid: Boolean(selectedToken)
        };

        if (!selectedToken) {
          const url = magnet ?? stream.url;
          if (!url) return undefined;
          return StreamService.createStreamMetadata(stream, url, commonOptions);
        }

        if (selectedProvider !== 'torbox' && !magnet) {
          console.debug(`[GuIndex] ⏭️ Ignorando stream incompatível sem magnet: ${stream.name ?? stream.title}`);
          return undefined;
        }

        const hash = selectedProvider !== 'torbox' ? this.getStreamInfoHash(stream) : undefined;
        if (hash && RealDebridService.isBlocked(hash, stream.context)) {
          blockedCount++;
          return undefined;
        }

        const resolveUrl = this.buildResolveUrl({
          base: this.config.baseUrlIsFallback && extra?.requestBaseUrl ? extra.requestBaseUrl : this.resolveBaseUrl,
          token: selectedToken,
          magnet,
          provider: selectedProvider,
          context: stream.context,
          linkType: isHttpStream ? 'webdl' : 'torrent',
          originalUrl: isHttpStream ? stream.url : undefined
        });

        const meta = StreamService.createStreamMetadata(stream, resolveUrl, commonOptions);
        if (hash) {
          StreamController.streamOrigins.set(meta, { hash, context: stream.context });
        }
        return meta;
      })
      .filter((stream): stream is StremioStream => Boolean(stream));

    if (blockedCount > 0) {
      console.info(`[GuIndex] 🚫 ${blockedCount} streams escondidos: arquivo bloqueado pelo Real-Debrid (infringing_file)`);
    }

    // Sort and limit for TorBox to keep JSON lean
    if (selectedProvider === 'torbox') {
      streamMetadata = streamMetadata
        .sort((a, b) => {
          const aReady = a.behaviorHints?.torboxReady ? 1 : 0;
          const bReady = b.behaviorHints?.torboxReady ? 1 : 0;
          if (aReady !== bReady) return bReady - aReady;
          const aSize = (a.behaviorHints as any)?.videoSize ?? 0;
          const bSize = (b.behaviorHints as any)?.videoSize ?? 0;
          return bSize - aSize;
        });
      streamMetadata = StreamController.limitKeepingEachQuality(streamMetadata, this.torboxStreamLimit);
    }

    streamMetadata.sort((a, b) => {
      const aReady = a.behaviorHints?.realDebridReady || a.behaviorHints?.torboxReady ? 1 : 0;
      const bReady = b.behaviorHints?.realDebridReady || b.behaviorHints?.torboxReady ? 1 : 0;
      return bReady - aReady;
    });

    console.info(`[GuIndex] 📤 Entrega final: ${streamMetadata.length} streams formatados enviados ao Stremio`);
    const response = { streams: streamMetadata };
    if (selectedToken && unresolved > 0) {
      StreamController.partialResponses.add(response);
      StreamController.pendingSources.set(response, sources);
    }
    return response;
  }

  /**
   * Processes a link (magnet or WebDL URL) through the selected debrid provider when user actually plays the stream.
   */
  async processLinkForPlayback(params: {
    magnet?: string;
    url?: string;
    token: string;
    provider: DebridProvider;
    context?: StreamContext;
  }): Promise<string> {
    const { magnet, url, token, provider, context } = params;

    if (!token) {
      throw new Error('Debrid token is required for playback');
    }

    try {
      console.debug(`Processing link for playback via ${provider}`);

      if (provider === 'torbox') {
        const service = new TorboxService(token);
        if (url && !magnet) {
          const result = await service.processWebDlToDirectUrl(url, context);
          return result.url;
        }
        if (!magnet) throw new Error('Magnet is required for torrent playback');
        const result = await service.processMagnetToDirectUrl(magnet, context);
        return result.url;
      }

      // RealDebrid only supports torrents here
      if (!magnet) {
        throw new Error('Magnet is required for Real-Debrid playback');
      }
      const directUrl = await new RealDebridService(token).processMagnetToDirectUrl(magnet, context);
      return directUrl;
    } catch (error) {
      console.error(`Failed to process link for playback: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private extractStreamMagnet(stream: SourceStream): string | undefined {
    if (stream.magnet && stream.magnet.toLowerCase().startsWith('magnet:')) {
      return stream.magnet;
    }
    if (stream.url && stream.url.toLowerCase().startsWith('magnet:')) {
      return stream.url;
    }
    if (stream.infoHash) {
      const normalizedHash = stream.infoHash.trim().toLowerCase();
      if (normalizedHash) {
        return `magnet:?xt=urn:btih:${normalizedHash}`;
      }
    }
    return undefined;
  }

  private getStreamInfoHash(stream: SourceStream): string | undefined {
    if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
      return stream.infoHash.trim().toLowerCase();
    }

    const magnet = this.extractStreamMagnet(stream);
    if (!magnet) {
      return undefined;
    }

    const match = magnet.match(/xt=urn:btih:([^&]+)/i);
    if (!match?.[1]) {
      return undefined;
    }

    return match[1].trim().toLowerCase();
  }

  private async ensureDebridAvailability(
    streams: SourceStream[],
    provider?: DebridProvider,
    token?: string
  ): Promise<void> {
    const pendingHashes = new Map<string, SourceStream[]>();

    for (const stream of streams) {
      if (stream.cached !== undefined) {
        continue;
      }

      const hash = this.getStreamInfoHash(stream);
      if (!hash) {
        continue;
      }

      if (!pendingHashes.has(hash)) {
        pendingHashes.set(hash, []);
      }
      pendingHashes.get(hash)!.push(stream);
    }

    if (pendingHashes.size === 0) {
      return;
    }

    let cachedHashes = new Set<string>();
    let unknownHashes = new Set<string>();
    if (provider === 'torbox') {
      // Cada resposta vale assim que chega: um hash lento (ou numa consulta presa)
      // não apaga o selo dos que o TorBox já respondeu.
      ({ cached: cachedHashes, unknown: unknownHashes } = await TorboxService.checkCachedInfoHashes(
        [...pendingHashes.keys()],
        token,
        (hash, isCached) => {
          for (const stream of pendingHashes.get(hash) ?? []) stream.cached = isCached;
        }
      ));
    } else {
      const found = await RealDebridService.checkCachedInfoHashes([...pendingHashes.keys()], token);
      // Lista da conta sem resposta: os streams ficam sem resposta, não como "não cacheados"
      if (!found) return;
      cachedHashes = found;
    }

    for (const [hash, relatedStreams] of pendingHashes.entries()) {
      // Consulta com erro: fica sem resposta (undefined), não como "não cacheado"
      if (unknownHashes.has(hash)) continue;
      const isCached = cachedHashes.has(hash);
      for (const stream of relatedStreams) {
        stream.cached = isCached;
      }
    }
  }

  private buildResolveUrl(params: {
    base: string;
    token: string;
    magnet?: string;
    originalUrl?: string;
    context?: StreamContext;
    provider?: DebridProvider;
    linkType?: 'torrent' | 'webdl';
  }): string {
    const { token, magnet, originalUrl, context, provider, linkType } = params;
    const base = params.base.endsWith('/') ? params.base : `${params.base}/`;
    
    // Novo formato: /provider/token/resolve?magnet=...
    const url = new URL(`${provider}/${token}/resolve`, base);
    
    if (magnet) url.searchParams.set('magnet', magnet);
    if (originalUrl) url.searchParams.set('url', originalUrl);
    if (linkType) url.searchParams.set('linkType', linkType);

    const contextValue = StreamService.encodeStreamContext(context);
    if (contextValue) {
      url.searchParams.set('ctx', contextValue);
    }

    return url.toString();
  }
}
