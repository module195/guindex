/**
 * Tipos, configuração por env e helpers partilhados pelo provider do torrent-indexer
 * e pelo TorrentParser.
 */

export interface ParsedIdInfo {
  imdbId?: string;
  query?: string;
  season?: number;
  episode?: number;
}

export interface CinemetaVideo {
  season?: number | string;
  episode?: number | string;
  title?: string;
  name?: string;
}

export interface CinemetaMeta {
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
export interface TorrentResult {
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
export type TorrentLike = TorrentResult & Record<string, unknown>;

export interface IndexedTorrentFile {
  path: string;
  size?: number;
  originalIndex: number;
}

/** One entry of "indexers" in the torrent-indexer's /sources?v=2. */
export interface IndexerCapability {
  name: string;
  /** undefined = unknown (old /sources without v=2): try every query */
  supportsText?: boolean;
  supportsImdb?: boolean;
  healthy: boolean;
}

export interface IndexerCatalog {
  ts: number;
  indexers: IndexerCapability[];
  /** /indexers/multi is available; undefined = unknown (try it once) */
  multi?: boolean;
}

/** One entry of "calls" in the /indexers/multi response. */
export interface MultiCall {
  indexer?: string;
  q?: string;
  state?: string; // ok | error | skipped | timeout
  status?: number;
  count?: number;
  duration_ms?: number;
  cache?: string;
  reason?: string;
}

export interface SearchCacheEntry {
  ts: number;
  data: TorrentLike[];
}

export interface LocalizedTitleCacheEntry {
  ts: number;
  titles: string[];
}

export interface IndexerFailureState {
  consecutiveFailures: number;
  cooldownUntil: number;
}

export interface IndexerPerformanceEntry {
  avgMs: number;
  samples: number;
  hits: number;
  emptyHits: number;
  lastDurationMs: number;
  lastSeenAt: number;
}

export interface FallbackSearchOptions {
  excludeIndexers?: Set<string>;
  maxIndexers?: number;
  perIndexerLimit?: number;
  targetResults?: number;
  timeoutMs?: number;
  limitQueries?: number;
  excludeNamesWithYear?: boolean;
}

export const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

export const normalizeIndexerValue = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]+/g, '');

export const parseCsvSet = (value: string | undefined, defaults: string[] = []): Set<string> => {
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

export const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

export const readEnv = (primary: string, legacy?: string): string | undefined => {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined) {
    return primaryValue;
  }

  if (legacy) {
    return process.env[legacy];
  }

  return undefined;
};

export const MAX_STREAMS = 240;
export const TARGET_STREAMS_PER_REQUEST = parsePositiveInt(
  process.env.TORRENT_INDEXER_TARGET_STREAMS,
  30,
);
export const MAX_DYNAMIC_QUERIES = parsePositiveInt(
  process.env.TORRENT_INDEXER_MAX_DYNAMIC_QUERIES,
  10,
);
export const MAX_SEARCH_TIME_MS = parsePositiveInt(
  process.env.TORRENT_INDEXER_MAX_QUERY_TIME_MS,
  18_000,
);
export const MAX_STREAMS_PER_SOURCE = parsePositiveInt(
  process.env.TORRENT_INDEXER_MAX_STREAMS_PER_SOURCE,
  50,
);
export const MAX_TEXT_QUERIES = 12;
export const MAX_COLLECT_PER_SOURCE = parsePositiveInt(
  process.env.TORRENT_INDEXER_COLLECT_PER_SOURCE,
  40,
);
// Quantidade de queries extras (além do mid-path) aquecidas em background.
// 0 = desligado (comportamento original).
export const WARM_EXTRA_QUERIES = parseNonNegativeInt(
  process.env.TORRENT_INDEXER_WARM_EXTRA_QUERIES,
  0,
);
// Orçamento do pedido inteiro, desde a chegada: busca + consulta de cache do debrid.
// Fica 1 s abaixo dos 9 s que o AIOStreams dá ao GuIndex, para a rede e o túnel.
export const REQUEST_BUDGET_MS = parsePositiveInt(process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS, 8000);
// Quanto esperar por Cinemeta/TMDB antes de buscar só com o IMDb e os títulos que já
// chegaram; a consulta segue em segundo plano e enche o cache para o próximo pedido.
export const META_BUDGET_MS = parsePositiveInt(process.env.TORRENT_INDEXER_META_BUDGET_MS, 1500);
// Reserva, dentro do orçamento, para a consulta de cache do debrid depois da busca.
// O /stream espera por ela até o fim do orçamento, não só por essa reserva.
export const DEBRID_MARGIN_MS = parseNonNegativeInt(process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS, 1500);
// Teto opcional dessa espera, para responder mais cedo com o debrid lento (sem
// selo); `0` não espera. Sem ele, o /stream espera até o fim do orçamento.
export const DEBRID_MAX_WAIT_MS = process.env.TORRENT_INDEXER_DEBRID_MAX_WAIT_MS?.trim()
  ? parseNonNegativeInt(process.env.TORRENT_INDEXER_DEBRID_MAX_WAIT_MS, Infinity)
  : Infinity;
// Fase 1: quantas queries vão ao Meilisearch (uma chamada /search por query, em paralelo).
export const MAX_CACHE_QUERIES = parsePositiveInt(process.env.TORRENT_INDEXER_CACHE_MAX_QUERIES, 8);
export const CACHE_TIMEOUT_MS = parsePositiveInt(process.env.TORRENT_INDEXER_CACHE_TIMEOUT_MS, 3000);
// Fase 2: com cache suficiente, quanto ainda esperar pelo multi antes de responder.
export const MULTI_GRACE_MS = parseNonNegativeInt(process.env.TORRENT_INDEXER_MULTI_GRACE_MS, 1500);
// Fase 2: cache suficiente mas sem nenhum 4K. O dump do betor traz muito 1080p e o
// 4K costuma vir só do multi, que raspa em tempo real; vale esperar mais por ele.
export const MULTI_GRACE_NO_4K_MS = parseNonNegativeInt(process.env.TORRENT_INDEXER_MULTI_GRACE_NO_4K_MS, 4000);
// Fase 3: tempo mínimo restante para valer a pena e máximo de queries.
export const PHASE3_MIN_MS = parsePositiveInt(process.env.TORRENT_INDEXER_PHASE3_MIN_MS, 1500);
export const PHASE3_MAX_QUERIES = parsePositiveInt(process.env.TORRENT_INDEXER_PHASE3_MAX_QUERIES, 3);
export const IMDB_QUERY_REGEX = /^tt\d+$/i;
// Sinais fortes de série, com fronteira de palavra. Fica de fora o que aparece em
// nome de filme: "DTS5.1", "1920x1080", "Filme Completo", "Pack", "Collection",
// "Episódio IV", "A Série Divergente".
export const STRONG_EPISODE_REGEX =
  /\b(?:S\d{1,2}\s?E\d{1,3}|S\d{1,2}\b(?!\.\d)|\d{1,2}x\d{1,3}(?![\dp])|temporadas?\b|seasons?\b|epis[oó]dios?\s*\d|episodes?\s*\d|cap[ií]tulos?\s*\d|mini[\s-]?s+[eé]ries?|s[eé]rie\s+completa|complete\s+series|\d{1,2}[ªºa]\s*temp)/i;

export const LANGUAGE_FLAG_MAP: Record<string, string> = {
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

export interface MatchContext {
  parsed: ParsedIdInfo;
  type: string;
  targetTitles: string[];
  releaseYear?: number;
  episodeTitle?: string;
  /** Duração do título em segundos (runtime do Cinemeta); vai para behaviorHints.duration */
  runtimeSeconds?: number;
  reqId?: string;
  logName?: string;
}

export function logReq(context: MatchContext | undefined, message: string) {
  const ts = new Date().toISOString();
  const req = context?.reqId ? `[Req: ${context.reqId}]` : '';
  const name = context?.logName ? `[${context.logName}]` : '';
  console.info(`[${ts}] [GuIndex] ${req} ${name} ${message}`.replace(/\s+/g, ' '));
}

// Aviso de que o multi terminou depois da resposta e trouxe streams que ela não
// tinha. Quem guarda a resposta (o cache do /stream) descarta a versão antiga.
type LateResultsListener = (type: string, id: string) => void;
const lateResultsListeners = new Set<LateResultsListener>();

export function onLateResults(listener: LateResultsListener): () => void {
  lateResultsListeners.add(listener);
  return () => lateResultsListeners.delete(listener);
}

export function notifyLateResults(type: string, id: string): void {
  for (const listener of lateResultsListeners) {
    try {
      listener(type, id);
    } catch {
      // um ouvinte com erro não impede os outros
    }
  }
}
