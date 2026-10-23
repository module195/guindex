/**
 * Source Service - Orchestrates multiple source providers
 */

import type { SourceStream } from '../models/source-model.js';
import { SOURCES } from '../config/sources.js';
import type { SourceFetchOptions } from './base-source-provider.js';

// Timeout por provedor (ms). 0 = sem timeout (comportamento original).
const SOURCE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.SOURCE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label}: timeout de ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

export class SourceService {
  static async fetchStreamsFromAllSources(
    type: string,
    id: string,
    options?: SourceFetchOptions
  ): Promise<SourceStream[]> {
    console.info(`[GuIndex] 🚀 Iniciando busca paralela em ${SOURCES.length} provedores (incluindo Torrent Indexer)...`);
    
    
    const results = await Promise.all(
      SOURCES.map(async (source) => {
        console.info(`[GuIndex] 📡 Acionando provedor: ${source.name}...`);
        try {
          const streams = await withTimeout(
            source.getStreams(type, id, options),
            SOURCE_TIMEOUT_MS,
            source.name,
          );
          console.info(`[GuIndex] ✅ Sucesso: ${source.name} retornou ${streams.length} streams.`);
          return { source: source.name, streams };
        } catch (error) {
          console.warn(`[GuIndex] ❌ Falha crítica no provedor ${source.name}:`, error);
          return { source: source.name, streams: [] };
        }
      })
    );
    
        
    console.info(`[GuIndex] 🏁 Busca nos provedores concluída. Total de pacotes de provedores: ${results.length}`);
    return results.flatMap(result => result.streams);
  }
}
