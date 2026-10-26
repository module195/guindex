/**
 * Stream Models
 */

export interface StremioStreamBehaviorHints {
  notWebReady?: boolean;
  realDebridReady?: boolean;
  torboxReady?: boolean;
  fallbackMagnet?: string;
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
  // O AIOStreams só lê estes campos de behaviorHints em addons custom.
  seeders?: number;
  indexer?: string;
  publishDate?: string;
  folderName?: string;
  folderSize?: number;
  /** Segundos; o AIOStreams calcula o bitrate a partir dele e do videoSize */
  duration?: number;
  service?: 'realdebrid' | 'torbox';
  cached?: boolean;
}

export interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  url: string;
  behaviorHints?: StremioStreamBehaviorHints;
  infoHash?: string;
  /** Trackers (`tracker:udp://…`) e nó DHT (`dht:<hash>`) para achar peers do infoHash */
  sources?: string[];
  fileIdx?: number;
  externalUrl?: string;
  size?: number;
  seeders?: number;
  quality?: string;
  releaseGroup?: string;
  languages?: string[];
  filename?: string;
  folderName?: string;
  indexer?: string;
}

export interface StreamResponse {
  streams: StremioStream[];
}

export interface StreamRequest {
  type: string;
  id: string;
  extra?: {
    debridProvider?: string;
    realdebridToken?: string;
    torboxToken?: string;
    token?: string;
    forceFresh?: boolean;
    /** Origem pública do pedido; usada nos links de resolve quando BASE_URL não está definida. */
    requestBaseUrl?: string;
  };
}
