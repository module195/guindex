/**
 * Source Service - Orchestrates multiple source providers
 */

import type { SourceStream } from '../models/source-model.js';
import { SOURCES } from '../config/sources.js';
import type { SourceFetchOptions } from './base-source-provider.js';
import { prefetchDebridAvailability } from './debrid-prefetch.js';
import { REQUEST_BUDGET_MS, noteIncompleteSearch } from './torrent-indexer-shared.js';

// Timeout por provedor (ms). Padrão: o orçamento do pedido
// (TORRENT_INDEXER_REQUEST_BUDGET_MS), para uma fonte lenta não segurar as
// outras no Promise.all. 0 = sem timeout.
export const SOURCE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.SOURCE_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return REQUEST_BUDGET_MS;
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

// Janela para as outras fontes depois que a principal (GuIndex) responde com
// streams. Antes, o Promise.all esperava a mais lenta (o addon externo, até o
// timeout dele): o GuIndex pronto em 1 s saía em 6,5 s. 0 = espera todas.
export const SOURCE_GRACE_MS = (() => {
  const parsed = Number.parseInt(process.env.SOURCE_GRACE_MS ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 1000;
})();

type SourceResult = { source: string; streams: SourceStream[] };

export class SourceService {
  static async fetchStreamsFromAllSources(
    type: string,
    id: string,
    options?: SourceFetchOptions
  ): Promise<SourceStream[]> {
    console.info(`[GuIndex] 🚀 Iniciando busca paralela em ${SOURCES.length} provedores (incluindo Torrent Indexer)...`);

    const results: Array<SourceResult | undefined> = new Array(SOURCES.length).fill(undefined);
    const tasks = SOURCES.map(async (source, index): Promise<SourceResult> => {
      console.info(`[GuIndex] 📡 Acionando provedor: ${source.name}...`);
      let result: SourceResult;
      try {
        const streams = await withTimeout(
          source.getStreams(type, id, options),
          SOURCE_TIMEOUT_MS,
          source.name,
        );
        console.info(`[GuIndex] ✅ Sucesso: ${source.name} retornou ${streams.length} streams.`);
        // A checagem de cache no debrid começa já, enquanto as outras fontes respondem
        prefetchDebridAvailability(streams, options);
        result = { source: source.name, streams };
      } catch (error) {
        console.warn(`[GuIndex] ❌ Falha crítica no provedor ${source.name}:`, error);
        noteIncompleteSearch();
        result = { source: source.name, streams: [] };
      }
      results[index] = result;
      return result;
    });

    const all = Promise.all(tasks);
    const primaryTasks = tasks.filter((_, index) => SOURCES[index]?.primary);
    if (SOURCE_GRACE_MS > 0 && primaryTasks.length > 0 && primaryTasks.length < tasks.length) {
      const primary = await Promise.race([Promise.all(primaryTasks), all]);
      const primaryStreams = primary.reduce((sum, result) => sum + result.streams.length, 0);
      if (primaryStreams > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          all,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SOURCE_GRACE_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
        const late = SOURCES.filter((_, index) => results[index] === undefined).map((source) => source.name);
        if (late.length > 0) {
          console.info(
            `[GuIndex] ⏩ Resposta sem esperar ${late.join(', ')}: a fonte principal já respondeu e a janela de ${SOURCE_GRACE_MS}ms acabou`
          );
        }
        console.info(`[GuIndex] 🏁 Busca nos provedores concluída. Pacotes de provedores: ${results.filter(Boolean).length}/${results.length}`);
        return results.flatMap((result) => result?.streams ?? []);
      }
    }

    const settled = await all;
    console.info(`[GuIndex] 🏁 Busca nos provedores concluída. Total de pacotes de provedores: ${settled.length}`);
    return settled.flatMap(result => result.streams);
  }
}
