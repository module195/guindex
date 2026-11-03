/**
 * Torrent Indexer Source Provider
 */

import { request } from 'undici';
import { BaseSourceProvider, type SourceFetchOptions } from './base-source-provider.js';
import { prefetchDebridAvailability } from './debrid-prefetch.js';
import type { SourceStream, StreamContext } from '../models/source-model.js';
import { TorrentParser } from './torrent-parser.js';
import { filenameLanguageTag } from './audio-language.js';
import type {
  CinemetaMeta,
  TorrentLike,
  IndexedTorrentFile,
  IndexerCapability,
  IndexerCatalog,
  MultiCall,
  SearchCacheEntry,
  LocalizedTitleCacheEntry,
  IndexerFailureState,
  IndexerPerformanceEntry,
  FallbackSearchOptions,
  MatchContext,
} from './torrent-indexer-shared.js';
import {
  parsePositiveInt,
  parseNonNegativeInt,
  parseCsvSet,
  parseBoolean,
  readEnv,
  MAX_STREAMS,
  MAX_TEXT_QUERIES,
  MAX_COLLECT_PER_SOURCE,
  WARM_EXTRA_QUERIES,
  REQUEST_BUDGET_MS,
  DEBRID_MARGIN_MS,
  META_BUDGET_MS,
  MAX_CACHE_QUERIES,
  CACHE_TIMEOUT_MS,
  MULTI_GRACE_MS,
  MULTI_GRACE_NO_4K_MS,
  markLateResultsPending,
  notifyLateResults,
  PHASE3_MIN_MS,
  PHASE3_MAX_QUERIES,
  IMDB_QUERY_REGEX,
  logReq,
} from './torrent-indexer-shared.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { selectBestFile } from './file-selection.js';
import { TorboxService } from './torbox-service.js';
import type { TorboxTorrent } from './torbox-client.js';
import { LIBRARY_INDEXER_LABEL } from './torbox-library.js';

export { logReq } from './torrent-indexer-shared.js';
const BACKGROUND_WARM_DELAY_MS = 2000;
// Tetos dos caches em memória (antes cresciam sem limite durante a vida do processo)
const CINEMETA_CACHE_MAX_ENTRIES = 2000;
const SEARCH_CACHE_MAX_ENTRIES = 1000;
const LOCALIZED_TITLE_CACHE_MAX_ENTRIES = 5000;

class GlobalIndexerQueue {
  private queue: Array<() => Promise<void>> = [];
  private readonly pending = new Set<string>();
  private activeWorkers = 0;
  private readonly delayMs: number;
  private readonly concurrency: number;
  private readonly maxSize: number;

  constructor() {
    this.delayMs = parseNonNegativeInt(process.env.TORRENT_INDEXER_GLOBAL_QUEUE_DELAY_MS, 1500);
    this.concurrency = parsePositiveInt(process.env.TORRENT_INDEXER_GLOBAL_QUEUE_CONCURRENCY, 1);
    this.maxSize = parsePositiveInt(process.env.TORRENT_INDEXER_GLOBAL_QUEUE_MAX, 200);
  }

  async add(task: () => Promise<void>, label: string, context?: MatchContext) {
    if (this.pending.has(label)) {
      logReq(context, `⏭️ [Fila Global] Já na fila, ignorando duplicata: ${label}`);
      return;
    }
    if (this.queue.length >= this.maxSize) {
      logReq(context, `🚫 [Fila Global] Fila cheia (${this.maxSize}); descartando: ${label}`);
      return;
    }
    this.pending.add(label);
    logReq(context, `📥 [Fila Global] Adicionado na fila: ${label}. Tamanho atual: ${this.queue.length + 1}`);
    this.queue.push(async () => {
      logReq(context, `⚙️ [Fila Global] Processando: ${label}`);
      try {
        await task();
      } catch (e) {
        console.error(`[GuIndex] ❌ [Fila Global] Erro ao processar ${label}:`, e);
      } finally {
        this.pending.delete(label);
      }
    });
    this.process();
  }

  private async process() {
    if (this.activeWorkers >= this.concurrency) return;
    this.activeWorkers++;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
        // Pequeno respiro configurável entre requisições para poupar a API
        if (this.delayMs > 0) {
          await new Promise(r => setTimeout(r, this.delayMs));
        }
      }
    }

    this.activeWorkers--;
    if (this.activeWorkers === 0 && this.queue.length === 0) {
      logReq(undefined, `✅ [Fila Global] Fila esvaziada! Servidor descansando.`);
    }
  }
}

const globalQueue = new GlobalIndexerQueue();
/** Biblioteca TorBox no /stream (itens da conta casados com o título). */
const LIBRARY_ENABLED = parseBoolean(readEnv('GUINDEX_TORBOX_LIBRARY'), true);
/** Espera máxima pela lista da conta depois que a busca termina */
// Folga além do PHASE3_MIN_MS ao cortar a espera do multi com o cache vazio,
// para a Fase 3 não ficar de fora por poucos ms.
const PHASE3_RESERVE_SLACK_MS = 100;
const LIBRARY_WAIT_MS = parseNonNegativeInt(readEnv('GUINDEX_TORBOX_LIBRARY_WAIT_MS'), 750);
/** Teto de streams novos vindos só da conta, por pedido */
const MAX_LIBRARY_STREAMS = 20;

/** Torrent da conta TorBox no formato de resultado do torrent-indexer. */
export function accountTorrentToTorrentLike(item: TorboxTorrent): TorrentLike {
  const hash = item.hash.toLowerCase();
  const name = item.name ?? hash;
  return {
    title: name,
    info_hash: hash,
    magnet_link: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`,
    size: item.size,
    files: (item.files ?? []).map((file) => ({
      path: file.name ?? file.short_name ?? '',
      size: file.size,
    })),
    indexer: 'torbox',
    indexerName: 'TorBox',
  };
}

export class TorrentIndexerProvider extends BaseSourceProvider {
  private readonly baseUrl: string;
  private readonly parser = new TorrentParser();

  /** Delegações mantidas para os testes e chamadores que usam o provider diretamente. */
  private isRelevantTorrent(torrent: TorrentLike, context: MatchContext): boolean {
    return this.parser.isRelevantTorrent(torrent, context);
  }

  private normalizeIndexerSlug(value: string): string {
    return this.parser.normalizeIndexerSlug(value);
  }

  /** In-memory Cinemeta cache (shared across instances) */
  private static cinemetaCache = new BoundedMap<string, { data: CinemetaMeta; ts: number }>(CINEMETA_CACHE_MAX_ENTRIES);
  private static readonly CINEMETA_TTL = 5 * 60 * 1000; // 5 min
  private static searchCache = new BoundedMap<string, SearchCacheEntry>(SEARCH_CACHE_MAX_ENTRIES);
  private static localizedTitleCache = new BoundedMap<string, LocalizedTitleCacheEntry>(LOCALIZED_TITLE_CACHE_MAX_ENTRIES);
  private static indexerNamesCache:
    | { ts: number; names: string[] }
    | undefined;
  /** Capacidades e saúde dos indexers, lidas de /sources?v=2 */
  private static indexerCatalogCache: IndexerCatalog | undefined;
  /** Consulta ao /sources em andamento: pedidos simultâneos esperam a mesma. */
  private static indexerCatalogInFlight: Promise<IndexerCatalog | undefined> | undefined;
  /** Última falha do /sources: até CATALOG_RETRY_MS depois dela, não tenta de novo. */
  private static indexerCatalogFailedAt = 0;
  private static readonly SEARCH_CACHE_TTL_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_SEARCH_CACHE_TTL_MS,
    120_000,
  );
  // Vale para o catálogo do /sources?v=2, que traz a saúde de cada indexer,
  // então fica curto (antes eram 10 min só para a lista de nomes).
  private static readonly INDEXER_NAMES_CACHE_TTL_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_INDEXERS_CACHE_TTL_MS,
    120_000,
  );
  // O /sources fica no caminho do multi: timeout curto, dentro do orçamento.
  private static readonly CATALOG_TIMEOUT_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_SOURCES_TIMEOUT_MS,
    1500,
  );
  private static readonly CATALOG_RETRY_MS = 10_000;
  private static readonly LOCALIZED_TITLE_CACHE_TTL_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_LOCALIZED_TITLE_CACHE_TTL_MS,
    7 * 24 * 60 * 60 * 1000,
  );
  // Falha do TMDB (timeout, rede, 429, 5xx) fica pouco tempo em cache: só o
  // bastante para não martelar a API, sem perder os títulos PT-BR por dias.
  private static readonly LOCALIZED_TITLE_FAILURE_TTL_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_LOCALIZED_TITLE_FAILURE_TTL_MS,
    5 * 60 * 1000,
  );
  private static readonly TMDB_TIMEOUT_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_TMDB_TIMEOUT_MS,
    5000,
  );
  private static readonly TMDB_API_READ_ACCESS_TOKEN = readEnv(
    'TMDB_API_READ_ACCESS_TOKEN',
    'TMDB_READ_ACCESS_TOKEN',
  );
  private static readonly TMDB_API_KEY = readEnv('TMDB_API_KEY');
  private static readonly ENABLE_FALLBACK_INDEXER_SEARCH = parseBoolean(
    process.env.TORRENT_INDEXER_ENABLE_FALLBACK,
    true,
  );
  private static readonly FALLBACK_MAX_INDEXERS = parseNonNegativeInt(
    process.env.TORRENT_INDEXER_FALLBACK_MAX_INDEXERS,
    0,
  );
  private static readonly FALLBACK_PER_INDEXER_LIMIT = parsePositiveInt(
    process.env.TORRENT_INDEXER_FALLBACK_PER_INDEXER_LIMIT,
    0,
  );
  private static readonly FALLBACK_INDEXER_CONCURRENCY = parsePositiveInt(
    process.env.TORRENT_INDEXER_FALLBACK_CONCURRENCY,
    5,
  );
  private static readonly FALLBACK_REQUEST_TIMEOUT_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_FALLBACK_TIMEOUT_MS,
    12000,
  );
  private static readonly HYBRID_MIN_RESULTS = parsePositiveInt(
    process.env.TORRENT_INDEXER_HYBRID_MIN_RESULTS,
    2,
  );
  private static readonly HYBRID_MIN_INDEXERS = parsePositiveInt(
    process.env.TORRENT_INDEXER_HYBRID_MIN_INDEXERS,
    2,
  );
  private static readonly DISABLED_INDEXERS = parseCsvSet(
    readEnv('TORRENT_INDEXER_DISABLED_INDEXERS'),
    [],
  );
  private static readonly INDEXER_FAILURE_THRESHOLD = parsePositiveInt(
    readEnv('TORRENT_INDEXER_FAILURE_THRESHOLD', 'TORRENT_INDEXER_INDEXER_FAILURE_THRESHOLD'),
    2,
  );
  private static readonly INDEXER_FAILURE_COOLDOWN_MS = parsePositiveInt(
    readEnv('TORRENT_INDEXER_FAILURE_COOLDOWN_MS', 'TORRENT_INDEXER_INDEXER_FAILURE_COOLDOWN_MS'),
    // igual ao healthRetryAfter do torrent-indexer: os dois cooldowns ficam em
    // série, e um maior aqui escondia a volta que o servidor já liberou
    300_000,
  );
  private static readonly indexerPerformance = new Map<string, IndexerPerformanceEntry>();
  private static readonly indexerFailureState = new Map<string, IndexerFailureState>();

  constructor(name: string, baseUrl: string) {
    super(name);
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getStreams(
    type: string,
    id: string,
    options?: SourceFetchOptions
  ): Promise<SourceStream[]> {
    const startedAt = Date.now();
    const forceFresh = options?.forceFresh === true;
    const parsed = this.parser.parseId(id);
    const metaLookupId = parsed.imdbId ?? parsed.query ?? (id || '').split(':')[0] ?? id;
    // As consultas seguem abertas depois do META_BUDGET: se os títulos não
    // chegarem a tempo, a busca sai só por IMDb e o filtro de título é refeito
    // quando eles chegarem, dentro do prazo (lateTitles, no fim da busca).
    const metaPromise = this.fetchCinemetaMeta(type, metaLookupId, forceFresh).catch(() => undefined);
    const localizedPromise = parsed.imdbId
      ? this.fetchLocalizedTitleCandidates(parsed.imdbId, forceFresh).catch(() => [] as string[])
      : Promise.resolve<string[]>([]);
    const [meta, localizedTitlesRaw] = await Promise.all([
      this.awaitWithin(metaPromise, META_BUDGET_MS, undefined),
      this.awaitWithin(localizedPromise, META_BUDGET_MS, [] as string[]),
    ]);
    let displayTitles = this.parser.collectMetaTitles(meta);
    
    let localizedTitles: string[] = [];
    if (parsed.imdbId) {
      localizedTitles = localizedTitlesRaw;
      
      if (type === 'series') {
        // Evita chamada duplicada ao Cinemeta quando o lookup acima já foi o mesmo
        const fallback = metaLookupId === parsed.imdbId
          ? meta
          : await this.awaitWithin(
              this.fetchCinemetaMeta('series', parsed.imdbId, forceFresh),
              Math.max(0, startedAt + META_BUDGET_MS - Date.now()),
              undefined,
            );
        if (fallback?.name) displayTitles.push(fallback.name);
        if (fallback?.aliases) displayTitles.push(...fallback.aliases);
      }

      for (let i = localizedTitles.length - 1; i >= 0; i--) {
        const title = localizedTitles[i];
        if (title) {
          const existingIdx = displayTitles.indexOf(title);
          if (existingIdx !== -1) {
            displayTitles.splice(existingIdx, 1);
          }
          displayTitles.unshift(title);
        }
      }
    }

    displayTitles = [...new Set(displayTitles)];

    if (parsed.query && !displayTitles.includes(parsed.query)) {
      displayTitles.push(parsed.query);
    }

    const targetTitle = displayTitles[0];
    const releaseYear = this.parser.extractReleaseYear(meta);
    const runtimeSeconds = this.parser.extractRuntimeSeconds(meta);
    const episodeTitle =
      parsed.season !== undefined && parsed.episode !== undefined
        ? this.parser.findEpisodeTitle(meta, parsed.season, parsed.episode)
        : undefined;

    const imdbQuery = parsed.imdbId;
    const textQuery = this.parser.buildTextQuery(type, parsed, targetTitle, releaseYear, episodeTitle);
    const textQueries = this.parser.buildTextQueryCandidates(type, parsed, displayTitles, releaseYear, episodeTitle);

    // Sempre construir as 3 queries otimizadas para o mid-path (Fase 2)
    const midPathQueries: string[] = [];
    if (imdbQuery) midPathQueries.push(imdbQuery);
    if (targetTitle) midPathQueries.push(targetTitle);
    
    const ptTitle = (localizedTitles || []).find(t => t && t !== targetTitle);
    if (ptTitle) midPathQueries.push(ptTitle);

    // Construir queries completas para Meilisearch (Fase 1) e slow-path (Fase 3)
    const queries: string[] = [];
    if (forceFresh) {
      queries.push(...midPathQueries);
      logReq(undefined, `🔍 Modo Mid-Patch (Bulk): Queries otimizadas: ${queries.join(' | ')}`);
    } else {
      queries.push(...midPathQueries);
      if (type.toLowerCase() !== 'movie' && parsed.season !== undefined && targetTitle) {
        const sPad = String(parsed.season).padStart(2, '0');
        const eCode = parsed.episode !== undefined ? `E${String(parsed.episode).padStart(2, '0')}` : '';
        const epQuery = `${targetTitle} S${sPad}${eCode}`;
        if (!queries.includes(epQuery)) queries.push(epQuery);
      }
      if (textQuery && !queries.includes(textQuery)) queries.push(textQuery);
      for (const q of textQueries) {
        if (!queries.includes(q)) queries.push(q);
      }
    }

    if (queries.length === 0) return [];

    // Biblioteca TorBox: a lista da conta sai já, em paralelo com a busca
    const libraryPromise = this.startAccountLibrary(options);

    const reqId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const context: MatchContext = {
      parsed,
      type,
      targetTitles: displayTitles,
      reqId,
      logName: targetTitle || queries[0] || id,
      releaseYear,
      episodeTitle,
      runtimeSeconds
    };

    const seen = new Set<string>();
    const sourceCounts = new Map<string, number>();

    const uniqueQueries = [...new Set(queries.filter(q => q.trim().length > 0))];
    logReq(context, `🚀 Iniciando busca multi-query (Bulk) para: [${uniqueQueries.join(', ')}]`);

    const fallbackTitle = targetTitle || queries[0] || id;
    // Prazo da busca inteira, contado desde a chegada do pedido (Cinemeta/TMDB
    // incluídos), descontada a margem da consulta de cache do debrid.
    const searchDeadlineAt = startedAt + REQUEST_BUDGET_MS - DEBRID_MARGIN_MS;
    const remainingMs = () => searchDeadlineAt - Date.now();

    // ═══════════════════════════════════════════════════════
    // FASE 1 — Cache (Meilisearch) + ping no /indexers/multi
    //   O multi sai junto com o cache: busca em tempo real, pode achar o que
    //   o cache ainda não tem, e o que ele raspa vai para o Meilisearch.
    // ═══════════════════════════════════════════════════════
    const multiPromise = this.startMultiSearch(midPathQueries, remainingMs(), context);
    const cacheTorrents = await this.fetchBulkMeilisearchResults(
      uniqueQueries.slice(0, MAX_CACHE_QUERIES),
      Math.min(CACHE_TIMEOUT_MS, Math.max(500, remainingMs())),
      type.toLowerCase() === 'movie' ? undefined : { season: parsed.season, episode: parsed.episode },
    );
    const fetchedTorrents: TorrentLike[] = [...cacheTorrents];
    const cacheSufficient = this.hasSufficientResults(cacheTorrents, fallbackTitle, context);
    const streams = this.collectStreamsFromTorrents(cacheTorrents, fallbackTitle, context, seen, sourceCounts, 150);
    const cacheHas4K = streams.some((stream) => stream.quality === '4K');
    // O que o cache já trouxe vai para a checagem do debrid enquanto o multi roda
    prefetchDebridAvailability(streams, options);

    // ═══════════════════════════════════════════════════════
    // FASE 2 — Multi
    //   Cache suficiente: espera o multi só por uma janela curta (mais longa
    //   quando o cache não tem 4K) e junta o que já voltou; o resto segue no
    //   servidor e alimenta o cache. Cache fraco: espera o multi até o prazo.
    // ═══════════════════════════════════════════════════════
    const graceMs = cacheHas4K ? MULTI_GRACE_MS : MULTI_GRACE_NO_4K_MS;
    // Cache vazio: a espera pelo multi para antes do fim e deixa o tempo da
    // Fase 3, que roda junto com o multi ainda aberto. Esperar o multi até o
    // prazo deixava só a folga dele (~1 s), menos que o PHASE3_MIN_MS.
    const multiWaitMs = cacheSufficient && !forceFresh
      ? Math.min(graceMs, Math.max(0, remainingMs()))
      : streams.length === 0
        ? Math.max(0, remainingMs() - PHASE3_MIN_MS - PHASE3_RESERVE_SLACK_MS)
        : Math.max(0, remainingMs());
    let multiResults = await this.awaitWithin(multiPromise, multiWaitMs, undefined);
    logReq(
      context,
      `📦 [Fase 1] cache: ${cacheTorrents.length} torrents (${cacheSufficient ? 'suficiente' : 'fraco'}` +
        `${cacheHas4K ? ', com 4K' : ', sem 4K'}); ` +
        `[Fase 2] multi: ${multiResults === undefined ? 'sem resposta no prazo' : `${multiResults.length} torrents`}`,
    );

    const addMultiResults = (results: TorrentLike[]) => {
      fetchedTorrents.push(...results);
      streams.push(
        ...this.collectStreamsFromTorrents(
          results,
          fallbackTitle,
          context,
          seen,
          sourceCounts,
          Math.max(0, 150 - streams.length),
        ),
      );
    };
    if (multiResults) addMultiResults(multiResults);

    // ═══════════════════════════════════════════════════════
    // FASE 3 — Indexers com melhor desempenho (como no original)
    //   Só quando cache e multi não trouxeram nada e ainda há tempo. Se o multi
    //   respondeu, tenta as queries de texto que ele não cobriu; se não
    //   respondeu, repete também as do mid-path.
    // ═══════════════════════════════════════════════════════
    if (streams.length === 0 && remainingMs() >= PHASE3_MIN_MS) {
      const extraQueries = textQueries.filter((q) => q && !midPathQueries.includes(q));
      const phase3Queries = (multiResults === undefined
        ? [...midPathQueries, ...extraQueries]
        : extraQueries
      ).slice(0, PHASE3_MAX_QUERIES);
      if (phase3Queries.length > 0) {
        const [phase3Results, lateMulti] = await Promise.all([
          this.fetchFastestIndexersSearch(phase3Queries, remainingMs(), context),
          multiResults === undefined
            ? this.awaitWithin(multiPromise, Math.max(0, remainingMs()), undefined)
            : Promise.resolve(undefined),
        ]);
        if (lateMulti) {
          multiResults = lateMulti;
          addMultiResults(lateMulti);
        }
        fetchedTorrents.push(...phase3Results);
        streams.push(
          ...this.collectStreamsFromTorrents(phase3Results, fallbackTitle, context, seen, sourceCounts, 150),
        );
      }
    }
    if (multiResults === undefined) {
      this.watchLateMultiResults(multiPromise, type, id, fallbackTitle, context, seen, cacheTorrents);
    }

    // Títulos atrasados: a busca saiu sem eles (só por IMDb) e o filtro
    // descartou todo torrent sem IMDb. Chegando ainda no prazo, o filtro é
    // refeito sobre o que já voltou, sem nova consulta.
    if (parsed.imdbId && displayTitles.length === 0 && remainingMs() > 0) {
      const late = await this.awaitWithin(
        Promise.all([metaPromise, localizedPromise]),
        // Com streams já na mão (torrents com IMDb), espera só mais um META_BUDGET:
        // o Cinemeta fora do ar não pode empurrar toda resposta até o prazo.
        streams.length === 0 ? Math.max(0, remainingMs()) : Math.min(META_BUDGET_MS, Math.max(0, remainingMs())),
        undefined,
      );
      const lateTitles = late
        ? [...new Set([...(late[1] ?? []), ...this.parser.collectMetaTitles(late[0])])].filter(Boolean)
        : [];
      if (late && lateTitles.length > 0) {
        context.targetTitles = lateTitles;
        context.releaseYear = this.parser.extractReleaseYear(late[0]);
        const before = streams.length;
        streams.push(
          ...this.collectStreamsFromTorrents(
            fetchedTorrents,
            fallbackTitle,
            context,
            seen,
            sourceCounts,
            Math.max(0, 150 - streams.length),
          ),
        );
        logReq(
          context,
          `🕒 Títulos chegaram depois do META_BUDGET (${Date.now() - startedAt}ms); ` +
            `filtro refeito: +${streams.length - before} streams`,
        );
      }
    }

    // Aquecimento opcional de queries extras em background
    if (!forceFresh && WARM_EXTRA_QUERIES > 0) {
      const remainingQueries = textQueries
        .filter((q) => q && !midPathQueries.includes(q))
        .slice(0, Math.min(WARM_EXTRA_QUERIES, MAX_TEXT_QUERIES));
      if (remainingQueries.length > 0) {
        this.warmRemainingQueriesInBackground(remainingQueries, context);
      }
    }

    if (libraryPromise) {
      // A lista saiu junto com a busca; terminada a busca, espera por ela só uma
      // janela curta (dentro do prazo). Sem resposta, ela termina em segundo plano
      // e fica no cache da conta para o próximo pedido.
      const libraryWaitMs = Math.min(LIBRARY_WAIT_MS, Math.max(0, remainingMs()));
      const libraryItems = await this.awaitWithin(libraryPromise, libraryWaitMs, undefined);
      if (libraryItems === undefined) {
        logReq(context, `🗃️ Biblioteca TorBox sem resposta no prazo; fica para o próximo pedido`);
      } else {
        streams.push(...this.mergeAccountLibrary(libraryItems, streams, fallbackTitle, context, seen, sourceCounts));
      }
    }

    if (streams.length === 0) {
      logReq(context, `⚠️ Nenhum resultado encontrado para '${id}' após todas as fases (${Date.now() - startedAt}ms).`);
      return [];
    }

    // A checagem de cache no debrid fica com o StreamController; a SourceService
    // a começa assim que esta fonte responde. Esperar por ela aqui fazia o
    // provedor passar do timeout da SourceService com o TorBox lento.
    logReq(context, `✅ Retornando ${streams.length} streams para '${id}' em ${Date.now() - startedAt}ms`);
    return streams;
  }

  /**
   * O multi passou da janela e a resposta saiu sem ele. Quando ele terminar, se
   * trouxe stream que a resposta não tinha (o 4K raspado em tempo real, por
   * exemplo), avisa o cache do /stream para não servir a versão antiga. O que
   * o cache (Fase 1) já tinha e os tetos cortaram não conta: a busca seguinte o
   * cortaria de novo. Enquanto o multi não termina, a resposta do título não fica
   * no cache do cliente.
   */
  private watchLateMultiResults(
    multiPromise: Promise<TorrentLike[] | undefined>,
    type: string,
    id: string,
    fallbackTitle: string,
    context: MatchContext,
    delivered: Set<string>,
    cacheTorrents: TorrentLike[],
  ): void {
    const stopPending = markLateResultsPending(type, id);
    void multiPromise
      .then((late) => {
        if (!late || late.length === 0) return;
        // Só o que a Fase 1 aceitou: uma cópia do cache recusada (ano ou imdb
        // errado, sem magnet) não impede a cópia certa que o multi trouxe.
        const inCache = new Set(
          cacheTorrents
            .filter((torrent) => this.parser.isRelevantTorrent(torrent, context) && this.mapTorrentToStream(torrent, fallbackTitle, context))
            .map((torrent) => this.parser.getTorrentDedupKey(torrent)),
        );
        const unseen = late.filter((torrent) => {
          const key = this.parser.getTorrentDedupKey(torrent);
          return !key || !inCache.has(key);
        });
        const fresh = this.collectStreamsFromTorrents(unseen, fallbackTitle, context, new Set(delivered), new Map(), 150);
        if (fresh.length === 0) return;
        const has4K = fresh.some((stream) => stream.quality === '4K');
        logReq(
          context,
          `🕒 Multi chegou depois da resposta com ${fresh.length} streams novos${has4K ? ' (com 4K)' : ''}; ` +
            'o próximo pedido busca de novo',
        );
        const hashes = fresh.map((stream) => this.parser.getStreamInfoHash(stream));
        notifyLateResults(type, id, hashes.every(Boolean) ? (hashes as string[]) : undefined);
      })
      .catch(() => undefined)
      .finally(stopPending);
  }

  /**
   * Dispara o /indexers/multi com as queries do mid-path. Resolve undefined
   * quando o torrent-indexer não tem o multi, falhou ou não há indexer.
   */
  private async startMultiSearch(
    queries: string[],
    budgetMs: number,
    context?: MatchContext,
  ): Promise<TorrentLike[] | undefined> {
    if (!TorrentIndexerProvider.ENABLE_FALLBACK_INDEXER_SEARCH || queries.length === 0) return undefined;
    const startedAt = Date.now();
    const topQueries = queries.slice(0, 3);
    const catalog = await this.fetchIndexerCatalog();
    if (catalog?.multi === false) return undefined;
    // Sem catálogo (/sources fora do ar), o multi vai sem a lista: o servidor
    // usa os indexers ativos dele. Antes, a busca ao vivo nem saía.
    const indexers = catalog
      ? (await this.fetchIndexerNames(false)).filter((name) => topQueries.some((q) => this.indexerSupportsQuery(name, q)))
      : [];
    if (catalog && indexers.length === 0) return undefined;
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) return undefined;
    return this.fetchMultiIndexerSearch(topQueries, indexers, remaining, context);
  }

  /**
   * Chamadas por indexer só nos mais rápidos pelo histórico local, cortadas no
   * orçamento (o que voltou até lá é aproveitado).
   */
  private async fetchFastestIndexersSearch(
    queries: string[],
    budgetMs: number,
    context?: MatchContext,
  ): Promise<TorrentLike[]> {
    if (!TorrentIndexerProvider.ENABLE_FALLBACK_INDEXER_SEARCH || queries.length === 0) return [];
    const indexers = (await this.fetchIndexerNames(false))
      .filter((name) => queries.some((q) => this.indexerSupportsQuery(name, q)));
    if (indexers.length === 0) return [];

    const candidates = this.pickFastestIndexers(indexers);
    logReq(context, `🏎️ [Fase 3] [${queries.join(', ')}] em [${candidates.join(',')}] (orçamento: ${budgetMs}ms)`);

    const partial: TorrentLike[] = [];
    const search = this.fetchSearchResultsFromCandidates(queries, candidates, context, partial);
    const results = await this.awaitWithin(search, budgetMs, undefined);
    return results ?? this.parser.rankTorrentsByQuery([...partial], queries[0] ?? '');
  }

  /** Até 4 indexers com média abaixo de 1,3x a média geral; sem histórico, os 6 primeiros. */
  private pickFastestIndexers(indexers: string[]): string[] {
    const avgTimes = Array.from(TorrentIndexerProvider.indexerPerformance.values())
      .map((s) => s.avgMs)
      .filter((ms) => ms > 0);
    const overallAvg = avgTimes.length > 0
      ? avgTimes.reduce((a, b) => a + b, 0) / avgTimes.length
      : 500;
    const maxAllowedMs = overallAvg * 1.3;

    const selected = indexers
      .filter((name) => {
        const perf = TorrentIndexerProvider.indexerPerformance.get(this.parser.normalizeIndexerSlug(name));
        if (!perf || perf.avgMs === 0) return true;
        return perf.avgMs <= maxAllowedMs;
      })
      .slice(0, 4);
    return selected.length > 0 ? selected : indexers.slice(0, 6);
  }

  /** Espera a promise por até ms; depois disso devolve fallback (a promise segue rodando). */
  private async awaitWithin<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
    if (ms <= 0) return fallback;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<F>((resolve) => {
      handle = setTimeout(() => resolve(fallback), ms);
    });
    try {
      return await Promise.race([promise, timer]);
    } finally {
      if (handle) clearTimeout(handle);
    }
  }

  private collectStreamsFromTorrents(
    torrents: TorrentLike[],
    fallbackTitle: string,
    context: MatchContext,
    seen: Set<string>,
    sourceCounts: Map<string, number>,
    maxStreams: number,
  ): SourceStream[] {
    const streams: SourceStream[] = [];
    if (maxStreams <= 0) return streams;

    for (const torrent of torrents) {
      if (!this.parser.isRelevantTorrent(torrent, context)) continue;
      const stream = this.mapTorrentToStream(torrent, fallbackTitle, context);
      if (!stream) continue;

      const dedupeKey = this.parser.getDedupeKey(stream);
      if (dedupeKey && seen.has(dedupeKey)) continue;

      const sourceKey = (stream.source ?? 'unknown').toLowerCase();
      const sourceCount = sourceCounts.get(sourceKey) ?? 0;
      // O teto por fonte não corta a primeira ocorrência de cada qualidade: um
      // dump cheio de 1080p não pode esconder o único 4K da mesma fonte.
      const qualityKey = `${sourceKey}|${stream.quality ?? 'unknown'}`;
      const firstOfQuality = !sourceCounts.has(qualityKey);
      if (sourceCount >= MAX_COLLECT_PER_SOURCE && !firstOfQuality) continue;

      streams.push(stream);
      sourceCounts.set(sourceKey, sourceCount + 1);
      sourceCounts.set(qualityKey, (sourceCounts.get(qualityKey) ?? 0) + 1);
      if (dedupeKey) seen.add(dedupeKey);

      if (streams.length >= maxStreams) break;
    }

    return streams;
  }

  /** Lista da conta TorBox quando o pedido tem token TorBox e a biblioteca está ligada. */
  private startAccountLibrary(options?: SourceFetchOptions): Promise<TorboxTorrent[]> | undefined {
    if (!LIBRARY_ENABLED || options?.debridProvider !== 'torbox' || !options.torboxToken) return undefined;
    return TorboxService.accountLibrary(options.torboxToken).catch((error) => {
      console.warn(
        `[TorrentIndexer] 🗃️ Falha ao listar a biblioteca TorBox: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });
  }

  /**
   * Junta a biblioteca TorBox aos streams da busca. Hash que a busca já trouxe
   * ganha o selo de cacheado e "na conta"; torrent da conta que casa com o título
   * e a busca não achou vira stream novo, pelo mesmo filtro e montagem dos
   * resultados do indexer. O play reaproveita o torrent da conta (sem createtorrent).
   */
  private mergeAccountLibrary(
    items: TorboxTorrent[],
    streams: SourceStream[],
    fallbackTitle: string,
    context: MatchContext,
    seen: Set<string>,
    sourceCounts: Map<string, number>,
  ): SourceStream[] {
    if (items.length === 0) return [];
    const libraryHashes = new Set(items.map((item) => item.hash.toLowerCase()));
    const foundHashes = new Set<string>();
    let marked = 0;
    for (const stream of streams) {
      const hash = stream.infoHash?.toLowerCase();
      if (!hash) continue;
      foundHashes.add(hash);
      if (libraryHashes.has(hash)) {
        stream.cached = true;
        stream.inLibrary = true;
        marked++;
      }
    }

    const candidates = items
      .filter((item) => !foundHashes.has(item.hash.toLowerCase()))
      .map((item) => accountTorrentToTorrentLike(item));
    const added = this.collectStreamsFromTorrents(
      candidates,
      fallbackTitle,
      context,
      seen,
      sourceCounts,
      MAX_LIBRARY_STREAMS,
    );
    for (const stream of added) {
      stream.cached = true;
      stream.inLibrary = true;
      // Só veio da conta: no AIOStreams o indexer aparece como o Library dele
      stream.indexerLabel = LIBRARY_INDEXER_LABEL;
    }
    if (marked > 0 || added.length > 0) {
      logReq(
        context,
        `🗃️ Biblioteca TorBox: ${items.length} itens na conta; ${marked} já vindos da busca, ${added.length} novos`,
      );
    }
    return added;
  }

  private hasSufficientResults(results: TorrentLike[], query: string, context: MatchContext): boolean {
    if (results.length === 0) return false;
    
    const relevantResults = results.filter(r => this.parser.isRelevantTorrent(r, context));
    
    if (relevantResults.length < TorrentIndexerProvider.HYBRID_MIN_RESULTS) return false;
    
    const uniqueIndexers = this.collectIndexerSlugs(relevantResults);
    const isSufficient = uniqueIndexers.size >= TorrentIndexerProvider.HYBRID_MIN_INDEXERS;
    if (isSufficient) {
      logReq(context, `⚡ Fast-path aprovou '${query}': ${relevantResults.length} resultados válidos em ${uniqueIndexers.size} indexadores.`);
    }
    return isSufficient;
  }

  private warmRemainingQueriesInBackground(queries: string[], context: MatchContext): void {
    if (queries.length === 0) return;

    logReq(context, `🔍 Enviando ${queries.length} queries para a Fila Global de raspagem em background.`);
    
    for (const query of queries) {
      if (!query) continue;
      
      globalQueue.add(async () => {
        const now = Date.now();
        const isFresh = (key: string) => {
          const entry = TorrentIndexerProvider.searchCache.get(key);
          return !!entry && now - entry.ts < TorrentIndexerProvider.SEARCH_CACHE_TTL_MS;
        };
        if (isFresh(this.getSearchCacheKey(query)) || isFresh(this.getSlowPathCacheKey(query))) {
          return;
        }

        await this.fetchSearchResultsFromIndexers(query, undefined, context);
      }, `Raspagem Restante '${query}'`, context);
    }
  }

  

  private async fetchSearchResultsFromIndexers(
    query: string,
    options?: FallbackSearchOptions,
    context?: MatchContext,
  ): Promise<TorrentLike[]> {
    if (!TorrentIndexerProvider.ENABLE_FALLBACK_INDEXER_SEARCH) {
      return [];
    }

    const indexers = await this.fetchIndexerNames();
    if (indexers.length === 0) {
      return [];
    }

    const configuredMax = TorrentIndexerProvider.FALLBACK_MAX_INDEXERS;
    const defaultMaxIndexers = configuredMax > 0
      ? Math.min(configuredMax, indexers.length)
      : indexers.length;
    const maxIndexers = options?.maxIndexers ?? defaultMaxIndexers;
    const perIndexerLimit =
      options?.perIndexerLimit ?? TorrentIndexerProvider.FALLBACK_PER_INDEXER_LIMIT;
    const excluded = options?.excludeIndexers;

    const selected = indexers
      .filter((name) => {
        if (this.shouldSkipIndexer(name) || !this.indexerSupportsQuery(name, query)) {
          return false;
        }
        if (!excluded || excluded.size === 0) {
          return true;
        }
        const normalized = this.parser.normalizeIndexerSlug(name);
        return !excluded.has(normalized);
      })
      .sort((a, b) => this.compareIndexerPriority(a, b))
      .slice(0, maxIndexers);

    if (selected.length === 0) {
      return [];
    }

    logReq(context, `🐢 Slow-path iniciado: Buscando '${query}' ao vivo em ${selected.length} indexadores.`);

    const settled: PromiseSettledResult<TorrentLike[]>[] = [];
    for (let i = 0; i < selected.length; i += TorrentIndexerProvider.FALLBACK_INDEXER_CONCURRENCY) {
      const batch = selected.slice(i, i + TorrentIndexerProvider.FALLBACK_INDEXER_CONCURRENCY);
      const batchSettled = await Promise.allSettled(
        batch.map((name) =>
          this.fetchSingleIndexerSearch(
            name,
            query,
          ),
        ),
      );
      settled.push(...batchSettled);
    }

    const merged: TorrentLike[] = [];
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value.length > 0) {
        merged.push(...item.value);
      }
    }

    const ranked = this.parser.rankTorrentsByQuery(merged, query);
    if (ranked.length > 0) {
      TorrentIndexerProvider.searchCache.set(this.getSlowPathCacheKey(query), { ts: Date.now(), data: ranked });
    }
    return ranked;
  }

  /**
   * Nomes dos indexers ativos, na ordem de prioridade. Com includeUnhealthy
   * false (caminho síncrono), pula os que o /sources?v=2 marca healthy:false.
   * O aquecimento em background continua chamando esses, senão o torrent-indexer
   * nunca mais veria uma chamada deles e eles não voltariam a ficar saudáveis.
   */
  private async fetchIndexerNames(includeUnhealthy = true): Promise<string[]> {
    const catalog = await this.fetchIndexerCatalog();
    if (!catalog) {
      return [];
    }

    const names = catalog.indexers
      .filter((c) => includeUnhealthy || c.healthy)
      .map((c) => c.name)
      .filter((name) => !this.shouldSkipIndexer(name));
    return names.sort((a, b) => this.compareIndexerPriority(a, b));
  }

  /**
   * Lê capacidades e saúde de /sources?v=2. Um torrent-indexer antigo ignora o
   * v=2 e responde só indexer_names: aí as capacidades ficam desconhecidas e
   * o /indexers/multi não é usado. Em erro, devolve o último catálogo lido.
   */
  /**
   * Catálogo do /sources?v=2. Vencido, sai o antigo na hora e a atualização
   * corre em segundo plano; sem nenhum, espera uma consulta só, compartilhada
   * pelos pedidos simultâneos. Depois de uma falha, fica CATALOG_RETRY_MS sem
   * tentar de novo, para um torrent-indexer fora do ar não custar um timeout
   * a cada pedido.
   */
  private async fetchIndexerCatalog(): Promise<IndexerCatalog | undefined> {
    const cached = TorrentIndexerProvider.indexerCatalogCache;
    const now = Date.now();
    if (cached && cached.indexers.length > 0) {
      if (now - cached.ts >= TorrentIndexerProvider.INDEXER_NAMES_CACHE_TTL_MS) {
        void this.refreshIndexerCatalog();
      }
      return cached;
    }
    return this.refreshIndexerCatalog();
  }

  private refreshIndexerCatalog(): Promise<IndexerCatalog | undefined> {
    const inFlight = TorrentIndexerProvider.indexerCatalogInFlight;
    if (inFlight) return inFlight;
    const cached = TorrentIndexerProvider.indexerCatalogCache;
    if (Date.now() - TorrentIndexerProvider.indexerCatalogFailedAt < TorrentIndexerProvider.CATALOG_RETRY_MS) {
      return Promise.resolve(cached);
    }
    const pending = this.requestIndexerCatalog()
      .then((catalog) => {
        if (!catalog) {
          TorrentIndexerProvider.indexerCatalogFailedAt = Date.now();
          return TorrentIndexerProvider.indexerCatalogCache;
        }
        TorrentIndexerProvider.indexerCatalogFailedAt = 0;
        TorrentIndexerProvider.indexerCatalogCache = catalog;
        // getDomainToIndexerMap usa os nomes para reconhecer o indexer pelo domínio
        TorrentIndexerProvider.indexerNamesCache = {
          ts: catalog.ts,
          names: catalog.indexers.map((c) => c.name),
        };
        return catalog;
      })
      .finally(() => {
        TorrentIndexerProvider.indexerCatalogInFlight = undefined;
      });
    TorrentIndexerProvider.indexerCatalogInFlight = pending;
    return pending;
  }

  /** Uma consulta ao /sources?v=2; undefined em erro, timeout ou catálogo vazio. */
  private async requestIndexerCatalog(): Promise<IndexerCatalog | undefined> {
    try {
      const response = await request(`${this.baseUrl}/sources?v=2`, {
        signal: AbortSignal.timeout(TorrentIndexerProvider.CATALOG_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        console.warn(`[GuIndex] ⚠️ /sources?v=2 respondeu HTTP ${response.statusCode}`);
        return undefined;
      }
      const payload = (await response.body.json()) as Record<string, unknown>;
      const catalog = this.parser.parseIndexerCatalog(payload);
      return catalog && catalog.indexers.length > 0 ? catalog : undefined;
    } catch (error) {
      console.warn(`[GuIndex] ⚠️ /sources?v=2 falhou: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private getIndexerCapability(indexerName: string): IndexerCapability | undefined {
    const slug = this.parser.normalizeIndexerSlug(indexerName);
    return TorrentIndexerProvider.indexerCatalogCache?.indexers.find(
      (c) => this.parser.normalizeIndexerSlug(c.name) === slug,
    );
  }

  /** false só quando o /sources?v=2 diz que o indexer não aceita esse tipo de query */
  private indexerSupportsQuery(indexerName: string, query: string): boolean {
    const capability = this.getIndexerCapability(indexerName);
    if (!capability) {
      return true;
    }
    return IMDB_QUERY_REGEX.test(query.trim())
      ? capability.supportsImdb !== false
      : capability.supportsText !== false;
  }

  private getSearchCacheKey(query: string): string {
    return `${this.baseUrl}|${query.trim().toLowerCase()}`;
  }

  private getSlowPathCacheKey(query: string): string {
    return `slow|${this.getSearchCacheKey(query)}`;
  }

  /**
   * Uma chamada /search por query, em paralelo: o /search do torrent-indexer
   * lê só o primeiro q, então várias q numa chamada só pesquisavam o IMDb.
   * Na query de IMDb de série vão season/episode: o IMDb traz todas as
   * temporadas e o servidor filtra antes do limit, então o episódio pedido
   * não fica de fora numa série com centenas de torrents.
   */
  private async fetchBulkMeilisearchResults(
    queries: string[],
    timeoutMs = 8000,
    seriesTarget?: { season?: number; episode?: number },
  ): Promise<TorrentLike[]> {
    const uniqueQueries = [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 0))];
    if (uniqueQueries.length === 0) return [];

    const settled = await Promise.all(
      uniqueQueries.map(async (q) => {
        const url = new URL(`${this.baseUrl}/search`);
        url.searchParams.set('q', q);
        url.searchParams.set('limit', '200');
        if (seriesTarget?.season !== undefined && IMDB_QUERY_REGEX.test(q)) {
          url.searchParams.set('season', String(seriesTarget.season));
          if (seriesTarget.episode !== undefined) url.searchParams.set('episode', String(seriesTarget.episode));
        }
        try {
          const response = await request(url.toString(), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.statusCode >= 400) {
            await response.body.dump().catch(() => undefined);
            return [];
          }
          return this.parser.normalizeTorrentPayload(await response.body.json());
        } catch {
          return [];
        }
      }),
    );

    // Em ordem de query (IMDb primeiro), sem repetir torrent
    return settled.reduce<TorrentLike[]>((acc, items) => this.parser.mergeTorrentResults(acc, items), []);
  }

  /**
   * GET /indexers/multi. Devolve undefined quando o endpoint não existe ou
   * falhou (quem chama cai no fallback por indexer); um array, mesmo vazio,
   * quando o torrent-indexer respondeu.
   */
  private async fetchMultiIndexerSearch(
    queries: string[],
    indexers: string[],
    budgetMs: number,
    context?: MatchContext,
  ): Promise<TorrentLike[] | undefined> {
    // margem para a resposta voltar antes do deadline global do guindex
    const deadlineMs = Math.max(500, budgetMs - 1000);
    const url = new URL(`${this.baseUrl}/indexers/multi`);
    for (const q of queries) {
      url.searchParams.append('q', q);
    }
    if (indexers.length > 0) url.searchParams.set('indexers', indexers.join(','));
    url.searchParams.set('deadline_ms', String(deadlineMs));

    logReq(context, `📡 Multi-Search: [${queries.join(', ')}] em [${indexers.length > 0 ? indexers.join(',') : 'todos os ativos'}] (deadline_ms: ${deadlineMs})`);

    try {
      const response = await request(url.toString(), {
        signal: AbortSignal.timeout(deadlineMs + 800),
        headers: { Accept: 'application/json' },
      });
      if (response.statusCode === 404 || response.statusCode === 405) {
        await response.body.dump().catch(() => undefined);
        const catalog = TorrentIndexerProvider.indexerCatalogCache;
        if (catalog) catalog.multi = false;
        logReq(context, `⚠️ torrent-indexer sem /indexers/multi (HTTP ${response.statusCode}).`);
        return undefined;
      }
      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        logReq(context, `⚠️ Multi-Search falhou: HTTP ${response.statusCode}`);
        return undefined;
      }

      const payload = (await response.body.json()) as Record<string, unknown>;
      if (!Array.isArray(payload?.results)) {
        return undefined;
      }
      const calls = Array.isArray(payload.calls) ? (payload.calls as MultiCall[]) : [];
      this.recordMultiCalls(calls, deadlineMs);

      const results = this.parser.normalizeTorrentPayload(payload);
      for (const torrent of results) {
        // /indexers/* não manda o nome do indexer; o multi diz em found_in
        const foundIn = torrent.found_in;
        if (!torrent.indexer && Array.isArray(foundIn) && typeof foundIn[0] === 'string') {
          torrent.indexer = foundIn[0];
        }
      }

      const countState = (state: string) => calls.filter((c) => c.state === state).length;
      logReq(
        context,
        `📡 Multi-Search: ${results.length} torrents (ok=${countState('ok')}, erro=${countState('error')}, ` +
          `timeout=${countState('timeout')}, pulados=${countState('skipped')}${payload.partial === true ? ', parcial' : ''})`,
      );
      return this.parser.rankTorrentsByQuery(results, queries[0] ?? '');
    } catch (err) {
      logReq(context, `⚠️ Multi-Search falhou: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Alimenta o histórico local (prioridade e cooldown) com o resultado de cada sub-chamada.
   * Uma resposta do multi traz várias queries por indexer, mas conta como uma só
   * observação de saúde: no máximo uma falha por indexer, e um "ok" em qualquer
   * query vence as falhas da mesma resposta. Sem isso, um 502 passageiro nas 3
   * queries de uma busca já fechava o limite de falhas seguidas.
   */
  private recordMultiCalls(calls: MultiCall[], deadlineMs: number): void {
    const okSlugs = new Set<string>();
    const failedSlugs = new Set<string>();
    for (const call of calls) {
      if (typeof call.indexer !== 'string' || !call.indexer) continue;
      const slug = this.parser.normalizeIndexerSlug(call.indexer);
      const durationMs = typeof call.duration_ms === 'number' ? call.duration_ms : 0;
      if (call.state === 'ok') {
        okSlugs.add(slug);
        // replay do cache não diz nada sobre a velocidade do site; SHARED pegou
        // carona numa execução já em andamento e só mostra parte do tempo
        if (call.cache !== 'HIT' && call.cache !== 'SHARED') {
          this.recordIndexerPerformance(slug, durationMs, call.count ?? 0);
        }
      } else if (call.state === 'error') {
        const status = call.status ?? 0;
        if (status >= 500 || status === 403 || status === 429) {
          failedSlugs.add(slug);
        }
        this.recordIndexerPerformance(slug, durationMs, 0);
      } else if (call.state === 'timeout' && call.reason === 'not_started') {
        // ficou na fila do multi até o prazo, o site nem foi chamado
        continue;
      } else if (call.state === 'timeout') {
        // A sub-chamada segue rodando no servidor e ainda vai para o cache dele,
        // mas o site foi lento: entra no histórico com pelo menos o prazo, para
        // a Fase 3 não o tratar como rápido.
        this.recordIndexerPerformance(slug, Math.max(durationMs, deadlineMs), 0);
      }
    }
    for (const slug of okSlugs) this.clearIndexerFailure(slug);
    for (const slug of failedSlugs) {
      if (!okSlugs.has(slug)) this.recordIndexerFailure(slug);
    }
  }

  private async fetchSearchResultsFromCandidates(
    queries: string[],
    indexers: string[],
    context?: MatchContext,
    merged: TorrentLike[] = [],
  ): Promise<TorrentLike[]> {
    const seen = new Set<string>();

    for (const query of queries) {
      for (let i = 0; i < indexers.length; i += TorrentIndexerProvider.FALLBACK_INDEXER_CONCURRENCY) {
        const batch = indexers.slice(i, i + TorrentIndexerProvider.FALLBACK_INDEXER_CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map((name) => this.fetchSingleIndexerSearch(name, query)),
        );

        for (const item of settled) {
          if (item.status !== 'fulfilled' || item.value.length === 0) {
            continue;
          }

          for (const torrent of item.value) {
            const key = this.parser.getTorrentDedupKey(torrent);
            if (key && seen.has(key)) {
              continue;
            }
            merged.push(torrent);
            if (key) {
              seen.add(key);
            }
          }
        }

        if (merged.length >= MAX_STREAMS) {
          break;
        }
      }

      if (merged.length >= MAX_STREAMS) {
        break;
      }
    }

    if (merged.length > 0) {
      logReq(context, `✅ Fallback por indexer recuperou ${merged.length} torrents brutos.`);
    }

    return this.parser.rankTorrentsByQuery(merged, queries[0] ?? '');
  }



  private async fetchSingleIndexerSearch(
    indexerName: string,
    query: string,
  ): Promise<TorrentLike[]> {
    const normalizedIndexer = indexerName.trim().toLowerCase();
    if (this.shouldSkipIndexer(normalizedIndexer)) {
      return [];
    }

    if (!this.indexerSupportsQuery(normalizedIndexer, query)) {
      return [];
    }

    const startedAt = Date.now();
    const url = new URL(`${this.baseUrl}/indexers/${encodeURIComponent(indexerName)}`);
    url.searchParams.set('q', query);

    try {
      const response = await request(url.toString(), {
        signal: AbortSignal.timeout(TorrentIndexerProvider.FALLBACK_REQUEST_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (response.statusCode >= 500 || response.statusCode === 403 || response.statusCode === 429) {
        await response.body.dump().catch(() => undefined);
        this.recordIndexerFailure(normalizedIndexer);
        this.recordIndexerPerformance(normalizedIndexer, Date.now() - startedAt, 0);
        return [];
      }
      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        this.recordIndexerPerformance(normalizedIndexer, Date.now() - startedAt, 0);
        return [];
      }

      const payload = await response.body.json();
      const results = this.parser.normalizeTorrentPayload(payload);
      this.clearIndexerFailure(normalizedIndexer);
      this.recordIndexerPerformance(normalizedIndexer, Date.now() - startedAt, results.length);
      return results;
    } catch {
      this.recordIndexerFailure(normalizedIndexer);
      this.recordIndexerPerformance(normalizedIndexer, Date.now() - startedAt, 0);
      return [];
    }
  }

  private compareIndexerPriority(a: string, b: string): number {
    const slugA = this.parser.normalizeIndexerSlug(a);
    const slugB = this.parser.normalizeIndexerSlug(b);
    const statsA = TorrentIndexerProvider.indexerPerformance.get(slugA);
    const statsB = TorrentIndexerProvider.indexerPerformance.get(slugB);

    if (statsA && statsB) {
      const rateA = (statsA.hits + 1) / (statsA.samples + 2);
      const rateB = (statsB.hits + 1) / (statsB.samples + 2);
      const emptyRateA = statsA.samples > 0 ? statsA.emptyHits / statsA.samples : 0;
      const emptyRateB = statsB.samples > 0 ? statsB.emptyHits / statsB.samples : 0;
      const scoreA = rateA * 1000 - statsA.avgMs - emptyRateA * 120;
      const scoreB = rateB * 1000 - statsB.avgMs - emptyRateB * 120;

      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      if (statsA.lastDurationMs !== statsB.lastDurationMs) {
        return statsA.lastDurationMs - statsB.lastDurationMs;
      }
    } else if (statsA) {
      return -1;
    } else if (statsB) {
      return 1;
    }

    return a.localeCompare(b);
  }

  private collectIndexerSlugs(results: TorrentLike[]): Set<string> {
    const names = new Set<string>();
    for (const torrent of results) {
      const raw = this.extractIndexerRawName(torrent);
      if (!raw) {
        continue;
      }
      const normalized = this.parser.normalizeIndexerSlug(raw);
      if (normalized) {
        names.add(normalized);
      }
    }
    return names;
  }

  private getDomainToIndexerMap(): Record<string, string> {
    const map: Record<string, string> = {
      'torrentdosfilmes': 'torrent-dos-filmes',
      'starckfilmes': 'starck-filmes',
      'vacatorrent': 'vaca_torrent',
      'redetorrent': 'rede_torrent',
      'comandotorrents': 'comando_torrents',
      'bludv': 'bludv',
      'filmetorrent': 'filme_torrent',
    };

    const cachedNames = TorrentIndexerProvider.indexerNamesCache?.names;
    if (Array.isArray(cachedNames)) {
      for (const name of cachedNames) {
        const slug = this.parser.normalizeIndexerSlug(name);
        const baseDomain = slug.replace(/[^a-z0-9]/g, '');
        if (baseDomain && !map[baseDomain]) {
          map[baseDomain] = slug;
        }
      }
    }
    return map;
  }

  private extractIndexerRawName(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.indexer ||
      record.indexerName ||
      record.indexer_name ||
      record.source ||
      record.provider ||
      record.origin ||
      record.site;

    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }

    const detailsUrl = record.details;
    if (typeof detailsUrl === 'string' && detailsUrl.startsWith('http')) {
      try {
        const host = new URL(detailsUrl).hostname.replace(/^www\./, '');
        const baseDomain = host.replace(/\.[^.]+$/, '').replace(/-v?\d+$/, '').replace(/[.-]/g, '').toLowerCase();
        const map = this.getDomainToIndexerMap();
        const mapped = map[baseDomain];
        if (mapped) return mapped;
        return baseDomain || undefined;
      } catch { /* ignore invalid URLs */ }
    }

    return undefined;
  }

  private shouldSkipIndexer(indexerName: string): boolean {
    const slug = this.parser.normalizeIndexerSlug(indexerName);
    if (!slug) {
      return true;
    }

    if (TorrentIndexerProvider.DISABLED_INDEXERS.has(slug)) {
      return true;
    }

    const state = TorrentIndexerProvider.indexerFailureState.get(slug);
    if (!state) {
      return false;
    }

    if (state.cooldownUntil > Date.now()) {
      return true;
    }

    return false;
  }

  private recordIndexerFailure(indexerSlug: string): void {
    const current = TorrentIndexerProvider.indexerFailureState.get(indexerSlug);
    const nextFailures = (current?.consecutiveFailures ?? 0) + 1;
    const shouldCooldown = nextFailures >= TorrentIndexerProvider.INDEXER_FAILURE_THRESHOLD;

    TorrentIndexerProvider.indexerFailureState.set(indexerSlug, {
      consecutiveFailures: nextFailures,
      cooldownUntil: shouldCooldown
        ? Date.now() + TorrentIndexerProvider.INDEXER_FAILURE_COOLDOWN_MS
        : 0,
    });
  }

  private clearIndexerFailure(indexerSlug: string): void {
    const current = TorrentIndexerProvider.indexerFailureState.get(indexerSlug);
    if (!current) {
      return;
    }

    if (current.consecutiveFailures === 0 && current.cooldownUntil === 0) {
      return;
    }

    TorrentIndexerProvider.indexerFailureState.set(indexerSlug, {
      consecutiveFailures: 0,
      cooldownUntil: 0,
    });
  }

  private recordIndexerPerformance(indexerSlug: string, durationMs: number, resultCount: number): void {
    const current = TorrentIndexerProvider.indexerPerformance.get(indexerSlug);
    const next: IndexerPerformanceEntry = current
      ? {
          avgMs: current.avgMs * 0.7 + durationMs * 0.3,
          samples: current.samples + 1,
          hits: current.hits + (resultCount > 0 ? 1 : 0),
          emptyHits: current.emptyHits + (resultCount === 0 ? 1 : 0),
          lastDurationMs: durationMs,
          lastSeenAt: Date.now(),
        }
      : {
          avgMs: durationMs,
          samples: 1,
          hits: resultCount > 0 ? 1 : 0,
          emptyHits: resultCount === 0 ? 1 : 0,
          lastDurationMs: durationMs,
          lastSeenAt: Date.now(),
        };

    TorrentIndexerProvider.indexerPerformance.set(indexerSlug, next);
  }

  private async fetchCinemetaMeta(
    type: string,
    id: string,
    forceFresh = false,
  ): Promise<CinemetaMeta | undefined> {
    const cacheKey = `${type}:${id}`;
    const cached = forceFresh ? undefined : TorrentIndexerProvider.cinemetaCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TorrentIndexerProvider.CINEMETA_TTL) {
      return cached.data;
    }

    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;

    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        return undefined;
      }

      const payload = (await response.body.json()) as Record<string, unknown>;
      const meta = payload?.meta ?? payload;
      if (meta && typeof meta === 'object') {
        const result = meta as CinemetaMeta;
        if (!forceFresh) {
          TorrentIndexerProvider.cinemetaCache.set(cacheKey, { data: result, ts: Date.now() });
        }
        return result;
      }
    } catch {
      // Ignore Cinemeta errors
    }

    return undefined;
  }

  private async fetchLocalizedTitleCandidates(imdbId: string, forceFresh = false): Promise<string[]> {
    const normalizedImdb = imdbId.trim().toLowerCase();
    if (!/^tt\d+$/.test(normalizedImdb)) {
      return [];
    }

    const cached = forceFresh ? undefined : TorrentIndexerProvider.localizedTitleCache.get(normalizedImdb);
    const cachedTtl = cached?.failed
      ? TorrentIndexerProvider.LOCALIZED_TITLE_FAILURE_TTL_MS
      : TorrentIndexerProvider.LOCALIZED_TITLE_CACHE_TTL_MS;
    if (cached && Date.now() - cached.ts < cachedTtl) {
      return cached.titles;
    }

    const readToken = TorrentIndexerProvider.TMDB_API_READ_ACCESS_TOKEN;
    const apiKey = TorrentIndexerProvider.TMDB_API_KEY;
    if (!readToken && !apiKey) {
      TorrentIndexerProvider.localizedTitleCache.set(normalizedImdb, { ts: Date.now(), titles: [] });
      return [];
    }

    const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(normalizedImdb)}`);
    url.searchParams.set('external_source', 'imdb_id');
    url.searchParams.set('language', 'pt-BR');
    if (apiKey) {
      url.searchParams.set('api_key', apiKey);
    }

    const titles = new Set<string>();

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (readToken) {
        headers.Authorization = `Bearer ${readToken}`;
      }

      const response = await request(url.toString(), {
        signal: AbortSignal.timeout(TorrentIndexerProvider.TMDB_TIMEOUT_MS),
        headers,
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump().catch(() => undefined);
        console.warn(`[GuIndex] TMDB respondeu HTTP ${response.statusCode} para ${normalizedImdb}; sem títulos PT-BR por ora.`);
        this.cacheLocalizedTitleFailure(normalizedImdb, forceFresh);
        return [];
      }

      const payload = (await response.body.json()) as {
        movie_results?: Array<Record<string, unknown>>;
        tv_results?: Array<Record<string, unknown>>;
      };

      const resultEntries = [...(payload.movie_results ?? []), ...(payload.tv_results ?? [])];
      for (const entry of resultEntries) {
        const candidates = [
          this.parser.toString(entry.title),
          this.parser.toString(entry.name),
          this.parser.toString(entry.original_title),
          this.parser.toString(entry.original_name),
        ];

        for (const candidate of candidates) {
          const label = this.parser.sanitizeQuery(candidate ?? '');
          if (label) {
            titles.add(label);
          }
        }
      }
    } catch (error) {
      // Segue só com os títulos do Cinemeta; tenta o TMDB de novo depois do TTL curto.
      console.warn(`[GuIndex] Falha ao consultar o TMDB para ${normalizedImdb}:`, (error as Error)?.message ?? error);
      this.cacheLocalizedTitleFailure(normalizedImdb, forceFresh);
      return [];
    }

    const result = Array.from(titles);
    if (!forceFresh) {
      TorrentIndexerProvider.localizedTitleCache.set(normalizedImdb, { ts: Date.now(), titles: result });
    }
    return result;
  }

  private cacheLocalizedTitleFailure(imdbId: string, forceFresh: boolean): void {
    if (forceFresh) return;
    TorrentIndexerProvider.localizedTitleCache.set(imdbId, { ts: Date.now(), titles: [], failed: true });
  }

  private mapTorrentToStream(
    torrent: TorrentLike,
    fallbackTitle: string,
    context: MatchContext
  ): SourceStream | undefined {
    if (!torrent || typeof torrent !== 'object') {
      return undefined;
    }

    const magnet = this.parser.extractMagnet(torrent);
    if (!magnet) {
      return undefined;
    }

    const totalSize = this.parser.extractSize(torrent);
    if (typeof totalSize === 'number' && totalSize > 0 && totalSize < TorrentIndexerProvider.MIN_VIDEO_SIZE) {
      return undefined;
    }

    const rawTitle = this.parser.extractTitle(torrent) || fallbackTitle || `${this.name} Torrent`;
    const detailUrl = this.parser.extractDetailUrl(torrent);

    const sourceLabel =
      this.parser.extractSourceDomain(torrent) ||
      this.parser.extractIndexerName(torrent) ||
      this.parser.titleize(this.name);

    const selectedFile = this.selectBestTorrentFile(torrent, context);
    const selectedFileName = selectedFile?.path;
    const fileIdx = selectedFile?.originalIndex;

    let displayTitle: string;
    if (selectedFileName) {
      const basename = selectedFileName.replace(/^.*[\\/]/, '');
      displayTitle = this.parser.cleanIndexerTitle(basename);
    } else {
      displayTitle = this.parser.cleanIndexerTitle(this.parser.buildDisplayTitle(torrent, rawTitle));
    }

    const rawSize = selectedFile?.size ?? this.parser.extractSize(torrent);
    const size = typeof rawSize === 'number' ? rawSize : this.parser.parseSizeString(rawSize);

    const releaseYear = this.parser.extractYear(torrent);

    const seeds = this.parser.extractSeeders(torrent);
    const seedCount = seeds !== undefined ? Math.max(0, Math.floor(seeds)) : 0;

    const infoSegments: string[] = [`Seeders: ${seedCount}`];
    if (size !== undefined && size > 0) {
      infoSegments.push(`Size: ${this.parser.formatSize(size)}`);
    }
    infoSegments.push(`[${sourceLabel}]`);

    const rawQuality =
      (torrent as Record<string, unknown>).quality ||
      (torrent as Record<string, unknown>).resolution ||
      this.parser.inferQualityFromTitle(displayTitle) ||
      this.parser.inferQualityFromTitle(rawTitle);
    const quality = this.parser.normalizeQuality(rawQuality);
    const releaseGroup =
      (torrent as Record<string, unknown>).releaseGroup ||
      (torrent as Record<string, unknown>).group ||
      (torrent as Record<string, unknown>).uploader ||
      (torrent as Record<string, unknown>).source;

    const audioLine = this.parser.formatAudioLine(torrent);
    const languages = this.parser.extractAudioLanguages(torrent);

    const headline = displayTitle;
    const titleLines = [headline];
    if (infoSegments.some((segment) => segment.trim().length > 0)) {
      titleLines.push(infoSegments.join(' | '));
    }
    if (audioLine) {
      titleLines.push(audioLine);
    }

    const qualityLabel = quality ?? 'Unknown';
  const nameLines = [`GuIndex`];
  if (qualityLabel !== 'Unknown') {
    nameLines.push(qualityLabel);
  } else {
    nameLines.push('Auto');
  }

  const rawIndexer = this.extractIndexerRawName(torrent);
  const indexerSlug = rawIndexer ? this.parser.normalizeIndexerSlug(rawIndexer) : undefined;
  const indexerLabel = (indexerSlug && this.parser.indexerLabel(indexerSlug)) || sourceLabel;

  const stream: SourceStream = {
    name: nameLines.join('\n'),
    title: titleLines.join('\n'),
    fileName: this.parser.buildStreamFileName(selectedFileName, rawTitle, displayTitle, torrent),
    source: sourceLabel,
    indexer: indexerSlug,
    indexerLabel,
    magnet
    // `cached` fica indefinido até a checagem do debrid (no StreamController)
  };

  if (detailUrl) {
    stream.detailUrl = detailUrl;
  }

  // Nome cru com extensão para behaviorHints.filename; fileName acima é só exibição.
  const releaseName = this.parser.extractReleaseName(torrent, magnet);
  const rawFileName = selectedFileName ? selectedFileName.replace(/^.*[\\/]/, '') : releaseName;
  if (rawFileName) {
    stream.rawFileName = rawFileName;
  }
  // Pasta só existe quando o stream é um arquivo dentro do torrent.
  if (selectedFile) {
    if (releaseName && releaseName !== rawFileName) {
      stream.folderName = releaseName;
    }
    if (typeof totalSize === 'number' && totalSize > 0) {
      stream.folderSize = totalSize;
    }
  }

  const publishDate = this.parser.extractPublishDate(torrent);
  if (publishDate) {
    stream.publishDate = publishDate;
  }

  if (languages.length > 0) {
    stream.languages = languages;
  }

  if (rawFileName) {
    const record = torrent as Record<string, unknown>;
    const hints = [record.title, record.original_title].filter((value): value is string => typeof value === 'string');
    const tag = filenameLanguageTag(rawFileName, languages, hints);
    if (tag) {
      stream.filenameLanguageTag = tag;
    }
  }

  const infoHash =
    (torrent as Record<string, unknown>).infoHash ||
    (torrent as Record<string, unknown>).info_hash ||
    (torrent as Record<string, unknown>).hash ||
    (torrent as Record<string, unknown>).btih ||
    this.parser.extractInfoHash(magnet);

  if (typeof infoHash === 'string' && infoHash) {
    stream.infoHash = infoHash.trim().toLowerCase();
  }

  const trackers = (torrent as Record<string, unknown>).trackers;
  if (Array.isArray(trackers)) {
    const list = trackers.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    if (list.length > 0) stream.trackers = list;
  }

  // fileIdx só vem de files[] (selectBestTorrentFile). Sem a lista, não há como saber
  // a posição do episódio no torrent: um índice chutado gera a chave hash:fileIdx errada
  // no deduplicador do AIOStreams e pode abrir o arquivo errado no debrid. O resolve do
  // GuIndex escolhe o arquivo pelo contexto (temporada/episódio), não pelo fileIdx.
  if (fileIdx !== undefined && fileIdx >= 0) {
    stream.fileIdx = fileIdx;
  } else if (
    context.parsed.season !== undefined &&
    context.parsed.episode !== undefined &&
    context.parsed.episode > 0 &&
    this.parser.looksLikeSeasonPack(torrent, context)
  ) {
    // Nome sintético só para exibição do episódio
    if (!selectedFileName) {
      const sPad = String(context.parsed.season).padStart(2, '0');
      const ePad = String(context.parsed.episode).padStart(2, '0');
      const cleanTitle = this.parser.cleanIndexerTitle(rawTitle);
      stream.fileName = `${cleanTitle}/S${sPad}E${ePad}.mkv`;
    }
  }

  if (size !== undefined) {
    stream.size = size;
  }

  // O runtime do Cinemeta é o do filme ou de um episódio: só vale para um arquivo
  // só, nunca para um pack inteiro (o bitrate sairia multiplicado pelos episódios).
  if (
    context.runtimeSeconds !== undefined &&
    (context.type.toLowerCase() === 'movie' || Boolean(selectedFile))
  ) {
    stream.durationSeconds = context.runtimeSeconds;
  }

  if (seeds !== undefined) {
    stream.seeders = seeds;
  }

  if (quality) {
    stream.quality = quality;
  }

  if (typeof releaseGroup === 'string' && releaseGroup.trim()) {
    stream.releaseGroup = releaseGroup.trim();
  }

  const episodeList = this.parser.extractEpisodeList(torrent);
  const streamContext: StreamContext = {};

  if (context.type) {
    streamContext.type = context.type;
  }

  if (context.parsed.season !== undefined) {
    streamContext.season = context.parsed.season;
  }

  if (context.parsed.episode !== undefined) {
    streamContext.episode = context.parsed.episode;
  }

  if (context.episodeTitle) {
    streamContext.episodeTitle = context.episodeTitle;
  }

  if (displayTitle) {
    streamContext.title = displayTitle;
  }

  const combinedYear = releaseYear ?? context.releaseYear;
  if (combinedYear !== undefined) {
    streamContext.year = combinedYear;
  }

  if (episodeList && episodeList.length > 0) {
    streamContext.episodeList = episodeList;
  }

  if (Object.keys(streamContext).length > 0) {
    stream.context = streamContext;
  }

  // Restore extended metadata from Torrent Indexer API
  if (typeof (torrent as any).video_quality === 'string' && (torrent as any).video_quality.trim()) {
    stream.videoQuality = (torrent as any).video_quality.trim();
  } else {
    const matchVq = rawTitle.match(/\b(10|9|8)[^a-z0-9]/i);
    if (matchVq) stream.videoQuality = matchVq[1];
  }

  if (typeof (torrent as any).audio_quality === 'string' && (torrent as any).audio_quality.trim()) {
    stream.audioQuality = (torrent as any).audio_quality.trim();
  } else {
    const matchAq = rawTitle.match(/\baudio\s?(10|9|8)\b/i);
    if (matchAq) stream.audioQuality = matchAq[1];
  }

  if (Array.isArray((torrent as any).genres) && (torrent as any).genres.length > 0) {
    stream.genres = (torrent as any).genres;
  }
  if (Array.isArray((torrent as any).subtitles) && (torrent as any).subtitles.length > 0) {
    stream.subtitles = (torrent as any).subtitles;
  }
  if (typeof (torrent as any).duration === 'string' && (torrent as any).duration.trim()) {
    stream.duration = (torrent as any).duration.trim();
  }
  if (typeof (torrent as any).classification === 'string' && (torrent as any).classification.trim()) {
    stream.classification = (torrent as any).classification.trim();
  }
  if (typeof (torrent as any).context === 'string' && (torrent as any).context.trim()) {
    stream.contextString = (torrent as any).context.trim();
  }

  const similarity = this.parser.toNumber((torrent as Record<string, unknown>).similarity);
  if (similarity !== undefined && similarity > 0) {
    stream.similarity = similarity;
  }

  return stream;
}

  private static readonly MIN_VIDEO_SIZE = 5 * 1024 * 1024; // 5 MB — anything smaller is junk/ads

  private selectBestTorrentFile(torrent: TorrentLike, context: MatchContext): IndexedTorrentFile | undefined {
    const files = this.parser.extractFilesFromTorrent(torrent);
    if (files.length === 0) {
      return undefined;
    }

    // Mesma regra e mesmo contexto que o TorBox e o RD usam no play (ver
    // file-selection.ts), para o fileIdx mostrado ser o arquivo que toca.
    const episodeList = this.parser.extractEpisodeList(torrent);
    const best = selectBestFile(
      files,
      (file) => ({ path: file.path, bytes: file.size ?? 0 }),
      {
        type: context.type,
        season: context.parsed.season,
        episode: context.parsed.episode,
        episodeTitle: context.episodeTitle,
        year: this.parser.extractYear(torrent) ?? context.releaseYear,
        episodeList: episodeList && episodeList.length > 0 ? episodeList : undefined,
      }
    );

    // Melhor arquivo pequeno demais: propaganda ou NFO, sem fileIdx
    if (best && best.size !== undefined && best.size < TorrentIndexerProvider.MIN_VIDEO_SIZE) {
      return undefined;
    }

    return best;
  }

}
