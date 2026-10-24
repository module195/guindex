/**
 * Torrent Indexer Source Provider
 */

import { request } from 'undici';
import { BaseSourceProvider, type SourceFetchOptions } from './base-source-provider.js';
import { RealDebridService } from './realdebrid-service.js';
import { TorboxService } from './torbox-service.js';
import type { SourceStream, StreamContext } from '../models/source-model.js';
import { detectReleaseLanguages, languagesFromAudioValues, reconcileAudioWithRelease, stripAudioSuffix } from './audio-language.js';

interface ParsedIdInfo {
  imdbId?: string;
  query?: string;
  season?: number;
  episode?: number;
}

interface CinemetaVideo {
  season?: number | string;
  episode?: number | string;
  title?: string;
  name?: string;
}

interface CinemetaMeta {
  id?: string;
  name?: string;
  title?: string;
  originalTitle?: string;
  year?: number;
  releaseInfo?: string;
  aliases?: string[];
  alternativeTitles?: string[];
  alternative_titles?: string[];
  aka?: string[];
  videos?: CinemetaVideo[];
  translations?: Record<string, unknown>;
  infos?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Typed shape of a torrent result from the indexer API.
 * Both /search (Meilisearch) and /indexers/{name} return this shape.
 * Fields are optional because different sources may omit some of them.
 */
interface TorrentResult {
  title?: string;
  original_title?: string;
  details?: string;
  year?: string | number;
  imdb?: string;
  audio?: string[];
  magnet_link?: string;
  date?: string;
  info_hash?: string;
  trackers?: string[] | null;
  size?: string | number;
  leech_count?: number;
  seed_count?: number;
  similarity?: number;
  /** Present on /indexers results but NOT on /search results */
  indexer?: string;
  indexerName?: string;
  indexer_name?: string;
  source?: string;
  provider?: string;
  origin?: string;
  site?: string;
  /** File list for multi-file torrents */
  files?: Array<{
    path?: string;
    name?: string;
    size?: number | string;
    length?: number;
    index?: number;
  }>;
  [key: string]: unknown;
}

/**
 * Keep the loose alias so the 200+ existing method signatures don't break.
 * New code should prefer TorrentResult for field access.
 */
type TorrentLike = TorrentResult & Record<string, unknown>;

interface IndexedTorrentFile {
  path: string;
  size?: number;
  originalIndex: number;
}

/** One entry of "indexers" in the torrent-indexer's /sources?v=2. */
interface IndexerCapability {
  name: string;
  /** undefined = unknown (old /sources without v=2): try every query */
  supportsText?: boolean;
  supportsImdb?: boolean;
  healthy: boolean;
}

interface IndexerCatalog {
  ts: number;
  indexers: IndexerCapability[];
  /** /indexers/multi is available; undefined = unknown (try it once) */
  multi?: boolean;
}

/** One entry of "calls" in the /indexers/multi response. */
interface MultiCall {
  indexer?: string;
  q?: string;
  state?: string; // ok | error | skipped | timeout
  status?: number;
  count?: number;
  duration_ms?: number;
  cache?: string;
  reason?: string;
}

interface SearchCacheEntry {
  ts: number;
  data: TorrentLike[];
}

interface LocalizedTitleCacheEntry {
  ts: number;
  titles: string[];
}

interface IndexerFailureState {
  consecutiveFailures: number;
  cooldownUntil: number;
}

interface IndexerPerformanceEntry {
  avgMs: number;
  samples: number;
  hits: number;
  emptyHits: number;
  lastDurationMs: number;
  lastSeenAt: number;
}

interface FallbackSearchOptions {
  excludeIndexers?: Set<string>;
  maxIndexers?: number;
  perIndexerLimit?: number;
  targetResults?: number;
  timeoutMs?: number;
  limitQueries?: number;
  excludeNamesWithYear?: boolean;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

const normalizeIndexerValue = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]+/g, '');

const parseCsvSet = (value: string | undefined, defaults: string[] = []): Set<string> => {
  const raw = value ?? defaults.join(',');
  const out = new Set<string>();
  for (const item of raw.split(',')) {
    const normalized = normalizeIndexerValue(item);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const readEnv = (primary: string, legacy?: string): string | undefined => {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined) {
    return primaryValue;
  }

  if (legacy) {
    return process.env[legacy];
  }

  return undefined;
};

const MAX_STREAMS = 240;
const TARGET_STREAMS_PER_REQUEST = parsePositiveInt(
  process.env.TORRENT_INDEXER_TARGET_STREAMS,
  30,
);
const MAX_DYNAMIC_QUERIES = parsePositiveInt(
  process.env.TORRENT_INDEXER_MAX_DYNAMIC_QUERIES,
  10,
);
const MAX_SEARCH_TIME_MS = parsePositiveInt(
  process.env.TORRENT_INDEXER_MAX_QUERY_TIME_MS,
  18_000,
);
const MAX_STREAMS_PER_SOURCE = parsePositiveInt(
  process.env.TORRENT_INDEXER_MAX_STREAMS_PER_SOURCE,
  50,
);
const MAX_TEXT_QUERIES = 12;
const MAX_COLLECT_PER_SOURCE = parsePositiveInt(
  process.env.TORRENT_INDEXER_COLLECT_PER_SOURCE,
  40,
);
// Quantidade de queries extras (além do mid-path) aquecidas em background.
// 0 = desligado (comportamento original).
const WARM_EXTRA_QUERIES = parseNonNegativeInt(
  process.env.TORRENT_INDEXER_WARM_EXTRA_QUERIES,
  0,
);
// Orçamento da busca por pedido, desde a chegada (o AIOStreams costuma dar 10 s ao addon).
const REQUEST_BUDGET_MS = parsePositiveInt(process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS, 8500);
// Reserva, dentro do orçamento, para a consulta de cache do debrid depois da busca.
const DEBRID_MARGIN_MS = parseNonNegativeInt(process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS, 1500);
// Fase 1: quantas queries vão ao Meilisearch (uma chamada /search por query, em paralelo).
const MAX_CACHE_QUERIES = parsePositiveInt(process.env.TORRENT_INDEXER_CACHE_MAX_QUERIES, 8);
const CACHE_TIMEOUT_MS = parsePositiveInt(process.env.TORRENT_INDEXER_CACHE_TIMEOUT_MS, 3000);
// Fase 2: com cache suficiente, quanto ainda esperar pelo multi antes de responder.
const MULTI_GRACE_MS = parseNonNegativeInt(process.env.TORRENT_INDEXER_MULTI_GRACE_MS, 1500);
// Fase 3: tempo mínimo restante para valer a pena e máximo de queries.
const PHASE3_MIN_MS = parsePositiveInt(process.env.TORRENT_INDEXER_PHASE3_MIN_MS, 1500);
const PHASE3_MAX_QUERIES = parsePositiveInt(process.env.TORRENT_INDEXER_PHASE3_MAX_QUERIES, 3);
const IMDB_QUERY_REGEX = /^tt\d+$/i;
// Sinais fortes de série, com fronteira de palavra. Fica de fora o que aparece em
// nome de filme: "DTS5.1", "1920x1080", "Filme Completo", "Pack", "Collection",
// "Episódio IV", "A Série Divergente".
const STRONG_EPISODE_REGEX =
  /\b(?:S\d{1,2}\s?E\d{1,3}|S\d{1,2}\b(?!\.\d)|\d{1,2}x\d{1,3}(?![\dp])|temporadas?\b|seasons?\b|epis[oó]dios?\s*\d|episodes?\s*\d|cap[ií]tulos?\s*\d|mini[\s-]?s+[eé]ries?|s[eé]rie\s+completa|complete\s+series|\d{1,2}[ªºa]\s*temp)/i;

const LANGUAGE_FLAG_MAP: Record<string, string> = {
  portugues: '🇧🇷',
  portuguese: '🇧🇷',
  'brazilian portuguese': '🇧🇷',
  ingles: '🇺🇸',
  english: '🇺🇸',
  espanhol: '🇪🇸',
  spanish: '🇪🇸',
  frances: '🇫🇷',
  french: '🇫🇷',
  italiano: '🇮🇹',
  italian: '🇮🇹',
  alemao: '🇩🇪',
  german: '🇩🇪',
  japones: '🇯🇵',
  japanese: '🇯🇵',
  coreano: '🇰🇷',
  korean: '🇰🇷',
  chines: '🇨🇳',
  chinese: '🇨🇳',
  mandarim: '🇨🇳',
  mandarin: '🇨🇳',
  cantones: '🇭🇰',
  cantonese: '🇭🇰',
  russo: '🇷🇺',
  russian: '🇷🇺',
  hindi: '🇮🇳',
  arabe: '🇸🇦',
  arabic: '🇸🇦',
  turco: '🇹🇷',
  turkish: '🇹🇷',
  polones: '🇵🇱',
  polish: '🇵🇱',
  sueco: '🇸🇪',
  swedish: '🇸🇪',
  noruegues: '🇳🇴',
  norwegian: '🇳🇴',
  dinamarques: '🇩🇰',
  danish: '🇩🇰',
  finlandes: '🇫🇮',
  finnish: '🇫🇮',
  tcheco: '🇨🇿',
  czech: '🇨🇿',
  hungaro: '🇭🇺',
  hungarian: '🇭🇺',
  ucraniano: '🇺🇦',
  ukrainian: '🇺🇦',
  tailandes: '🇹🇭',
  thai: '🇹🇭',
  vietnamita: '🇻🇳',
  vietnamese: '🇻🇳',
  holandes: '🇳🇱',
  dutch: '🇳🇱',
  grego: '🇬🇷',
  greek: '🇬🇷',
  hebraico: '🇮🇱',
  hebrew: '🇮🇱',
  romeno: '🇷🇴',
  romanian: '🇷🇴',
  bulgaro: '🇧🇬',
  bulgarian: '🇧🇬',
  croata: '🇭🇷',
  croatian: '🇭🇷',
  islandes: '🇮🇸',
  icelandic: '🇮🇸',
  persa: '🇮🇷',
  persian: '🇮🇷',
  farsi: '🇮🇷',
  latin: '🇻🇦',
  latim: '🇻🇦',
};

interface MatchContext {
  parsed: ParsedIdInfo;
  type: string;
  targetTitles: string[];
  releaseYear?: number;
  episodeTitle?: string;
  reqId?: string;
  logName?: string;
}

export function logReq(context: MatchContext | undefined, message: string) {
  const ts = new Date().toISOString();
  const req = context?.reqId ? `[Req: ${context.reqId}]` : '';
  const name = context?.logName ? `[${context.logName}]` : '';
  console.info(`[${ts}] [GuIndex] ${req} ${name} ${message}`.replace(/\s+/g, ' '));
}

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
    const parsed = this.parseId(id);
    const metaLookupId = parsed.imdbId ?? parsed.query ?? (id || '').split(':')[0] ?? id;
    const [meta, localizedTitlesRaw] = await Promise.all([
      this.fetchCinemetaMeta(type, metaLookupId, forceFresh),
      parsed.imdbId
        ? this.fetchLocalizedTitleCandidates(parsed.imdbId, forceFresh)
        : Promise.resolve<string[]>([]),
    ]);
    let displayTitles = this.collectMetaTitles(meta);
    
    let localizedTitles: string[] = [];
    if (parsed.imdbId) {
      localizedTitles = localizedTitlesRaw;
      
      if (type === 'series') {
        // Evita chamada duplicada ao Cinemeta quando o lookup acima já foi o mesmo
        const fallback = metaLookupId === parsed.imdbId
          ? meta
          : await this.fetchCinemetaMeta('series', parsed.imdbId, forceFresh);
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
    const releaseYear = this.extractReleaseYear(meta);
    const episodeTitle =
      parsed.season !== undefined && parsed.episode !== undefined
        ? this.findEpisodeTitle(meta, parsed.season, parsed.episode)
        : undefined;

    const imdbQuery = parsed.imdbId;
    const textQuery = this.buildTextQuery(type, parsed, targetTitle, releaseYear, episodeTitle);
    const textQueries = this.buildTextQueryCandidates(type, parsed, displayTitles, releaseYear, episodeTitle);

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
      episodeTitle
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

    // ═══════════════════════════════════════════════════════
    // FASE 2 — Multi
    //   Cache suficiente: espera o multi só por uma janela curta e junta o que
    //   já voltou (o resto segue no servidor e alimenta o cache). Cache fraco:
    //   espera o multi até o prazo.
    // ═══════════════════════════════════════════════════════
    const multiWaitMs = cacheSufficient && !forceFresh
      ? Math.min(MULTI_GRACE_MS, Math.max(0, remainingMs()))
      : Math.max(0, remainingMs());
    const multiResults = await this.awaitWithin(multiPromise, multiWaitMs, undefined);
    logReq(
      context,
      `📦 [Fase 1] cache: ${cacheTorrents.length} torrents (${cacheSufficient ? 'suficiente' : 'fraco'}); ` +
        `[Fase 2] multi: ${multiResults === undefined ? 'sem resposta no prazo' : `${multiResults.length} torrents`}`,
    );

    const streams = this.collectStreamsFromTorrents(
      this.mergeTorrentResults(cacheTorrents, multiResults ?? []),
      fallbackTitle,
      context,
      seen,
      sourceCounts,
      150,
    );

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

    await this.decorateWithDebrid(streams, options);
    logReq(context, `✅ Retornando ${streams.length} streams para '${id}' em ${Date.now() - startedAt}ms`);
    return streams;
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
    return results ?? this.rankTorrentsByQuery([...partial], queries[0] ?? '');
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
        const perf = TorrentIndexerProvider.indexerPerformance.get(this.normalizeIndexerSlug(name));
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
    const sanitized = this.sanitizeQuery(query);
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

      const dedupeKey = this.getDedupeKey(stream);
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

  private getDedupeKey(stream: SourceStream): string | undefined {
    let base: string | undefined;
    if (stream.infoHash) {
      base = stream.infoHash.toLowerCase();
    } else if (stream.magnet) {
      const infoHash = this.extractInfoHash(stream.magnet);
      base = infoHash ? infoHash.toLowerCase() : stream.magnet;
    }
    if (!base) return undefined;
    return stream.fileIdx !== undefined && stream.fileIdx >= 0
      ? `${base}:${stream.fileIdx}`
      : base;
  }

  private getTorrentDedupKey(torrent: TorrentLike): string | undefined {
    const infoHash = this.toString(torrent.info_hash ?? torrent.infoHash ?? torrent.hash);
    if (infoHash) {
      return infoHash.toLowerCase();
    }

    const magnet = this.toString(torrent.magnet_link ?? torrent.magnet);
    if (magnet) {
      const hash = this.extractInfoHash(magnet);
      if (hash) {
        return hash.toLowerCase();
      }
      return magnet;
    }

    const title = this.toString(torrent.title ?? torrent.original_title ?? torrent.details);
    return title ? title.toLowerCase() : undefined;
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

    for (const torrent of torrents) {
      if (!this.isRelevantTorrent(torrent, context)) continue;
      const stream = this.mapTorrentToStream(torrent, fallbackTitle, context);
      if (!stream) continue;

      const dedupeKey = this.getDedupeKey(stream);
      if (dedupeKey && seen.has(dedupeKey)) continue;

      const sourceKey = (stream.source ?? 'unknown').toLowerCase();
      const sourceCount = sourceCounts.get(sourceKey) ?? 0;
      if (sourceCount >= MAX_COLLECT_PER_SOURCE) continue;

      streams.push(stream);
      sourceCounts.set(sourceKey, sourceCount + 1);
      if (dedupeKey) seen.add(dedupeKey);

      if (streams.length >= maxStreams) break;
    }

    return streams;
  }

  private async decorateWithDebrid(
    streams: SourceStream[],
    options?: SourceFetchOptions
  ): Promise<void> {
    const hashToStreams = new Map<string, SourceStream[]>();

    for (const stream of streams) {
      const hash = this.getStreamInfoHash(stream);
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
      return;
    }

    let cachedHashes = new Set<string>();
    try {
      cachedHashes = await this.fetchDebridCachedHashes([...hashToStreams.keys()], options);
    } catch {
      cachedHashes = new Set<string>();
    }

    const badgeProvider =
      options?.debridProvider ?? (options?.torboxToken && !options?.realdebridToken ? 'torbox' : 'realdebrid');

    for (const [hash, relatedStreams] of hashToStreams.entries()) {
      const isCached = cachedHashes.has(hash);
      for (const s of relatedStreams) {
        s.cached = isCached;
        if (isCached) {
          this.applyDebridBadge(s, badgeProvider);
        }
      }
    }
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
  private getStreamInfoHash(stream: SourceStream): string | undefined {
    if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
      return stream.infoHash.trim().toLowerCase();
    }

    if (typeof stream.magnet === 'string' && stream.magnet.startsWith('magnet:')) {
      const extracted = this.extractInfoHash(stream.magnet);
      if (extracted) {
        return extracted.toLowerCase();
      }
    }

    return undefined;
  }

  private applyDebridBadge(stream: SourceStream, provider: 'realdebrid' | 'torbox'): void {
    if (!stream) return;
  
    if (typeof stream.name === 'string' && stream.name.length > 0) {
      const nameLines = stream.name.split('\n');
      const firstLine = nameLines[0] ?? '';
  
      let cleaned = firstLine
        .replace(/\[RD\]/gi, '')
        .replace(/RD\+/gi, '')
        .replace(/\bRD\b/gi, '')
        .replace(/\[TB\]/gi, '')
        .replace(/\[?GuIndex\]?/gi, '')
        .trim();
        
      if (!cleaned) cleaned = 'GuIndex';
  
      const qualityStr = nameLines.slice(1).join('\n');
  
      if (provider === 'torbox') {
        stream.name = `[TB] ${cleaned}\n${qualityStr}`.trim();
      } else {
        stream.name = `[RD+] ${cleaned}\n${qualityStr}`.trim();
      }
    }
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
      return this.normalizeTorrentPayload(payload);
    } catch {
      return [];
    }
  }

  private hasSufficientResults(results: TorrentLike[], query: string, context: MatchContext): boolean {
    if (results.length === 0) return false;
    
    const relevantResults = results.filter(r => this.isRelevantTorrent(r, context));
    
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
        const normalized = this.normalizeIndexerSlug(name);
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

    const ranked = this.rankTorrentsByQuery(merged, query);
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
      const catalog = this.parseIndexerCatalog(payload);
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

  private parseIndexerCatalog(payload: Record<string, unknown>): IndexerCatalog | undefined {
    const ts = Date.now();
    if (payload?.api_version === 2 && Array.isArray(payload.indexers)) {
      const indexers: IndexerCapability[] = [];
      for (const raw of payload.indexers) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = raw as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        if (!name) continue;
        indexers.push({
          name,
          supportsText: typeof rec.supports_text === 'boolean' ? rec.supports_text : undefined,
          supportsImdb: typeof rec.supports_imdb === 'boolean' ? rec.supports_imdb : undefined,
          healthy: rec.healthy !== false,
        });
      }
      const features = payload.features as Record<string, unknown> | undefined;
      return {
        ts,
        indexers,
        multi: typeof features?.multi === 'boolean' ? features.multi : undefined,
      };
    }

    const names = payload?.indexer_names;
    if (!Array.isArray(names)) {
      return undefined;
    }
    return {
      ts,
      indexers: names
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => ({ name: name.trim(), healthy: true })),
      multi: false,
    };
  }

  private getIndexerCapability(indexerName: string): IndexerCapability | undefined {
    const slug = this.normalizeIndexerSlug(indexerName);
    return TorrentIndexerProvider.indexerCatalogCache?.indexers.find(
      (c) => this.normalizeIndexerSlug(c.name) === slug,
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
      const ranked = this.rankTorrentsByQuery(searchResults, primaryQuery);
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

    const merged = this.rankTorrentsByQuery(
      this.mergeTorrentResults(searchResults, indexerResults),
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
          return this.normalizeTorrentPayload(await response.body.json());
        } catch {
          return [];
        }
      }),
    );

    // Em ordem de query (IMDb primeiro), sem repetir torrent
    return settled.reduce<TorrentLike[]>((acc, items) => this.mergeTorrentResults(acc, items), []);
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
          const slug = this.normalizeIndexerSlug(name);
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
      this.recordMultiCalls(calls);

      const results = this.normalizeTorrentPayload(payload);
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
      return this.rankTorrentsByQuery(results, queries[0] ?? '');
    } catch (err) {
      logReq(context, `⚠️ Multi-Search falhou: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Alimenta o histórico local (prioridade e cooldown) com o resultado de cada sub-chamada. */
  private recordMultiCalls(calls: MultiCall[]): void {
    for (const call of calls) {
      if (typeof call.indexer !== 'string' || !call.indexer) continue;
      const slug = this.normalizeIndexerSlug(call.indexer);
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
      }
      // timeout: a sub-chamada segue rodando no servidor e ainda vai para o cache dele
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
            const key = this.getTorrentDedupKey(torrent);
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

    return this.rankTorrentsByQuery(merged, queries[0] ?? '');
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
      const results = this.normalizeTorrentPayload(payload);
      this.clearIndexerFailure(normalizedIndexer);
      this.recordIndexerPerformance(normalizedIndexer, Date.now() - startedAt, results.length);
      return results;
    } catch {
      this.recordIndexerFailure(normalizedIndexer);
      this.recordIndexerPerformance(normalizedIndexer, Date.now() - startedAt, 0);
      return [];
    }
  }

  private buildSearchRetryQueries(query: string): string[] {
    const base = this.sanitizeQuery(query);
    if (!base) {
      return [query];
    }

    const variants: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned) {
        return;
      }
      if (!variants.includes(cleaned)) {
        variants.push(cleaned);
      }
    };

    add(base);

    if (!/^tt\d+$/i.test(base)) {
      const withoutEpisode = base
        .replace(/\bS\d{1,3}E\d{1,3}\b/gi, ' ')
        .replace(/\b\d{1,3}x\d{1,3}\b/gi, ' ')
        .replace(/\b(?:epis[oó]dio|episodio|episode|ep|cap[ií]tulo|capitulo|cap)\.?\s*\d{1,3}\b/gi, ' ')
        .replace(/\b(?:temporada|season|temp\.?|t)\s*\d{1,3}\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      add(withoutEpisode);

      const withoutYear = base.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
      add(withoutYear);
    }

    return variants.slice(0, 4);
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
    const slugA = this.normalizeIndexerSlug(a);
    const slugB = this.normalizeIndexerSlug(b);
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
      const normalized = this.normalizeIndexerSlug(raw);
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
        const slug = this.normalizeIndexerSlug(name);
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

  private normalizeIndexerSlug(value: string): string {
    const cleaned = this.sanitizeQuery(value)?.toLowerCase() ?? value.toLowerCase();
    return cleaned
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]+/g, '')
      .trim();
  }

  private shouldSkipIndexer(indexerName: string): boolean {
    const slug = this.normalizeIndexerSlug(indexerName);
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

  private rankTorrentsByQuery(results: TorrentLike[], query: string): TorrentLike[] {
    if (results.length <= 1) {
      return results;
    }

    return [...results].sort((a, b) => this.scoreTorrentForQuery(b, query) - this.scoreTorrentForQuery(a, query));
  }

  private hasStrongQueryMatch(results: TorrentLike[], query: string): boolean {
    if (results.length === 0) {
      return false;
    }

    const imdbQuery = /^tt\d+$/i.test(query.trim());
    const threshold = imdbQuery ? 85 : 52;
    const candidates = results.slice(0, 40);
    return candidates.some((torrent) => this.scoreTorrentForQuery(torrent, query) >= threshold);
  }

  private scoreTorrentForQuery(torrent: TorrentLike, query: string): number {
    const record = torrent as Record<string, unknown>;
    let score = 0;
    const rawQuery = query.trim();
    const rawTitle = this.extractTitle(torrent) ?? '';
    const rawOriginalTitle = this.toString(record.original_title) ?? '';
    const normalizedTitle = this.normalizeLooseText(`${rawTitle} ${rawOriginalTitle}`);

    const similarity = this.toNumber(record.similarity);
    if (similarity !== undefined) {
      score += Math.max(0, similarity) * 25;
    }

    const seeds = this.toNumber(record.seed_count ?? record.seeders ?? record.seeds);
    if (seeds !== undefined && seeds > 0) {
      score += Math.min(seeds, 200) / 20;
    }

    if (/^tt\d+$/i.test(rawQuery)) {
      const imdb = this.extractImdb(torrent);
      if (imdb && imdb.toLowerCase() === rawQuery.toLowerCase()) {
        score += 120;
      } else {
        score -= 20;
      }
      return score;
    }

    const normalizedQuery = this.normalizeLooseText(rawQuery);
    if (normalizedQuery.length >= 4 && normalizedTitle.includes(normalizedQuery)) {
      score += 55;
    }

    const queryTokens = this.tokenizeQuery(rawQuery);
    if (queryTokens.length > 0) {
      let matchedTokens = 0;
      for (const token of queryTokens) {
        if (normalizedTitle.includes(token)) {
          matchedTokens += 1;
        }
      }

      score += matchedTokens * 10;
      score += (matchedTokens / queryTokens.length) * 45;

      if (matchedTokens === 0) {
        score -= 15;
      }
    }

    const yearMatch = rawQuery.match(/\b((?:19|20)\d{2})\b/);
    if (yearMatch?.[1]) {
      if (new RegExp(`\\b${yearMatch[1]}\\b`).test(rawTitle) || new RegExp(`\\b${yearMatch[1]}\\b`).test(rawOriginalTitle)) {
        score += 8;
      } else {
        score -= 2;
      }
    }

    const querySeasonEpisode = this.extractSeasonEpisodeFromText(rawQuery);
    if (querySeasonEpisode.season !== undefined) {
      const titleSeasonEpisode = this.extractSeasonEpisodeFromText(rawTitle);
      if (titleSeasonEpisode.season !== undefined) {
        if (titleSeasonEpisode.season === querySeasonEpisode.season) {
          score += 14;
        } else {
          score -= 12;
        }
      }

      if (querySeasonEpisode.episode !== undefined && titleSeasonEpisode.episode !== undefined) {
        if (titleSeasonEpisode.episode === querySeasonEpisode.episode) {
          score += 18;
        } else {
          score -= 15;
        }
      }
    }

    if (/\[unsafe\]/i.test(rawTitle)) {
      score -= 6;
    }

    return score;
  }

  private normalizeLooseText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenizeQuery(value: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'da', 'de', 'do', 'dos', 'das', 'e',
      'temporada', 'season', 'episodio', 'episodio', 'episode', 'parte', 'part',
    ]);

    return this.normalizeLooseText(value)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !stopWords.has(token));
  }

  private extractSeasonEpisodeFromText(value: string): { season?: number; episode?: number } {
    const text = value.toLowerCase();
    const sxe = text.match(/s(\d{1,3})e(\d{1,3})/i);
    if (sxe?.[1] && sxe?.[2]) {
      return { season: Number(sxe[1]), episode: Number(sxe[2]) };
    }

    const xFormat = text.match(/(\d{1,3})x(\d{1,3})/i);
    if (xFormat?.[1] && xFormat?.[2]) {
      return { season: Number(xFormat[1]), episode: Number(xFormat[2]) };
    }

    const season = text.match(/(?:temporada|season|temp\.?|t)\s*(\d{1,3})/i);
    const episode = text.match(/(?:epis[oó]dio|episodio|episode|ep|cap[ií]tulo|capitulo|cap\.?)[\s._-]*(\d{1,3})/i);

    return {
      season: season?.[1] ? Number(season[1]) : undefined,
      episode: episode?.[1] ? Number(episode[1]) : undefined,
    };
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

  private mergeTorrentResults(primary: TorrentLike[], secondary: TorrentLike[]): TorrentLike[] {
    if (secondary.length === 0) {
      return [...primary];
    }

    const merged = [...primary];
    const seen = new Set<string>();

    for (const torrent of primary) {
      seen.add(this.buildTorrentMergeKey(torrent));
    }

    for (const torrent of secondary) {
      const key = this.buildTorrentMergeKey(torrent);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(torrent);
    }

    return merged;
  }

  private buildTorrentMergeKey(torrent: TorrentLike): string {
    const record = torrent as Record<string, unknown>;
    const magnet = this.toString(record.magnet_link) || this.toString(record.magnet);
    if (magnet) {
      return `magnet:${magnet}`;
    }

    const hash =
      this.toString(record.info_hash) ||
      this.toString(record.infoHash) ||
      this.toString(record.hash) ||
      this.toString(record.btih);
    if (hash) {
      return `hash:${hash.toLowerCase()}`;
    }

    const details = this.toString(record.details) || this.toString(record.url) || this.toString(record.link);
    if (details) {
      return `details:${details}`;
    }

    const title = this.toString(record.title) || this.toString(record.original_title) || this.toString(record.name) || '';
    const size = this.toString(record.size) || this.toString(record.size_bytes) || '';
    return `title:${title.toLowerCase()}|size:${size}`;
  }

  private parseId(id: string): ParsedIdInfo {
    const parts = (id || '').split(':');
    const rawId = parts[0] ?? '';
    const season = parts[1];
    const episode = parts[2];

    const info: ParsedIdInfo = {};

    if (/^tt\d+$/.test(rawId)) {
      info.imdbId = rawId;
    } else {
      const sanitizedQuery = this.sanitizeQuery(rawId);
      if (sanitizedQuery) {
        info.query = sanitizedQuery;
      }
    }

    if (season !== undefined) {
      const parsedSeason = Number(season);
      if (!Number.isNaN(parsedSeason)) {
        info.season = parsedSeason;
      }
    }

    if (episode !== undefined) {
      const parsedEpisode = Number(episode);
      if (!Number.isNaN(parsedEpisode)) {
        info.episode = parsedEpisode;
      }
    }

    return info;
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
          this.toString(entry.title),
          this.toString(entry.name),
          this.toString(entry.original_title),
          this.toString(entry.original_name),
        ];

        for (const candidate of candidates) {
          const label = this.sanitizeQuery(candidate ?? '');
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

  private buildTextQuery(
    type: string,
    parsed: ParsedIdInfo,
    targetTitle?: string,
    releaseYear?: number,
    episodeTitle?: string,
  ): string | undefined {
    if (!targetTitle && parsed.query) {
      return parsed.query;
    }

    if (!targetTitle) {
      return undefined;
    }

    if (type.toLowerCase() === 'movie') {
      if (releaseYear) {
        return `${targetTitle} ${releaseYear}`;
      }
      return targetTitle;
    }

    if (parsed.season !== undefined) {
      const seasonPart = `temporada ${parsed.season}`;
      if (parsed.episode !== undefined) {
        const episodePart = `episodio ${parsed.episode}`;
        return `${targetTitle} ${seasonPart} ${episodePart}`;
      }
      if (releaseYear) {
        return `${targetTitle} ${seasonPart} ${releaseYear}`;
      }
      return `${targetTitle} ${seasonPart}`;
    }

    if (episodeTitle) {
      return `${targetTitle} ${episodeTitle}`;
    }

    return targetTitle;
  }

  private buildTextQueryCandidates(
    type: string,
    parsed: ParsedIdInfo,
    targetTitles: string[],
    releaseYear?: number,
    episodeTitle?: string,
  ): string[] {
    const out: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned) {
        return;
      }
      if (!out.includes(cleaned)) {
        out.push(cleaned);
      }
    };

    if (parsed.query) {
      add(parsed.query);
    }

    const seenTitles = Array.from(new Set(targetTitles.map((t) => this.sanitizeQuery(t)).filter(Boolean) as string[]));
    const limitedTitles = seenTitles.slice(0, 6);

    // Extracao de todas as variantes de titulos
    const allTitles: string[] = [];
    for (const baseTitle of limitedTitles) {
      allTitles.push(...this.buildLocaleTitleVariants(baseTitle).slice(0, 5));
    }
    const uniqueTitles = [...new Set(allTitles)];

    if (type.toLowerCase() === 'movie') {
      uniqueTitles.forEach(title => add(title));
      if (releaseYear) {
        uniqueTitles.forEach(title => add(`${title} ${releaseYear}`));
      }
    } else {
      // SERIES - Ordem otimizada por estilo para alternar entre idiomas!
      const s = parsed.season;
      const e = parsed.episode;
      const sPad = s !== undefined ? String(s).padStart(2, '0') : undefined;
      const ePad = e !== undefined ? String(e).padStart(2, '0') : undefined;

      // Estilo 1: SxxEyy (Ex: Invencivel S02E03, Invincible S02E03)
      if (sPad !== undefined && ePad !== undefined) {
        uniqueTitles.forEach(title => add(`${title} S${sPad}E${ePad}`));
      }

      // Estilo 2: Sxx (Packs de Temporada)
      if (sPad !== undefined) {
        uniqueTitles.forEach(title => add(`${title} S${sPad}`));
      }

      // Estilo 3: temporada x
      if (s !== undefined) {
        uniqueTitles.forEach(title => add(`${title} temporada ${s}`));
      }

      // Estilo 4: temporada x episodio y
      if (s !== undefined && e !== undefined) {
        uniqueTitles.forEach(title => add(`${title} temporada ${s} episodio ${e}`));
      }

      // Estilo 5: Titulo + Nome do Episodio
      if (episodeTitle) {
        uniqueTitles.forEach(title => add(`${title} ${episodeTitle}`));
      }

      // Estilo 6: Titulo Puro (Ex: Invencivel, Invincible) - Fallback Universal
      uniqueTitles.forEach(title => add(title));

      // Estilo 7: Titulo + Ano
      if (releaseYear) {
        uniqueTitles.forEach(title => add(`${title} ${releaseYear}`));
      }
    }

    return out.slice(0, MAX_TEXT_QUERIES);
  }

  private buildLocaleTitleVariants(title: string): string[] {
    const out: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned) {
        return;
      }
      if (!out.includes(cleaned)) {
        out.push(cleaned);
      }
    };

    const base = this.sanitizeQuery(title);
    if (!base) {
      return out;
    }

    const strippedArticle = base
      .replace(/^(the|a|an|o|os|as)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const remainingWords = strippedArticle.split(/\s+/).length;
    if (strippedArticle && strippedArticle !== base && remainingWords >= 2) {
      add(strippedArticle);
    }

    add(base);
    add(base.replace(/[:|]/g, ' '));

    const enToPt: Array<[RegExp, string]> = [
      [/\bpart\s+two\b/gi, 'parte dois'],
      [/\bpart\s+three\b/gi, 'parte tres'],
      [/\bpart\s+one\b/gi, 'parte um'],
      [/\bpart\s+([0-9]+)\b/gi, 'parte $1'],
      [/\bchapter\b/gi, 'capitulo'],
      [/\bthe\b/gi, ''],
    ];

    const ptToEn: Array<[RegExp, string]> = [
      [/\bparte\s+dois\b/gi, 'part two'],
      [/\bparte\s+tres\b/gi, 'part three'],
      [/\bparte\s+um\b/gi, 'part one'],
      [/\bparte\s+([0-9]+)\b/gi, 'part $1'],
      [/\bcapitulo\b/gi, 'chapter'],
    ];

    let ptVariant = base;
    for (const [regex, replacement] of enToPt) {
      ptVariant = ptVariant.replace(regex, replacement);
    }
    add(ptVariant);

    let enVariant = base;
    for (const [regex, replacement] of ptToEn) {
      enVariant = enVariant.replace(regex, replacement);
    }
    add(enVariant);

    return out;
  }

  private collectDynamicQueryCandidates(
    type: string,
    parsed: ParsedIdInfo,
    torrents: TorrentLike[],
    releaseYear?: number,
    episodeTitle?: string,
  ): string[] {
    const out: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned || cleaned.length < 3 || cleaned.length > 140) {
        return;
      }
      if (!out.includes(cleaned)) {
        out.push(cleaned);
      }
    };

    const topTorrents = torrents.slice(0, 40);
    const titles: string[] = [];

    for (const torrent of topTorrents) {
      const collected = this.collectTorrentTitles(torrent);
      for (const title of collected) {
        if (/(1080p|720p|2160p|4k|x264|h264|x265|hevc|bluray|web-dl|webrip|hdtv|camrip|dublado|legendado|dual\s*audio|remux)/i.test(title)) {
          continue;
        }

        if (!titles.includes(title)) {
          titles.push(title);
        }
      }
      if (titles.length >= 18) {
        break;
      }
    }

    for (const rawTitle of titles.slice(0, 12)) {
      const localized = this.buildLocaleTitleVariants(rawTitle).slice(0, 4);
      for (const title of localized) {
        add(title);
        if (type.toLowerCase() === 'movie') {
          if (releaseYear) {
            add(`${title} ${releaseYear}`);
          }
          continue;
        }

        if (parsed.season !== undefined) {
          const season = parsed.season;
          const seasonPadded = String(season).padStart(2, '0');
          add(`${title} temporada ${season}`);
          add(`${title} season ${season}`);
          add(`${title} S${seasonPadded}`);

          if (parsed.episode !== undefined) {
            const episode = parsed.episode;
            const episodePadded = String(episode).padStart(2, '0');
            add(`${title} temporada ${season} episodio ${episode}`);
            add(`${title} season ${season} episode ${episode}`);
            add(`${title} S${seasonPadded}E${episodePadded}`);
            add(`${title} ${season}x${episodePadded}`);
          }
        }

        if (episodeTitle) {
          add(`${title} ${episodeTitle}`);
        }
      }
    }

    return out.slice(0, MAX_DYNAMIC_QUERIES);
  }

  private isRelevantTorrent(torrent: TorrentLike, context: MatchContext): boolean {
    const { parsed, type, targetTitles, releaseYear } = context;
    const normalizedType = type.toLowerCase();
    const imdb = this.extractImdb(torrent);

    if (parsed.imdbId && !imdb && targetTitles.length === 0) {
      return false;
    }

    if (!parsed.imdbId || !imdb) {
      const torrentTitles = this.collectTorrentTitles(torrent);
      if (targetTitles.length > 0 && torrentTitles.length > 0) {
        const normalizedTargets = targetTitles
          .map((title) => this.normalizeForComparison(title))
          .filter((title) => title.length >= 3);
        const normalizedAlphabeticTargets = normalizedTargets.filter((title) => /[a-z]/.test(title));
        const effectiveTargets =
          normalizedAlphabeticTargets.length > 0 ? normalizedAlphabeticTargets : normalizedTargets;

        if (effectiveTargets.length === 0) {
          return false;
        }

        const normalizedTorrentTitles = torrentTitles.map((title) => this.normalizeForComparison(title));

        const matchesTitle = normalizedTorrentTitles.some((torrentTitle) =>
          effectiveTargets.some((targetTitle) =>
            torrentTitle.includes(targetTitle) || targetTitle.includes(torrentTitle),
          ),
        );

        if (!matchesTitle) {
          return false;
        }
      }
    } else if (imdb.toLowerCase() !== parsed.imdbId.toLowerCase()) {
      return false;
    }

    if (normalizedType === 'movie') {
      if (this.hasEpisodePattern(torrent)) {
        return false;
      }
      if (releaseYear !== undefined) {
        const torrentYear = this.extractYear(torrent);
        if (torrentYear !== undefined && Math.abs(torrentYear - releaseYear) > 1) {
          return false;
        }
      }
    }

    if (normalizedType !== 'movie' && parsed.season !== undefined) {
      const texts = this.collectSearchableTexts(torrent);

      if (this.isCompleteSeriesPack(texts)) {
        // falls through
      } else {
        const range = this.extractSeasonRangeFromTexts(texts);
        if (range) {
          if (parsed.season < range.start || parsed.season > range.end) {
            return false;
          }
        } else {
          const torrentSeason = this.extractSeasonFromTorrent(torrent);
          if (torrentSeason !== undefined && torrentSeason !== parsed.season) {
            return false;
          }

          if (torrentSeason === undefined) {
            const files = this.extractFilesFromTorrent(torrent);
            if (files.length > 0) {
              const fileSeasonsSet = new Set<number>();
              for (const file of files) {
                const fs = this.extractSeasonFromTorrent({ title: file.path });
                if (fs !== undefined) fileSeasonsSet.add(fs);
              }
              if (fileSeasonsSet.size > 0 && !fileSeasonsSet.has(parsed.season)) {
                return false;
              }
            }
          }
        }
      }

      if (parsed.episode !== undefined) {
        // Faixa ou lista no nome do release ("S02E01-E05", "Episódios 06 ao 13")
        // decide sozinha; sem ela, vale o primeiro episódio achado nos textos.
        const titleEpisodes = this.extractEpisodeSetFromTitles(torrent);
        if (titleEpisodes) {
          return titleEpisodes.has(parsed.episode);
        }
        const torrentEpisode = this.extractEpisodeFromTorrent(torrent);
        if (torrentEpisode !== undefined && torrentEpisode !== parsed.episode) {
          return false;
        }
        const episodeList = this.extractEpisodeList(torrent);
        if (episodeList && episodeList.length > 0 && !episodeList.includes(parsed.episode)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Episódios que o nome do release cobre: "S02E01-E05", "S02E01-05", "S02E01 ao E05",
   * "S02E01E02E03", "Episódios 06 ao 13", "Episódio 03 e 04", ou um só ("S02E03", "2x03").
   * Lê o texto cru, antes de "-" virar espaço. Sem episódio no nome (pack de temporada),
   * devolve undefined.
   */
  private extractEpisodeSetFromTitles(torrent: TorrentLike): Set<number> | undefined {
    const record = torrent as Record<string, unknown>;
    const titles = [record.title, record.original_title, record.name, record.filename, record.release]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const episodes = new Set<number>();
    const addRange = (start: number, end: number) => {
      if (start > 0 && end >= start && end - start <= 60) {
        for (let i = start; i <= end; i++) episodes.add(i);
      }
    };

    for (const raw of titles) {
      const text = raw.replace(/[._]/g, ' ');
      for (const m of text.matchAll(/S\d{1,2}\s?E(\d{1,3})\s*(?:-|a|ao|à|até)\s*E?(\d{1,3})\b/gi)) {
        addRange(Number(m[1]), Number(m[2]));
      }
      for (const m of text.matchAll(/S\d{1,2}((?:E\d{1,3}){2,})/gi)) {
        for (const ep of m[1]?.match(/\d{1,3}/g) ?? []) episodes.add(Number(ep));
      }
      const spaced = text.replace(/-/g, ' - ');
      for (const m of spaced.matchAll(/\bep(?:is[oó]dios?|s?)\s*(\d{1,3})\s*(-|a|ao|à|até|e)\s*(\d{1,3})\b/gi)) {
        if (m[2]?.toLowerCase() === 'e') {
          episodes.add(Number(m[1]));
          episodes.add(Number(m[3]));
        } else {
          addRange(Number(m[1]), Number(m[3]));
        }
      }
    }
    if (episodes.size > 0) return episodes;

    for (const raw of titles) {
      const text = raw.replace(/[._]/g, ' ');
      const single = /S\d{1,2}\s?E(\d{1,3})\b|\b\d{1,2}x(\d{1,3})\b|\bep(?:is[oó]dio|\.)?\s*(\d{1,3})\b/i.exec(text);
      const value = single ? Number(single[1] ?? single[2] ?? single[3]) : NaN;
      if (value > 0) return new Set([value]);
    }
    return undefined;
  }

  /**
   * Para filmes: o torrent parece de série? Só olha campos estruturados e os títulos
   * do release; descrição, detalhes e slug citam "temporada", "coleção" e
   * "episódio" em sinopses de filme.
   */
  private hasEpisodePattern(torrent: TorrentLike): boolean {
    if (this.extractSeason(torrent) !== undefined || this.extractEpisode(torrent) !== undefined) {
      return true;
    }

    const record = torrent as Record<string, unknown>;
    return [record.title, record.original_title]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => this.normalizeEpisodeMetadata(value))
      .some((value) => value !== undefined && STRONG_EPISODE_REGEX.test(value));
  }

  private normalizeEpisodeMetadata(value: string): string | undefined {
    let normalized = value;
    try {
      normalized = decodeURIComponent(value);
    } catch {
      normalized = value;
    }

    normalized = normalized.replace(/https?:\/\/[^/]+/gi, ' ');
    normalized = normalized.replace(/[/_.\-+]/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return undefined;
    }

    return normalized.toLowerCase();
  }

  private extractImdb(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.imdb),
      this.toString(record.imdbId),
      this.toString(record.imdb_id),
      this.toString(record['Imdb']),
      this.toString(record['IMDB']),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (/^tt\d+$/.test(candidate)) {
        return candidate;
      }
      const match = candidate.match(/tt\d+/);
      if (match) {
        return match[0];
      }
    }

    return undefined;
  }

  private collectTorrentTitles(torrent: TorrentLike): string[] {
    const record = torrent as Record<string, unknown>;
    const titles = new Set<string>();

    const add = (value: unknown) => {
      if (typeof value === 'string') {
        const sanitized = this.sanitizeQuery(value);
        if (sanitized) {
          titles.add(sanitized);
        }
      }
    };

    add(record.title);
    add(record.original_title);
    add(record.name);
    add(record.filename);
    add(record.release);
    add(record.file);
    add(record.slug);
    add(record.displayName);

    const extra = record.titles;
    if (Array.isArray(extra)) {
      extra.forEach(add);
    }

    return Array.from(titles);
  }

  private extractYear(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate = record.year ?? record.releaseYear ?? record.release_year ?? record.date;

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string') {
      const match = candidate.match(/\d{4}/);
      if (match) {
        return Number(match[0]);
      }
    }

    const texts = this.collectSearchableTexts(torrent);
    for (const text of texts) {
      if (!text) continue;
      const yearMatch = text.match(/[([.\s]((?:19[5-9]\d|20[0-9]\d))[)\].\s]/)
        ?? text.match(/\b((?:19[5-9]\d|20[0-9]\d))\b/);
      if (yearMatch?.[1]) {
        const y = Number(yearMatch[1]);
        if (y >= 1950 && y <= 2099) return y;
      }
    }

    return undefined;
  }

  private extractSeason(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.season ??
      record.seasonNumber ??
      record.season_number ??
      record.seriesSeason ??
      record['Season'];

    return this.toNumber(candidate);
  }

  private extractEpisode(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.episode ??
      record.episodeNumber ??
      record.episode_number ??
      record.seriesEpisode ??
      record['Episode'];

    return this.toNumber(candidate);
  }

  private collectSearchableTexts(torrent: TorrentLike): string[] {
    const record = torrent as Record<string, unknown>;
    const texts: string[] = [];
    const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) texts.push(v.trim()); };
    add(record.title);
    add(record.original_title);
    add(record.name);
    add(record.filename);
    add(record.release);
    add(record.file);
    add(record.slug);
    add(record.displayName);
    add(record.description);
    add(record.summary);
    add(record.details);
    add(record.category);
    add(record.subcategory);
    const tags = record.tags ?? record.categories;
    if (Array.isArray(tags)) tags.forEach(add);
    return texts;
  }

  private static readonly SEASON_PATTERNS: { regex: RegExp; group: number }[] = [
    { regex: /\bS(\d{1,3})(?:E\d{1,3})?\b/i, group: 1 },
    { regex: /\b(\d{1,2})[x×]\d{1,3}\b/i, group: 1 },
    { regex: /(\d{1,3})[ªºᵃᵒaAoO]\s*temporada/i, group: 1 },
    { regex: /\b(?:temporada|season)\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\btemp\.?\s*(\d{1,3})\b/i, group: 1 },
    { regex: /(\d{1,3})[ªºᵃᵒaAoO]\s*temp\b/i, group: 1 },
    { regex: /(?:^|[\s._\-[(])T(\d{1,2})(?:[\s._\-\])]|$)/i, group: 1 },
    { regex: /\bpack\s+(?:temporada|season|temp\.?)\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\bda\s+(\d{1,3})\s*temporada\b/i, group: 1 },
  ];

  private static readonly SEASON_RANGE_PATTERNS: { regex: RegExp; startGroup: number; endGroup: number }[] = [
    { regex: /(\d{1,3})[ªºᵃᵒaAoO]?\s*(?:a|à|até|ao|~|-)\s*(\d{1,3})[ªºᵃᵒaAoO]?\s*temporada/i, startGroup: 1, endGroup: 2 },
    { regex: /temporadas?\s*(\d{1,3})\s*(?:a|à|até|ao|~|-|e)\s*(\d{1,3})/i, startGroup: 1, endGroup: 2 },
    { regex: /seasons?\s*(\d{1,3})\s*(?:to|through|thru|~|-)\s*(\d{1,3})/i, startGroup: 1, endGroup: 2 },
    { regex: /\bS(\d{1,3})\s*[-~.]\s*S(\d{1,3})\b/i, startGroup: 1, endGroup: 2 },
    { regex: /\bT(\d{1,2})\s*[-~.]\s*T(\d{1,2})\b/i, startGroup: 1, endGroup: 2 },
    { regex: /\btemp\.?\s*(\d{1,3})\s*(?:a|à|até|ao|~|-)\s*(\d{1,3})/i, startGroup: 1, endGroup: 2 },
  ];

  private static readonly COMPLETE_SERIES_PATTERNS: RegExp[] = [
    /\b(?:s[eé]rie|series)\s+completa\b/i,
    /\bcomplete\s+(?:s[eé]rie|series)\b/i,
    /\btodas?\s+(?:as\s+)?temporadas?\b/i,
    /\ball\s+seasons?\b/i,
    /\bcomplete\s+(?:collection|box\s*set|pack)\b/i,
    /\bcole[çc][ãa]o\s+completa\b/i,
    /\bpack\s+completo\b/i,
    /\bintegral\b/i,
    /\bthe\s+complete\s+series\b/i,
    /\bdiscografia\s+completa\b/i,
  ];

  private static readonly EPISODE_PATTERNS: { regex: RegExp; group: number }[] = [
    { regex: /\bS\d{1,3}E(\d{1,3})\b/i, group: 1 },
    { regex: /\b\d{1,2}[x×](\d{1,3})\b/i, group: 1 },
    { regex: /\bep\.?\s*(\d{1,3})\b/i, group: 1 },
    { regex: /(?<!S\d{0,3})\bE(\d{1,3})\b/i, group: 1 },
    { regex: /\b(?:epis[oó]dio|episodio|episode)\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\b(?:cap[ií]tulo|capitulo|cap)\.?\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\bfolge\s*(\d{1,3})\b/i, group: 1 },
    { regex: /#(\d{1,3})\b/, group: 1 },
    { regex: /(?:^|[/\\])0*(\d{1,3})\s*[-._\s]+[A-Za-z]/, group: 1 },
    { regex: /(?:^|[/\\])0*(\d{1,3})\.(mkv|mp4|avi|m4v|ts)$/i, group: 1 },
    { regex: /(?:^|[/\\])\d(\d{2})\s*[-._\s]+[A-Za-z]/, group: 1 },
  ];

  private extractSeasonFromTorrent(torrent: TorrentLike): number | undefined {
    const structured = this.extractSeason(torrent);
    if (structured !== undefined) return structured;

    const texts = this.collectSearchableTexts(torrent);
    for (const text of texts) {
      if (!text) continue;
      for (const { regex, group } of TorrentIndexerProvider.SEASON_PATTERNS) {
        const m = text.match(regex);
        if (m?.[group]) {
          const season = parseInt(m[group], 10);
          if (!isNaN(season) && season > 0 && season < 200) return season;
        }
      }
    }
    return undefined;
  }

  private extractSeasonRangeFromTexts(texts: string[]): { start: number; end: number } | undefined {
    for (const text of texts) {
      if (!text) continue;
      for (const { regex, startGroup, endGroup } of TorrentIndexerProvider.SEASON_RANGE_PATTERNS) {
        const m = text.match(regex);
        if (m?.[startGroup] && m?.[endGroup]) {
          const start = parseInt(m[startGroup], 10);
          const end = parseInt(m[endGroup], 10);
          if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
            return { start, end };
          }
        }
      }
    }
    return undefined;
  }

  private isCompleteSeriesPack(texts: string[]): boolean {
    for (const text of texts) {
      if (!text) continue;
      for (const pattern of TorrentIndexerProvider.COMPLETE_SERIES_PATTERNS) {
        if (pattern.test(text)) return true;
      }
    }
    return false;
  }

  private extractEpisodeFromTorrent(torrent: TorrentLike): number | undefined {
    const structured = this.extractEpisode(torrent);
    if (structured !== undefined) return structured;

    const texts = this.collectSearchableTexts(torrent);
    for (const text of texts) {
      if (!text) continue;
      for (const { regex, group } of TorrentIndexerProvider.EPISODE_PATTERNS) {
        const m = text.match(regex);
        if (m?.[group]) {
          const episode = parseInt(m[group], 10);
          if (!isNaN(episode) && episode > 0 && episode < 2000) return episode;
        }
      }
    }
    return undefined;
  }

  private extractEpisodeList(torrent: TorrentLike): number[] | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      record.episodes,
      record.episodeList,
      record.episode_list,
      record.episodeNumbers,
      record.episode_numbers,
      record.filesEpisodes,
      record.parts,
    ];

    const numbers = new Set<number>();

    const addValue = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        numbers.add(Math.floor(value));
        return;
      }

      if (typeof value === 'string') {
        const matches = value.match(/\d+/g);
        if (matches) {
          matches.forEach((match) => {
            const parsed = Number(match);
            if (!Number.isNaN(parsed)) {
              numbers.add(parsed);
            }
          });
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(addValue);
        return;
      }

      if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
          addValue(item);
        }
      }
    };

    candidates.forEach(addValue);

    if (numbers.size === 0) {
      const texts = this.collectSearchableTexts(torrent);
      for (const text of texts) {
        if (!text) continue;
        const rangeMatch = text.match(/\bE(?:P)?\.?\s*(\d{1,3})\s*[-~]\s*E(?:P)?\.?\s*(\d{1,3})\b/i);
        if (rangeMatch?.[1] && rangeMatch?.[2]) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start && end - start < 100) {
            for (let i = start; i <= end; i++) numbers.add(i);
            break;
          }
        }
        const ptRangeMatch = text.match(/\b(?:epis[oó]dio|episodio|cap[ií]tulo|capitulo)\s*(\d{1,3})\s*(?:a|ao|até|~|-)\s*(\d{1,3})\b/i);
        if (ptRangeMatch?.[1] && ptRangeMatch?.[2]) {
          const start = parseInt(ptRangeMatch[1], 10);
          const end = parseInt(ptRangeMatch[2], 10);
          if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start && end - start < 100) {
            for (let i = start; i <= end; i++) numbers.add(i);
            break;
          }
        }
      }
    }

    if (numbers.size === 0) {
      return undefined;
    }

    return Array.from(numbers).sort((a, b) => a - b);
  }

  private normalizeForComparison(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '')
      .toLowerCase();
  }

  private collectMetaTitles(meta?: CinemetaMeta): string[] {
    if (!meta) {
      return [];
    }

    const titles = new Set<string>();
    const addIfString = (value?: unknown) => {
      if (typeof value === 'string') {
        const sanitized = this.sanitizeQuery(value);
        if (sanitized) {
          titles.add(sanitized);
        }
      }
    };

    const explore = (value: unknown, depth = 0) => {
      if (depth > 3 || !value) {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => explore(item, depth + 1));
        return;
      }

      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const [key, val] of Object.entries(record)) {
          if (/title|name/i.test(key)) {
            if (typeof val === 'string') {
              addIfString(val);
            } else {
              explore(val, depth + 1);
            }
          }
        }
      }
    };

    addIfString(meta.name);
    addIfString(meta.title);
    addIfString(meta.originalTitle);

    const alternativeKeys = ['aliases', 'alternativeTitles', 'alternative_titles', 'aka'];
    for (const key of alternativeKeys) {
      const value = (meta as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        value.forEach(addIfString);
      }
    }

    explore(meta.translations);
    explore(meta.infos);

    return Array.from(titles);
  }

  private extractReleaseYear(meta?: CinemetaMeta): number | undefined {
    if (!meta) {
      return undefined;
    }

    const directYear = (meta.year ?? (meta as Record<string, unknown>).releaseYear ?? (meta as Record<string, unknown>).released) as unknown;
    if (typeof directYear === 'number' && Number.isFinite(directYear)) {
      return directYear;
    }

    if (typeof directYear === 'string') {
      const match = directYear.match(/\d{4}/);
      if (match) {
        return Number(match[0]);
      }
    }

    if (typeof meta.releaseInfo === 'string') {
      const match = meta.releaseInfo.match(/\d{4}/);
      if (match) {
        return Number(match[0]);
      }
    }

    return undefined;
  }

  private findEpisodeTitle(meta: CinemetaMeta | undefined, season: number, episode: number): string | undefined {
    if (!meta || !Array.isArray(meta.videos)) {
      return undefined;
    }

    const match = meta.videos.find((video) => {
      const videoSeason = typeof video.season === 'number' ? video.season : Number(video.season);
      const videoEpisode = typeof video.episode === 'number' ? video.episode : Number(video.episode);
      return videoSeason === season && videoEpisode === episode;
    });

    if (!match) {
      return undefined;
    }

    const candidates = [match.title, match.name];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const sanitized = this.sanitizeQuery(candidate);
      if (sanitized) {
        return sanitized;
      }
    }

    return undefined;
  }

  private mapTorrentToStream(
    torrent: TorrentLike,
    fallbackTitle: string,
    context: MatchContext
  ): SourceStream | undefined {
    if (!torrent || typeof torrent !== 'object') {
      return undefined;
    }

    const magnet = this.extractMagnet(torrent);
    if (!magnet) {
      return undefined;
    }

    const totalSize = this.extractSize(torrent);
    if (typeof totalSize === 'number' && totalSize > 0 && totalSize < TorrentIndexerProvider.MIN_VIDEO_SIZE) {
      return undefined;
    }

    const rawTitle = this.extractTitle(torrent) || fallbackTitle || `${this.name} Torrent`;
    const detailUrl = this.extractDetailUrl(torrent);

    const sourceLabel =
      this.extractSourceDomain(torrent) ||
      this.extractIndexerName(torrent) ||
      this.titleize(this.name);

    const selectedFile = this.selectBestTorrentFile(torrent, context);
    const selectedFileName = selectedFile?.path;
    const fileIdx = selectedFile?.originalIndex;

    let displayTitle: string;
    if (selectedFileName) {
      const basename = selectedFileName.replace(/^.*[\\/]/, '');
      displayTitle = this.cleanIndexerTitle(basename);
    } else {
      displayTitle = this.cleanIndexerTitle(this.buildDisplayTitle(torrent, rawTitle));
    }

    const rawSize = selectedFile?.size ?? this.extractSize(torrent);
    const size = typeof rawSize === 'number' ? rawSize : this.parseSizeString(rawSize);

    const releaseYear = this.extractYear(torrent);

    const seeds = this.extractSeeders(torrent);
    const seedCount = seeds !== undefined ? Math.max(0, Math.floor(seeds)) : 0;

    const infoSegments: string[] = [`Seeders: ${seedCount}`];
    if (size !== undefined && size > 0) {
      infoSegments.push(`Size: ${this.formatSize(size)}`);
    }
    infoSegments.push(`[${sourceLabel}]`);

    const rawQuality =
      (torrent as Record<string, unknown>).quality ||
      (torrent as Record<string, unknown>).resolution ||
      this.inferQualityFromTitle(displayTitle) ||
      this.inferQualityFromTitle(rawTitle);
    const quality = this.normalizeQuality(rawQuality);
    const releaseGroup =
      (torrent as Record<string, unknown>).releaseGroup ||
      (torrent as Record<string, unknown>).group ||
      (torrent as Record<string, unknown>).uploader ||
      (torrent as Record<string, unknown>).source;

    const audioLine = this.formatAudioLine(torrent);
    const languages = this.extractAudioLanguages(torrent);

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
  const indexerSlug = rawIndexer ? this.normalizeIndexerSlug(rawIndexer) : undefined;

  const stream: SourceStream = {
    name: nameLines.join('\n'),
    title: titleLines.join('\n'),
    fileName: this.buildStreamFileName(selectedFileName, rawTitle, displayTitle, torrent),
    source: sourceLabel,
    indexer: indexerSlug,
    magnet,
    cached: false
  };

  if (detailUrl) {
    stream.detailUrl = detailUrl;
  }

  // Nome cru com extensão para behaviorHints.filename; fileName acima é só exibição.
  const releaseName = this.extractReleaseName(torrent, magnet);
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

  const publishDate = this.extractPublishDate(torrent);
  if (publishDate) {
    stream.publishDate = publishDate;
  }

  if (languages.length > 0) {
    stream.languages = languages;
  }

  const infoHash =
    (torrent as Record<string, unknown>).infoHash ||
    (torrent as Record<string, unknown>).info_hash ||
    (torrent as Record<string, unknown>).hash ||
    (torrent as Record<string, unknown>).btih ||
    this.extractInfoHash(magnet);

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
    this.looksLikeSeasonPack(torrent, context)
  ) {
    // Nome sintético só para exibição do episódio
    if (!selectedFileName) {
      const sPad = String(context.parsed.season).padStart(2, '0');
      const ePad = String(context.parsed.episode).padStart(2, '0');
      const cleanTitle = this.cleanIndexerTitle(rawTitle);
      stream.fileName = `${cleanTitle}/S${sPad}E${ePad}.mkv`;
    }
  }

  if (size !== undefined) {
    stream.size = size;
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

  const episodeList = this.extractEpisodeList(torrent);
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

  const similarity = this.toNumber((torrent as Record<string, unknown>).similarity);
  if (similarity !== undefined && similarity > 0) {
    stream.similarity = similarity;
  }

  return stream;
}

  /** Nome do release como publicado: dn do magnet, ou o título sem o sufixo de áudio do torrent-indexer. */
  private extractReleaseName(torrent: TorrentLike, magnet: string): string | undefined {
    const rawTitle = this.extractTitle(torrent)?.trim();
    const title = rawTitle ? this.stripAudioSuffix(rawTitle) : undefined;
    const fromMagnet = this.extractMagnetDisplayName(magnet);
    if (fromMagnet) {
      return this.stripSitePrefix(fromMagnet, title) ?? title ?? fromMagnet;
    }
    return title;
  }

  // Sites que carimbam o próprio domínio no início do dn: "BAIXARAPIDO.COM-.EPISODIO-01-E-02.WEB-DL...-.Show.S01E01-02.1080p".
  private static readonly SITE_PREFIX =
    /^[\s[({]*(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|biz|tv|me|cc|to|io|ru|xyz|site|online|top|vip|club|lol|link)(?:\.br)?(?![a-z0-9])/i;

  /**
   * Corta o carimbo de site do dn, mantendo o nome do release que vem depois dele.
   * O release começa onde aparece o início do título; sem esse ponto, devolve undefined.
   */
  private stripSitePrefix(displayName: string, title: string | undefined): string | undefined {
    const prefix = displayName.match(TorrentIndexerProvider.SITE_PREFIX);
    if (!prefix) {
      return displayName;
    }
    const tokens = (title ?? '').split(/[\s._-]+/).filter(Boolean);
    const anchorTokens = (tokens[0]?.length ?? 0) >= 3 ? tokens.slice(0, 1) : tokens.slice(0, 2);
    if (anchorTokens.length === 0) {
      return undefined;
    }
    const escaped = anchorTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const anchor = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escaped.join('[\\s._-]+')})(?![\\p{L}\\p{N}])`, 'iu');
    const rest = displayName.slice(prefix[0].length);
    const match = anchor.exec(rest);
    if (!match || match.index === undefined) {
      return undefined;
    }
    const start = match.index + match[0].length - (match[1] ?? '').length;
    return rest.slice(start).trim() || undefined;
  }

  private extractMagnetDisplayName(magnet: string): string | undefined {
    const query = magnet.split('?')[1];
    if (!query) {
      return undefined;
    }
    try {
      return new URLSearchParams(query).get('dn')?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // Códigos que o torrent-indexer anexa ao título em appendAudioISO639_2Code: "Nome (brazilian, eng)".
  private static readonly AUDIO_SUFFIX_CODES = new Set([
    'brazilian', 'eng', 'spa', 'fra', 'deu', 'ita', 'jpn', 'kor', 'chi', 'yue', 'rus', 'swe', 'srb', 'ukr',
    'pol', 'tha', 'tur', 'hin', 'hun', 'fas', 'msa', 'nld', 'fin', 'dan', 'nor', 'isl', 'ell', 'ara', 'heb',
    'vie', 'ind', 'fil', 'ben', 'tam', 'tel', 'guj', 'mar',
  ]);

  private stripAudioSuffix(title: string): string {
    // Às vezes o sufixo vem repetido: "Nome (brazilian) (brazilian)".
    let stripped = title;
    for (;;) {
      const match = stripped.match(/\s*\(([^()]*)\)\s*$/);
      if (!match || match.index === undefined) {
        return stripped;
      }
      const codes = (match[1] ?? '').split(',').map((code) => code.trim()).filter(Boolean);
      const isAudioSuffix = codes.length > 0 && codes.every((code) => TorrentIndexerProvider.AUDIO_SUFFIX_CODES.has(code));
      if (!isAudioSuffix) {
        return stripped;
      }
      stripped = stripped.slice(0, match.index).trim();
    }
  }

  /** Data de publicação em ISO 8601; ignora datas zero do Go (0001-01-01) e valores inválidos. */
  private extractPublishDate(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate = record.date ?? record.publishDate ?? record.publish_date ?? record.pubDate;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      return undefined;
    }
    const time = new Date(candidate).getTime();
    if (!Number.isFinite(time) || time <= 0) {
      return undefined;
    }
    return new Date(time).toISOString();
  }

  /**
   * Build a proper folder/file path for AIOStreams display.
   * When a file was selected from a pack, ensures the path includes a folder prefix
   * so AIOStreams can show: 📁 Folder Name / 📄 filename.mkv
   */
  private buildStreamFileName(
    selectedFilePath: string | undefined,
    rawTorrentTitle: string,
    displayTitle: string,
    torrent: TorrentLike
  ): string {
    const fallback = displayTitle || this.extractFileName(torrent) || rawTorrentTitle;

    if (!selectedFilePath) {
      // No file selected from a pack — return clean title (likely a single-file torrent)
      return fallback;
    }

    // If the path already has a folder prefix (contains / or \), use it as-is
    if (/[/\\]/.test(selectedFilePath)) {
      return selectedFilePath;
    }

    // The file path is just a bare filename (e.g. "2 - Sick.mp4").
    // Prepend the torrent title as a folder name so AIOStreams shows:
    //   📁 The Walking Dead 3ª Temporada (2012)
    //   📄 2 - Sick.mp4
    const folderName = this.cleanIndexerTitle(rawTorrentTitle)
      .replace(/\.(mkv|mp4|avi|m4v|ts|m2ts|iso)$/i, '') // remove extension if present
      .replace(/[<>:"|?*]/g, '') // remove invalid path chars
      .trim();

    if (folderName) {
      return `${folderName}/${selectedFilePath}`;
    }

    return selectedFilePath;
  }

  /**
   * Detect whether a torrent looks like a full-season pack without individual file listings.
   * This is used to decide whether to build a synthetic episode fileName for display.
   */
  private looksLikeSeasonPack(torrent: TorrentLike, context: MatchContext): boolean {
    // If the API already gave us files, selectBestTorrentFile handled it
    const filesRaw = (torrent as Record<string, unknown>).files;
    if (Array.isArray(filesRaw) && filesRaw.length > 0) {
      return false;
    }

    const texts = this.collectSearchableTexts(torrent);
    const combined = texts.join(' ');

    // Check if this looks like a complete series or multi-season pack
    if (this.isCompleteSeriesPack(texts)) {
      return true;
    }

    // Check for season ranges
    const range = this.extractSeasonRangeFromTexts(texts);
    if (range && context.parsed.season !== undefined) {
      return context.parsed.season >= range.start && context.parsed.season <= range.end;
    }

    // Check if title mentions a season but NOT a specific single episode
    const hasSeason = /\b(temporada|season|S\d{1,2}(?!E\d)|T\d{1,2}|\d{1,2}[ªºa]\s*temp)/i.test(combined);
    const hasSingleEp = /\bS\d{1,3}E\d{1,3}\b/i.test(combined) ||
      /\b\d{1,2}[x×]\d{1,3}\b/i.test(combined) ||
      /\bE(?:P)?\.?\s*\d{1,3}\b/i.test(combined);

    // It's a pack if it mentions a season but not a specific episode
    return hasSeason && !hasSingleEp;
  }

  private buildDisplayTitle(torrent: TorrentLike, fallbackTitle: string): string {
    let title = fallbackTitle;

    const extracted = this.extractTitle(torrent);
    if (extracted && extracted.trim()) {
      title = extracted.trim();
    }

    const year = this.extractYear(torrent);
    if (year !== undefined && !new RegExp(`\\b${year}\\b`).test(title)) {
      title = `${title} (${year})`;
    }

    const season = this.extractSeasonFromTorrent(torrent);
    if (season !== undefined) {
      const seasonToken = `S${String(season).padStart(2, '0')}`;
      const episode = this.extractEpisodeFromTorrent(torrent);
      const episodeToken = episode !== undefined ? `E${String(episode).padStart(2, '0')}` : undefined;
      const code = episodeToken ? `${seasonToken}${episodeToken}` : seasonToken;

      if (!new RegExp(seasonToken, 'i').test(title) && (!episodeToken || !new RegExp(episodeToken, 'i').test(title))) {
        title = `${title} ${code}`;
      }
    }

    return title;
  }

  private normalizeQuality(quality: unknown): string | undefined {
    if (typeof quality !== 'string') {
      return undefined;
    }

    const trimmed = quality.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/\b(4k|UHD|2160p)\b/i.test(trimmed)) return '4K';
    if (/\b(FHD|FULLHD)\b/i.test(trimmed)) return '1080p';
    if (/\bSD\b/i.test(trimmed)) return '480p';

    const match = trimmed.match(/(\d{3,4}p)/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }

    return trimmed.replace(/\s+/g, ' ');
  }

  private formatAudioLine(torrent: TorrentLike): string | undefined {
    const languages = this.extractAudioLanguages(torrent);
    if (languages.length === 0) {
      return undefined;
    }

    const decorated = languages.map((language) => this.mapLanguageToDisplay(language));


    return `${decorated.join(' / ')}`;
  }

  private extractAudioLanguages(torrent: TorrentLike): string[] {
    const record = torrent as Record<string, unknown>;

    // audio[] do torrent-indexer já vem resolvido; sozinho ele basta.
    const fromAudio = languagesFromAudioValues([
      record.audio,
      record.audios,
      record.audio_tracks,
      record.audioTracks,
      record.audio_languages,
      record.audioLanguages,
      record.languages,
      record.language,
      record.lang,
    ]);
    // Nome do release só (sem original_title): original_title é o título da página ("... Dual Áudio") e vale
    // para todos os torrents dela, inclusive releases scene só em inglês; sinopse, slug e categoria idem.
    const releaseText = [record.title, record.name, record.filename, record.release, record.file]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(stripAudioSuffix)
      .join(' ');

    // audio[] vence, mas é conferido com o nome: a fonte às vezes marca Português num release legendado.
    if (fromAudio.length > 0) {
      return reconcileAudioWithRelease(fromAudio, releaseText);
    }

    // Fallback só pelo nome do release.
    return detectReleaseLanguages(releaseText);
  }

  private static readonly MIN_VIDEO_SIZE = 5 * 1024 * 1024; // 5 MB — anything smaller is junk/ads

  private selectBestTorrentFile(torrent: TorrentLike, context: MatchContext): IndexedTorrentFile | undefined {
    const files = this.extractFilesFromTorrent(torrent);
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
    const normalizedPath = this.normalizeForComparison(file.path);
    const normalizedType = context.type.toLowerCase();
    let score = 0;

    // Prefer real video files and penalize common junk files.
    if (this.isVideoPath(file.path)) score += 30;
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
      const normalizedTitle = this.normalizeForComparison(title);
      if (!normalizedTitle) continue;
      if (normalizedPath.includes(normalizedTitle)) {
        score += 10;
        break;
      }
    }

    if (context.releaseYear && normalizedPath.includes(String(context.releaseYear))) {
      score += 6;
    }

    const fileSeason = this.extractSeasonFromTorrent({ title: file.path });
    const fileEpisode = this.extractEpisodeFromTorrent({ title: file.path });
    const episodeList = this.extractEpisodeList({ title: file.path, filesEpisodes: file.path });

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

  private extractFilesFromTorrent(torrent: TorrentLike): IndexedTorrentFile[] {
    const filesRaw = (torrent as Record<string, unknown>).files;
    if (!Array.isArray(filesRaw)) {
      return [];
    }

    const files: IndexedTorrentFile[] = [];
    for (let i = 0; i < filesRaw.length; i++) {
      const entry = filesRaw[i];
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const pathCandidate = this.toString(record.path) || this.toString(record.name) || this.toString(record.file);
      if (!pathCandidate || !pathCandidate.trim()) continue;

      const sizeRaw = record.size ?? record.sizeBytes ?? record.size_bytes ?? record.bytes;
      const size = this.toBytes(sizeRaw);
      files.push({ path: pathCandidate.trim(), size, originalIndex: i });
    }

    return files;
  }

  private toBytes(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const numeric = Number(trimmed.replace(/[^0-9.]/g, ''));
    if (Number.isNaN(numeric)) {
      return undefined;
    }

    if (/\b(tb|terabyte)/i.test(trimmed)) return Math.round(numeric * 1024 * 1024 * 1024 * 1024);
    if (/\b(gb|gigabyte)/i.test(trimmed)) return Math.round(numeric * 1024 * 1024 * 1024);
    if (/\b(mb|megabyte)/i.test(trimmed)) return Math.round(numeric * 1024 * 1024);
    if (/\b(kb|kilobyte)/i.test(trimmed)) return Math.round(numeric * 1024);
    return Math.round(numeric);
  }

  private isVideoPath(path: string): boolean {
    return /\.(mkv|mp4|avi|m4v|ts|m2ts|mov|wmv|flv|webm|mpg|mpeg|iso)$/i.test(path);
  }

  private mapLanguageToDisplay(language: string): string {
    const key = this.normalizeLanguageKey(language);
    return LANGUAGE_FLAG_MAP[key] ?? language;
  }

  private normalizeLanguageKey(language: string): string {
    return language
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  private extractDetailUrl(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.details),
      this.toString(record.detail_url),
      this.toString(record.detailUrl),
      this.toString(record.page),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const normalized = this.normalizeToUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

  private extractFileName(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.filename),
      this.toString(record.file),
      this.toString(record.path),
      this.toString(record.name),
      this.toString(record.title)
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }

      return trimmed;
    }

    return undefined;
  }

  private static readonly SITE_LABEL_MAP: Record<string, string> = {
    'comando.la': 'Comando',
    'comando.to': 'Comando',
    'comandofilmes.net': 'Comando',
    'comandotorrents.com': 'Comando',
    'bludv.xyz': 'BluDV',
    'bludv1.xyz': 'BluDV',
    'bludv.org': 'BluDV',
    'bludv.net': 'BluDV',
    'bludv-v1.xyz': 'BluDV',
    'bludv.tv': 'BluDV',
    'bludv.in': 'BluDV',
    'redetorrent.com': 'Rede Torrent',
    'vacatorrent.com': 'Vaca Torrent',
    'vacatorrentmov.com': 'Vaca Torrent',
    'lapumia.org': 'LAPUMiA',
    'ondebaixa.com': 'Onde Baixa',
    'torrentdosfilmes.se': 'Torrent dos Filmes',
    'torrentdosfilmes.net': 'Torrent dos Filmes',
    'torrentdosfilmes.com': 'Torrent dos Filmes',
    'torrentdosfilmes.tv': 'Torrent dos Filmes',
    'torrentdosfilmes.site': 'Torrent dos Filmes',
    'thepiratefilmes.com': 'The Pirate Filmes',
    'starckfilmes.com': 'Starck Filmes',
    'torrentmovies.co': 'Torrent Movies',
    'sitedetorrents.com': 'Site de Torrents',
    'ytsbr.com': 'YTSBR',
    'limaotorrent.org': 'Limão Torrent',
    'baixarfilmetorrent.net': 'Baixar Filme',
    'thepiratebay.org': 'TPB',
    'rarbg.to': 'RARBG',
    '1337x.to': '1337x',
    'nyaa.si': 'Nyaa',
    'yts.mx': 'YTS',
  };

  private extractSourceDomain(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.details),
      this.toString(record.detail_url),
      this.toString(record.detailUrl),
      this.toString(record.page),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const hostname = this.parseHostname(candidate);
      if (hostname) {
        // Normalize known site hostnames with versioned subdomains
        const baseHost = hostname.replace(/^(www\.)?/, '').replace(/-v\d+/, '').replace(/\d+\./, '.');
        const mapped = TorrentIndexerProvider.SITE_LABEL_MAP[hostname]
          ?? TorrentIndexerProvider.SITE_LABEL_MAP[baseHost];
          
        if (mapped) return mapped;
        
        const domainParts = baseHost.split('.');
        const mainPart = domainParts[0];
        if (mainPart && mainPart.length > 2) {
          return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
        }
        
        return hostname;
      }
    }

    return undefined;
  }

  private normalizeToUrl(raw: string): string | undefined {
    let candidate = raw.trim();
    if (!candidate) {
      return undefined;
    }

    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    try {
      const url = new URL(candidate);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private parseHostname(raw: string): string | undefined {
    let candidate = raw.trim();
    if (!candidate) {
      return undefined;
    }

    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    try {
      const url = new URL(candidate);
      const hostname = url.hostname.replace(/^www\./i, '');
      if (hostname) {
        return hostname.toLowerCase();
      }
    } catch {
      // Ignore invalid URLs
    }

    return undefined;
  }

  private extractIndexerName(torrent: TorrentLike): string | undefined {
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
      const val = candidate.trim();
      
      // Se parecer uma URL ou domínio, tenta tratar como tal primeiro
      if (val.includes('.') || val.includes('/') || val.includes(':')) {
        const hostname = this.parseHostname(val);
        if (hostname) {
          const baseHost = hostname.replace(/^(www\.)?/, '').replace(/-v\d+/, '').replace(/\d+\./, '.');
          const mapped = TorrentIndexerProvider.SITE_LABEL_MAP[hostname]
            ?? TorrentIndexerProvider.SITE_LABEL_MAP[baseHost];
            
          if (mapped) return mapped;
          
          const mainPart = baseHost.split('.')[0];
          if (mainPart && mainPart.length > 2) {
            return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
          }
        }
      }

      const sanitized = this.sanitizeQuery(val) ?? val;
      return this.titleize(sanitized);
    }

    return undefined;
  }

  private formatSize(size: number): string {
    if (!Number.isFinite(size) || size <= 0) {
      return 'Unknown size';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = size;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    if (unitIndex === 0) {
      return `${Math.round(value)} ${units[unitIndex]}`;
    }

    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  private extractMagnet(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const magnet =
      this.toString(record.magnet_link) ||
      this.toString(record.magnet) ||
      this.toString(record.url) ||
      this.toString(record.link);

    if (magnet && magnet.startsWith('magnet:')) {
      return magnet;
    }

    return undefined;
  }

  private extractTitle(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const title =
      this.toString(record.title) ||
      this.toString(record.original_title) ||
      this.toString(record.name) ||
      this.toString(record.filename) ||
      this.toString(record.release) ||
      this.toString(record.file) ||
      this.toString(record.slug) ||
      this.toString(record.displayName);

    if (title && title.trim()) {
      return title.trim();
    }

    return undefined;
  }

  private extractInfoHash(magnet: string): string | undefined {
    const match = magnet.match(/btih:([^&]+)/i);
    return match?.[1];
  }

  /**
   * Clean dirty titles from Brazilian indexer sites.
   * Removes site slug prefixes, double dots, duplicate extensions, etc.
   */
  private cleanIndexerTitle(title: string): string {
    let cleaned = title;

    // Remove [EVITE.COPIAS...] and similar bracketed spam prefixes
    cleaned = cleaned.replace(/^\[(?:EVITE|BAIXE|DOWNLOAD|WWW)[^\]]*\]\s*/gi, '');

    // Remove "EVITE.COPIAS.BAIXE.NO." prefix without brackets
    cleaned = cleaned.replace(/^EVITE\.COPIAS\.[^.]*\./i, '');

    // Remove known site prefixes that get concatenated into titles
    cleaned = cleaned.replace(/^(SITEDETORRENTS\.COM\.?|WWW\.BLUDV\.(COM|TV|IN)\.?|BLUDV\.(COM|TV|IN)\.?|WWW\.THEPIRATEFILMES\.COM\.?|THEPIRATEFILMES\.COM\.?|YTSBR\.COM\.?|WWW\.COMANDOTORRENTS\.COM\.?|COMANDOTORRENTS\.COM\.?)/gi, '');

    // Remove leading dots/dashes/underscores/spaces
    cleaned = cleaned.replace(/^[.\-_\s]+/, '');

    // Brazilian indexer slug pattern: metadata-prefix separated by ".." from the actual title
    const doubleDotIdx = cleaned.indexOf('..');
    if (doubleDotIdx > 0) {
      const afterDoubleDot = cleaned.slice(doubleDotIdx).replace(/^\.+/, '');
      if (afterDoubleDot && /^[A-Za-z]/.test(afterDoubleDot)) {
        cleaned = afterDoubleDot;
      }
    }

    // Remove duplicate extensions like .MKV.MKV., .MP4.MP4.
    cleaned = cleaned.replace(/\.(MKV|MP4|AVI|M4V|TS)\.\1\./gi, '.$1.');

    // Remove trailing file extension for display
    cleaned = cleaned.replace(/\.(mkv|mp4|avi|m4v|ts|m2ts|iso)$/i, '');

    // Remove orphaned parenthetical language tags from the indexer
    cleaned = cleaned.replace(/\s*\((brazilian|eng|portuguese|portugues|english|spanish|espanhol|dublado|legendado|nacional)(?:\s*,\s*(brazilian|eng|portuguese|portugues|english|spanish|espanhol|dublado|legendado|nacional))*\)\s*$/i, '');

    // Clean up ugly slug patterns: .-LEGENDADO-., .-DUBLADO-.
    cleaned = cleaned.replace(/\.-([A-Z]+)-\./g, ' $1 ');

    // Remove trailing site domain junk like "-comando.la" or "-WWW.COMANDOTORRENTS.COM"
    cleaned = cleaned.replace(/[-.](?:www\.)?(?:comando(?:torrents|filmes)?\.(?:la|com|net)|bludv\.[a-z]+|thepiratefilmes\.com|sitedetorrents\.com)$/i, '');

    // Collapse multiple dots/spaces
    cleaned = cleaned.replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();

    // Remove leading dots/dashes/underscores after all cleaning
    cleaned = cleaned.replace(/^[.\-_\s]+/, '');

    return cleaned || title;
  }

  /**
   * Parse size strings like "4.06 GB", "19.72 GB", "711 MB" into bytes.
   */
  private parseSizeString(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const numOnly = parseFloat(trimmed);
    if (!isNaN(numOnly) && !/[a-zA-Z]/.test(trimmed)) {
      return Math.round(numOnly);
    }

    const match = trimmed.match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B)/i);
    if (!match || !match[1] || !match[2]) return undefined;

    // Sites BR escrevem "1,5 GB".
    const num = parseFloat(match[1].replace(',', '.'));
    if (isNaN(num)) return undefined;

    const unit = match[2].toUpperCase();
    switch (unit) {
      case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
      case 'GB': return Math.round(num * 1024 * 1024 * 1024);
      case 'MB': return Math.round(num * 1024 * 1024);
      case 'KB': return Math.round(num * 1024);
      default: return Math.round(num);
    }
  }

  private extractSeeders(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.seeders ??
      record.seed ??
      record.seeds ??
      record.seedCount ??
      record.seed_count ??
      record.peers ??
      record.peer ??
      record.peerCount;

    return this.toNumber(candidate);
  }

  private extractSize(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.size ??
      record.sizeBytes ??
      record.size_bytes ??
      record.bytes ??
      record.filesize ??
      record.length ??
      record.totalSize;

    if (typeof candidate === 'number') {
      return candidate;
    }

    return this.parseSizeString(candidate);
  }

  private inferQualityFromTitle(title: string): string | undefined {
    const match = title.match(/(4k|UHD|2160p|1440p|FHD|FULLHD|1080p|HD|720p|480p|360p)/i);
    if (match?.[1]) {
      const q = match[1].toLowerCase();
      if (q === '4k' || q === 'uhd') return '4K';
      if (q === 'fhd' || q === 'fullhd') return '1080p';
      if (q === 'hd') return '720p';
      return q;
    }

    // Fallback: infer from source tag when no explicit resolution
    if (/\b(blu[\s.-]?ray|bdrip|bdremux|remux)\b/i.test(title)) return '1080p';
    if (/\b(web[\s.-]?dl|webrip)\b/i.test(title)) return '720p';
    if (/\b(hdtv|hdrip)\b/i.test(title)) return '720p';
    if (/\b(dvdrip|dvdscr)\b/i.test(title)) return '480p';
    if (/\b(cam|hdcam|telesync|telecine)\b/i.test(title)) return 'CAM';

    return undefined;
  }

  private normalizeTorrentPayload(payload: unknown): TorrentLike[] {
    let items: TorrentLike[] = [];
    if (!payload) {
      return items;
    }

    if (Array.isArray(payload)) {
      items = payload as TorrentLike[];
    } else if (typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const possibleKeys = ['results', 'data', 'items', 'torrents', 'entries'];
      for (const key of possibleKeys) {
        const value = record[key];
        if (Array.isArray(value)) {
          items = value as TorrentLike[];
          break;
        }
      }
      if (items.length === 0 && record.torrent) {
        items = [record.torrent as TorrentLike];
      }
    }

    // ── Bypass Adware / Decodificador Base64 (BLUDV) ──
    for (const item of items) {
      if (!item) continue;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === 'string' ? rec.url : (typeof rec.link === 'string' ? rec.link : undefined);
      const magnet = rec.magnet;

      if (url && !magnet && url.includes('get.php?id=')) {
        if (/systemads\.org|superadsgo\.xyz|superadsgo1\.xyz|systemads\.xyz|seuvideo\.xyz/.test(url)) {
          try {
            const urlObj = new URL(url);
            const idVal = urlObj.searchParams.get('id');
            if (idVal) {
              const reversedId = idVal.split('').reverse().join('');
              const decoded = Buffer.from(reversedId, 'base64').toString('utf-8');
              if (decoded.startsWith('magnet:')) {
                rec.magnet = decoded;
              } else if (decoded.startsWith('http')) {
                rec.url = decoded;
              }
            }
          } catch (e) {
            // Ignorar erro de parse e seguir com o link original
          }
        }
      }
    }

    return items;
  }

  private sanitizeQuery(raw: string | undefined): string | undefined {
    if (!raw) {
      return undefined;
    }

    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }

    // Strip out parenthesis metadata like (eng) or (brazilian, eng)
    const withoutParenthesis = decoded.replace(/\s*\([^)]*\)/g, '');
    const cleaned = withoutParenthesis.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return undefined;
    }

    return cleaned;
  }

  private titleize(value: string): string {
    return value
      .split(' ')
      .filter((part) => part.trim().length > 0)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ');
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.replace(/[^0-9.-]/g, ''));
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private toString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return undefined;
  }
}
