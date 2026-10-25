/**
 * Torrent Indexer Source Provider
 */

import { request } from 'undici';
import { BaseSourceProvider, type SourceFetchOptions } from './base-source-provider.js';
import { RealDebridService } from './realdebrid-service.js';
import { TorboxService } from './torbox-service.js';
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
  notifyLateResults,
  PHASE3_MIN_MS,
  PHASE3_MAX_QUERIES,
  IMDB_QUERY_REGEX,
  STRONG_EPISODE_REGEX,
  logReq,
} from './torrent-indexer-shared.js';

export { logReq } from './torrent-indexer-shared.js';
// Folga entre o fim da checagem de cache no debrid e o timeout do provedor
// (TORRENT_INDEXER_REQUEST_BUDGET_MS), para a resposta sair antes dele.
const DEBRID_DEADLINE_SAFETY_MS = 400;

const BACKGROUND_WARM_DELAY_MS = 2000;

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
  private static cinemetaCache = new Map<string, { data: CinemetaMeta; ts: number }>();
  private static readonly CINEMETA_TTL = 5 * 60 * 1000; // 5 min
  private static searchCache = new Map<string, SearchCacheEntry>();
  private static localizedTitleCache = new Map<string, LocalizedTitleCacheEntry>();
  private static indexerNamesCache:
    | { ts: number; names: string[] }
    | undefined;
  /** Capacidades e saúde dos indexers, lidas de /sources?v=2 */
  private static indexerCatalogCache: IndexerCatalog | undefined;
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
  private static readonly LOCALIZED_TITLE_CACHE_TTL_MS = parsePositiveInt(
    process.env.TORRENT_INDEXER_LOCALIZED_TITLE_CACHE_TTL_MS,
    7 * 24 * 60 * 60 * 1000,
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
    900_000,
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
    const [meta, localizedTitlesRaw] = await Promise.all([
      this.awaitWithin(this.fetchCinemetaMeta(type, metaLookupId, forceFresh), META_BUDGET_MS, undefined),
      parsed.imdbId
        ? this.awaitWithin(this.fetchLocalizedTitleCandidates(parsed.imdbId, forceFresh), META_BUDGET_MS, [])
        : Promise.resolve<string[]>([]),
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
    );
    const cacheSufficient = this.hasSufficientResults(cacheTorrents, fallbackTitle, context);
    const streams = this.collectStreamsFromTorrents(cacheTorrents, fallbackTitle, context, seen, sourceCounts, 150);
    const cacheHas4K = streams.some((stream) => stream.quality === '4K');

    // ═══════════════════════════════════════════════════════
    // FASE 2 — Multi
    //   Cache suficiente: espera o multi só por uma janela curta (mais longa
    //   quando o cache não tem 4K) e junta o que já voltou; o resto segue no
    //   servidor e alimenta o cache. Cache fraco: espera o multi até o prazo.
    // ═══════════════════════════════════════════════════════
    const graceMs = cacheHas4K ? MULTI_GRACE_MS : MULTI_GRACE_NO_4K_MS;
    const multiWaitMs = cacheSufficient && !forceFresh
      ? Math.min(graceMs, Math.max(0, remainingMs()))
      : Math.max(0, remainingMs());
    const multiResults = await this.awaitWithin(multiPromise, multiWaitMs, undefined);
    logReq(
      context,
      `📦 [Fase 1] cache: ${cacheTorrents.length} torrents (${cacheSufficient ? 'suficiente' : 'fraco'}` +
        `${cacheHas4K ? ', com 4K' : ', sem 4K'}); ` +
        `[Fase 2] multi: ${multiResults === undefined ? 'sem resposta no prazo' : `${multiResults.length} torrents`}`,
    );

    if (multiResults) {
      streams.push(
        ...this.collectStreamsFromTorrents(
          multiResults,
          fallbackTitle,
          context,
          seen,
          sourceCounts,
          Math.max(0, 150 - streams.length),
        ),
      );
    } else {
      this.watchLateMultiResults(multiPromise, type, id, fallbackTitle, context, seen);
    }

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
        const phase3Results = await this.fetchFastestIndexersSearch(phase3Queries, remainingMs(), context);
        streams.push(
          ...this.collectStreamsFromTorrents(phase3Results, fallbackTitle, context, seen, sourceCounts, 150),
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

    if (streams.length === 0) {
      logReq(context, `⚠️ Nenhum resultado encontrado para '${id}' após todas as fases (${Date.now() - startedAt}ms).`);
      return [];
    }

    // A consulta ao debrid usa só o que sobrou do orçamento: se o TorBox/RD
    // demorar, os streams saem sem o selo de cache em vez de a resposta inteira
    // estourar o timeout do provedor e ser descartada.
    const debridDone = await this.decorateWithDebrid(
      streams,
      options,
      searchDeadlineAt + DEBRID_MARGIN_MS - DEBRID_DEADLINE_SAFETY_MS,
    );
    if (!debridDone) {
      logReq(context, `⏰ Checagem de cache no debrid passou do prazo; streams seguem como não cacheados`);
    }
    logReq(context, `✅ Retornando ${streams.length} streams para '${id}' em ${Date.now() - startedAt}ms`);
    return streams;
  }

  /**
   * O multi passou da janela e a resposta saiu sem ele. Quando ele terminar, se
   * trouxe stream que a resposta não tinha (o 4K raspado em tempo real, por
   * exemplo), avisa o cache do /stream para não servir a versão antiga.
   */
  private watchLateMultiResults(
    multiPromise: Promise<TorrentLike[] | undefined>,
    type: string,
    id: string,
    fallbackTitle: string,
    context: MatchContext,
    delivered: Set<string>,
  ): void {
    const deliveredKeys = new Set(delivered);
    void multiPromise
      .then((late) => {
        if (!late || late.length === 0) return;
        const fresh = this.collectStreamsFromTorrents(late, fallbackTitle, context, deliveredKeys, new Map(), 150);
        if (fresh.length === 0) return;
        const has4K = fresh.some((stream) => stream.quality === '4K');
        logReq(
          context,
          `🕒 Multi chegou depois da resposta com ${fresh.length} streams novos${has4K ? ' (com 4K)' : ''}; ` +
            'o próximo pedido busca de novo',
        );
        notifyLateResults(type, id);
      })
      .catch(() => undefined);
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
    const indexers = (await this.fetchIndexerNames(false))
      .filter((name) => topQueries.some((q) => this.indexerSupportsQuery(name, q)));
    if (indexers.length === 0) return undefined;
    if (TorrentIndexerProvider.indexerCatalogCache?.multi === false) return undefined;
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

  async getSearchStreams(
    query: string,
    options?: SourceFetchOptions
  ): Promise<SourceStream[]> {
    const forceFresh = options?.forceFresh === true;
    const sanitized = this.parser.sanitizeQuery(query);
    if (!sanitized) return [];

    const context: MatchContext = {
      parsed: { query: sanitized },
      type: 'movie',
      targetTitles: [sanitized],
      reqId: 'SEARCH',
      logName: sanitized
    };

    logReq(context, `🔍 Iniciando busca genérica para: '${sanitized}'`);
    
    const queries = [sanitized];
    const rawTorrents = await this.fetchMultiSearchResults(queries, false, context, forceFresh);

    const seen = new Set<string>();
    const streams: SourceStream[] = [];

    for (const torrent of rawTorrents) {
      const stream = this.mapTorrentToStream(torrent, sanitized, context);
      if (!stream) continue;

      const dedupeKey = this.parser.getDedupeKey(stream);
      if (dedupeKey && seen.has(dedupeKey)) continue;

      streams.push(stream);
      if (dedupeKey) seen.add(dedupeKey);
      if (streams.length >= 100) break;
    }

    if (streams.length > 0) {
      await this.decorateWithDebrid(streams, options);
    }

    return streams;
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

  /**
   * Marca os streams cacheados no debrid. Com `deadlineAt`, desiste no prazo
   * (resolve false) e deixa todos como não cacheados; a consulta segue em
   * segundo plano e enche o cache de disponibilidade para o próximo pedido.
   */
  private async decorateWithDebrid(
    streams: SourceStream[],
    options?: SourceFetchOptions,
    deadlineAt?: number
  ): Promise<boolean> {
    const hashToStreams = new Map<string, SourceStream[]>();

    for (const stream of streams) {
      const hash = this.parser.getStreamInfoHash(stream);
      if (!hash) {
        stream.cached = false;
        continue;
      }

      const normalized = hash.toLowerCase();
      if (!hashToStreams.has(normalized)) {
        hashToStreams.set(normalized, []);
      }
      hashToStreams.get(normalized)!.push(stream);
    }

    if (hashToStreams.size === 0) {
      return true;
    }

    let cachedHashes = new Set<string>();
    const lookup = this.fetchDebridCachedHashes([...hashToStreams.keys()], options).catch(() => new Set<string>());
    if (deadlineAt === undefined) {
      cachedHashes = await lookup;
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineAt - Date.now()));
      });
      const result = await Promise.race([lookup, expired]);
      if (timer) clearTimeout(timer);
      if (!result) {
        for (const relatedStreams of hashToStreams.values()) {
          for (const s of relatedStreams) s.cached = false;
        }
        return false;
      }
      cachedHashes = result;
    }

    const badgeProvider =
      options?.debridProvider ?? (options?.torboxToken && !options?.realdebridToken ? 'torbox' : 'realdebrid');

    for (const [hash, relatedStreams] of hashToStreams.entries()) {
      const isCached = cachedHashes.has(hash);
      for (const s of relatedStreams) {
        s.cached = isCached;
        if (isCached) {
          this.parser.applyDebridBadge(s, badgeProvider);
        }
      }
    }
    return true;
  }

  private async fetchDebridCachedHashes(
    hashes: string[],
    options?: SourceFetchOptions
  ): Promise<Set<string>> {
    const provider = options?.debridProvider;
    const rdToken = options?.realdebridToken;
    const tbToken = options?.torboxToken;

    if (provider === 'torbox') {
      return TorboxService.fetchCachedInfoHashes(hashes, tbToken);
    }

    if (provider === 'realdebrid') {
      return RealDebridService.fetchCachedInfoHashes(hashes, rdToken);
    }

    if (tbToken) {
      return TorboxService.fetchCachedInfoHashes(hashes, tbToken);
    }

    if (rdToken) {
      return RealDebridService.fetchCachedInfoHashes(hashes, rdToken);
    }

    return new Set<string>();
  }
  private async fetchMeilisearchResults(query: string): Promise<TorrentLike[]> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '200');
    try {
      const response = await request(url.toString(), {
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: 'application/json' },
      });
      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        return [];
      }
      const payload = await response.body.json();
      return this.parser.normalizeTorrentPayload(payload);
    } catch {
      return [];
    }
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

  private warmIndexerCacheInBackground(query: string, existingResults: TorrentLike[], context?: MatchContext): void {
    globalQueue.add(async () => {
      await this.fetchSearchResultsFromIndexers(query, undefined, context);
    }, `Atualização de Fundo para '${query}'`, context);
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
  private async fetchIndexerCatalog(): Promise<IndexerCatalog | undefined> {
    const cached = TorrentIndexerProvider.indexerCatalogCache;
    if (
      cached &&
      Date.now() - cached.ts < TorrentIndexerProvider.INDEXER_NAMES_CACHE_TTL_MS &&
      cached.indexers.length > 0
    ) {
      return cached;
    }

    try {
      const response = await request(`${this.baseUrl}/sources?v=2`, {
        signal: AbortSignal.timeout(7000),
        headers: { Accept: 'application/json' },
      });
      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        return cached;
      }

      const payload = (await response.body.json()) as Record<string, unknown>;
      const catalog = this.parser.parseIndexerCatalog(payload);
      if (!catalog || catalog.indexers.length === 0) {
        return cached;
      }
      TorrentIndexerProvider.indexerCatalogCache = catalog;
      // getDomainToIndexerMap usa os nomes para reconhecer o indexer pelo domínio
      TorrentIndexerProvider.indexerNamesCache = {
        ts: catalog.ts,
        names: catalog.indexers.map((c) => c.name),
      };
      return catalog;
    } catch {
      return cached;
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

  private async fetchMultiSearchResults(
    queries: string[],
    fastPathOnly = false,
    context: MatchContext,
    forceFresh = false,
    midPathQueries?: string[]
  ): Promise<TorrentLike[]> {
    if (!queries || queries.length === 0) return [];

    const cacheKey = this.getSearchCacheKey(queries.join('|'));
    const cached = TorrentIndexerProvider.searchCache.get(cacheKey);
    if (!forceFresh && cached && Date.now() - cached.ts < TorrentIndexerProvider.SEARCH_CACHE_TTL_MS) {
      return cached.data;
    }

    // 1) Fase 1: Busca em massa no Meilisearch
    const searchResults = await this.fetchBulkMeilisearchResults(queries);
    const primaryQuery = queries[0] ?? '';

    // Se tivermos resultados suficientes ou for apenas FastPath, retornamos
    if (fastPathOnly || this.hasSufficientResults(searchResults, primaryQuery, context)) {
      if (fastPathOnly) {
        return searchResults;
      }
      const ranked = this.parser.rankTorrentsByQuery(searchResults, primaryQuery);
      if (!forceFresh) {
        TorrentIndexerProvider.searchCache.set(cacheKey, { ts: Date.now(), data: ranked });
      }
      return ranked;
    }

    // 2) Fase 2: Mid-Path (Sync Scrape via indexers específicos rápidos)
    // Sempre usar as 3 queries otimizadas (IMDB ID, titulo inglês, titulo português)
    const queriesToUse = midPathQueries && midPathQueries.length > 0 ? midPathQueries : queries.slice(0, 3);
    const indexerResults = await this.fetchBulkSearchResultsFromIndexers(queriesToUse, {
      timeoutMs: 8000,
    }, context);

    const merged = this.parser.rankTorrentsByQuery(
      this.parser.mergeTorrentResults(searchResults, indexerResults),
      primaryQuery,
    );

    if (!forceFresh) {
      TorrentIndexerProvider.searchCache.set(cacheKey, { ts: Date.now(), data: merged });
      
      // Se não for forceFresh, fazemos um warm-up completo em background (incluindo bludv)
      this.warmIndexerCacheInBackground(primaryQuery, merged, context);
    }

    return merged;
  }

  /**
   * Uma chamada /search por query, em paralelo: o /search do torrent-indexer
   * lê só o primeiro q, então várias q numa chamada só pesquisavam o IMDb.
   */
  private async fetchBulkMeilisearchResults(queries: string[], timeoutMs = 8000): Promise<TorrentLike[]> {
    const uniqueQueries = [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 0))];
    if (uniqueQueries.length === 0) return [];

    const settled = await Promise.all(
      uniqueQueries.map(async (q) => {
        const url = new URL(`${this.baseUrl}/search`);
        url.searchParams.set('q', q);
        url.searchParams.set('limit', '200');
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

  private async fetchBulkSearchResultsFromIndexers(
    queries: string[],
    options?: FallbackSearchOptions,
    context?: MatchContext,
  ): Promise<TorrentLike[]> {
    if (!TorrentIndexerProvider.ENABLE_FALLBACK_INDEXER_SEARCH) return [];
    if (!queries || queries.length === 0) return [];

    const globalDeadlineMs = options?.timeoutMs ?? 10_000;
    const topQueries = queries.slice(0, 3);

    // Deadline global: garante que NUNCA ultrapassamos o timeout,
    // mesmo com fallback cascateado (multi → individual).
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = new Promise<TorrentLike[]>((resolve) => {
      deadlineHandle = setTimeout(() => {
        logReq(context, `⏰ Mid-path deadline global de ${globalDeadlineMs}ms atingido.`);
        resolve([]);
      }, globalDeadlineMs);
    });

    const startedAt = Date.now();
    const doSearch = async (): Promise<TorrentLike[]> => {
      const indexers = (await this.fetchIndexerNames(false))
        .filter((name) => topQueries.some((q) => this.indexerSupportsQuery(name, q)));
      if (indexers.length === 0) return [];

      // Fan-out no torrent-indexer: uma chamada para todos os indexers x queries,
      // com cache, dedup por info_hash e resposta parcial no deadline.
      if (TorrentIndexerProvider.indexerCatalogCache?.multi !== false) {
        const remainingMs = globalDeadlineMs - (Date.now() - startedAt);
        const multiResults = await this.fetchMultiIndexerSearch(topQueries, indexers, remainingMs, context);
        if (multiResults) return multiResults;
      }

      // Fallback (torrent-indexer sem /indexers/multi, ou ele falhou): chamadas
      // individuais só nos indexers mais rápidos pelo histórico local.
      const avgTimes = Array.from(TorrentIndexerProvider.indexerPerformance.values())
        .map(s => s.avgMs)
        .filter(ms => ms > 0);
      const overallAvg = avgTimes.length > 0 
        ? avgTimes.reduce((a, b) => a + b, 0) / avgTimes.length 
        : 500;
      const maxAllowedMs = overallAvg * 1.3;

      const selected = indexers
        .filter((name) => {
          const slug = this.parser.normalizeIndexerSlug(name);
          const perf = TorrentIndexerProvider.indexerPerformance.get(slug);
          if (!perf || perf.avgMs === 0) return true;
          return perf.avgMs <= maxAllowedMs;
        })
        .slice(0, 4);
      const candidates = selected.length > 0 ? selected : indexers.slice(0, 6);

      logReq(context, `↩️ Fallback por indexer: [${topQueries.join(', ')}] em [${candidates.join(',')}] (Deadline: ${globalDeadlineMs}ms)`);
      return await this.fetchSearchResultsFromCandidates(topQueries, candidates, context);
    };

    // Promise.race garante que o deadline global é respeitado
    try {
      return await Promise.race([doSearch(), deadlineTimer]);
    } finally {
      if (deadlineHandle) clearTimeout(deadlineHandle);
    }
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
    url.searchParams.set('indexers', indexers.join(','));
    url.searchParams.set('deadline_ms', String(deadlineMs));

    logReq(context, `📡 Multi-Search: [${queries.join(', ')}] em [${indexers.join(',')}] (deadline_ms: ${deadlineMs})`);

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

  /** Alimenta o histórico local (prioridade e cooldown) com o resultado de cada sub-chamada. */
  private recordMultiCalls(calls: MultiCall[], deadlineMs: number): void {
    for (const call of calls) {
      if (typeof call.indexer !== 'string' || !call.indexer) continue;
      const slug = this.parser.normalizeIndexerSlug(call.indexer);
      const durationMs = typeof call.duration_ms === 'number' ? call.duration_ms : 0;
      if (call.state === 'ok') {
        this.clearIndexerFailure(slug);
        // replay do cache não diz nada sobre a velocidade do site
        if (call.cache !== 'HIT') {
          this.recordIndexerPerformance(slug, durationMs, call.count ?? 0);
        }
      } else if (call.state === 'error') {
        const status = call.status ?? 0;
        if (status >= 500 || status === 403 || status === 429) {
          this.recordIndexerFailure(slug);
        }
        this.recordIndexerPerformance(slug, durationMs, 0);
      } else if (call.state === 'timeout') {
        // A sub-chamada segue rodando no servidor e ainda vai para o cache dele,
        // mas o site foi lento: entra no histórico com pelo menos o prazo, para
        // a Fase 3 não o tratar como rápido.
        this.recordIndexerPerformance(slug, Math.max(durationMs, deadlineMs), 0);
      }
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

  private shouldBoostWithFallback(results: TorrentLike[]): boolean {
    if (results.length === 0) {
      return true;
    }

    if (results.length < TorrentIndexerProvider.HYBRID_MIN_RESULTS) {
      return true;
    }

    const uniqueIndexers = this.collectIndexerSlugs(results);
    return uniqueIndexers.size < TorrentIndexerProvider.HYBRID_MIN_INDEXERS;
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
    if (cached && Date.now() - cached.ts < TorrentIndexerProvider.LOCALIZED_TITLE_CACHE_TTL_MS) {
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

      if (response.statusCode >= 400) {
        await response.body.dump().catch(() => undefined);
        TorrentIndexerProvider.localizedTitleCache.set(normalizedImdb, { ts: Date.now(), titles: [] });
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
    } catch {
      // Ignore TMDB failures and continue with Cinemeta-only titles.
    }

    const result = Array.from(titles);
    if (!forceFresh) {
      TorrentIndexerProvider.localizedTitleCache.set(normalizedImdb, { ts: Date.now(), titles: result });
    }
    return result;
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
    magnet,
    cached: false
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

    const scored = files
      .map((file) => ({ file, score: this.scoreTorrentFile(file, context) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.file.size ?? 0) - (a.file.size ?? 0);
      });

    const best = scored[0]?.file;

    // Reject if the best file is too small — likely an ad MP4 or NFO
    if (best && best.size !== undefined && best.size < TorrentIndexerProvider.MIN_VIDEO_SIZE) {
      return undefined;
    }

    return best;
  }

  private scoreTorrentFile(file: IndexedTorrentFile, context: MatchContext): number {
    const normalizedPath = this.parser.normalizeForComparison(file.path);
    const normalizedType = context.type.toLowerCase();
    let score = 0;

    // Prefer real video files and penalize common junk files.
    if (this.parser.isVideoPath(file.path)) score += 30;
    if (/\b(sample|trailer|extras?|bonus|featurette|behindthescenes|creditos|poster|rarbg|nfo|subs?|propaganda|anuncio|promo|preview|teaser)\b/i.test(file.path)) {
      score -= 25;
    }
    if (/\.(txt|url|nfo|jpg|jpeg|png|gif|bmp|ico|md|html|htm|exe|bat|lnk|srt|sub|ass|ssa|idx)$/i.test(file.path)) {
      score -= 40;
    }

    // Penalize tiny files — almost certainly ads, readme, or fake content
    if (file.size !== undefined && file.size < TorrentIndexerProvider.MIN_VIDEO_SIZE) {
      score -= 50;
    }

    for (const title of context.targetTitles) {
      const normalizedTitle = this.parser.normalizeForComparison(title);
      if (!normalizedTitle) continue;
      if (normalizedPath.includes(normalizedTitle)) {
        score += 10;
        break;
      }
    }

    if (context.releaseYear && normalizedPath.includes(String(context.releaseYear))) {
      score += 6;
    }

    const fileSeason = this.parser.extractSeasonFromTorrent({ title: file.path });
    const fileEpisode = this.parser.extractEpisodeFromTorrent({ title: file.path });
    const episodeList = this.parser.extractEpisodeList({ title: file.path, filesEpisodes: file.path });

    if (normalizedType === 'movie') {
      if (fileSeason !== undefined || fileEpisode !== undefined) {
        score -= 20;
      }
      if (STRONG_EPISODE_REGEX.test(file.path)) {
        score -= 12;
      }
    } else if (context.parsed.season !== undefined) {
      if (fileSeason !== undefined) {
        score += fileSeason === context.parsed.season ? 12 : -18;
      }
      if (context.parsed.episode !== undefined) {
        if (fileEpisode !== undefined) {
          score += fileEpisode === context.parsed.episode ? 18 : -24;
        }
        if (episodeList && episodeList.length > 0) {
          score += episodeList.includes(context.parsed.episode) ? 14 : -24;
        }
      }
    }

    score += Math.log10((file.size ?? 0) + 1);

    // Prefer Portuguese-language files (Dublado > Legendado > unmarked)
    const lowerPath = file.path.toLowerCase();
    if (/\b(dublado|dublada|dual|ptbr|pt[\s._-]?br|nacional)\b/i.test(lowerPath)) {
      score += 8;
    } else if (/\b(legendado|leg)\b/i.test(lowerPath)) {
      score += 3;
    }

    return score;
  }

}
