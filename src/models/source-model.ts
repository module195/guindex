/**
 * Source Models
 */
export interface StreamContext {
  type?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  title?: string;
  year?: number;
  episodeList?: number[];
}
export interface SourceStream {
  cached?: boolean;
  name?: string;
  title?: string;
  description?: string;
  fileName?: string;
  /** Nome cru do arquivo (ou do release, sem lista de arquivos), com extensão; vai para behaviorHints.filename */
  rawFileName?: string;
  /** Nome do torrent quando o stream é um arquivo dentro dele */
  folderName?: string;
  /** Tamanho total do torrent em bytes quando o stream é um arquivo dentro dele */
  folderSize?: number;
  /** Data de publicação no indexador (ISO 8601) */
  publishDate?: string;
  detailUrl?: string;
  languages?: string[];
  source?: string;
  /** Indexer slug that produced this result (e.g. 'torrent-dos-filmes') */
  indexer?: string;
  /** Nome legível do indexador (e.g. 'Torrent dos Filmes'); vai para behaviorHints.indexer */
  indexerLabel?: string;
  /** Marca de idioma ("PT-BR", "Subs") anexada só ao behaviorHints.filename */
  filenameLanguageTag?: string;
  /** Duração do vídeo em segundos; vai para behaviorHints.duration */
  durationSeconds?: number;
  url?: string;
  magnet?: string;
  infoHash?: string;
  /** Trackers do release (os do magnet e os que o indexer listou) */
  trackers?: string[];
  fileIdx?: number;
  size?: number;
  seeders?: number;
  quality?: string;
  releaseGroup?: string;
  context?: StreamContext;
  similarity?: number;
  
  // Extended Metadata from Torrent Indexer API
  videoQuality?: string;
  audioQuality?: string;
  genres?: string[];
  subtitles?: string[];
  duration?: string;
  classification?: string;
  contextString?: string;
}
