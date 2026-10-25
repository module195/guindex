/**
 * Começo antecipado da checagem de cache no debrid. Quem espera pela resposta e a
 * aplica nos streams é o StreamController; começar antes só adianta a consulta,
 * que ele reaproveita (o TorBox compartilha a consulta em andamento de cada hash
 * pelo mesmo token; o RD, a da lista da conta).
 */

import type { SourceStream } from '../models/source-model.js';
import type { SourceFetchOptions } from './base-source-provider.js';
import { RealDebridService } from './realdebrid-service.js';
import { TorboxService } from './torbox-service.js';

/** Info hash (minúsculo) do stream: o campo infoHash ou o btih do magnet. */
export function streamInfoHash(stream: SourceStream): string | undefined {
  if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
    return stream.infoHash.trim().toLowerCase();
  }
  const magnet = [stream.magnet, stream.url].find(
    (value): value is string => typeof value === 'string' && value.toLowerCase().startsWith('magnet:')
  );
  const hash = magnet?.match(/xt=urn:btih:([^&]+)/i)?.[1]?.trim();
  return hash ? hash.toLowerCase() : undefined;
}

/** Começa a checagem de cache no debrid desses streams, sem esperar por ela. */
export function prefetchDebridAvailability(streams: SourceStream[], options?: SourceFetchOptions): void {
  const hashes = new Set<string>();
  for (const stream of streams) {
    const hash = streamInfoHash(stream);
    if (hash) hashes.add(hash);
  }
  if (hashes.size === 0) return;
  if (options?.debridProvider === 'torbox' && options.torboxToken) {
    void TorboxService.checkCachedInfoHashes([...hashes], options.torboxToken).catch(() => undefined);
  } else if (options?.debridProvider === 'realdebrid' && options.realdebridToken) {
    void RealDebridService.checkCachedInfoHashes([...hashes], options.realdebridToken).catch(() => undefined);
  }
}
