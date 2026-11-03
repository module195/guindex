/**
 * Combinações de prazos que se anulam. Cada parâmetro é válido sozinho, mas
 * alguns pares desligam uma fase ou passam do timeout do AIOStreams. Só avisa
 * no boot: o comportamento não muda.
 */

import { REQUEST_BUDGET_MS, DEBRID_MARGIN_MS, META_BUDGET_MS, MULTI_GRACE_MS, MULTI_GRACE_NO_4K_MS, PHASE3_MIN_MS } from './torrent-indexer-shared.js';
import { SOURCE_TIMEOUT_MS } from './source-service.js';
import { ADDON_TIMEOUT_MS } from './stremio-addon-provider.js';

export interface TimingConfig {
  requestBudgetMs: number;
  debridMarginMs: number;
  metaBudgetMs: number;
  multiGraceMs: number;
  multiGraceNo4kMs: number;
  phase3MinMs: number;
  sourceTimeoutMs: number;
  addonTimeoutMs: number;
}

/** Timeout que o AIOStreams dá ao GuIndex; o orçamento precisa caber nele com a rede. */
export const AIOSTREAMS_TIMEOUT_MS = 9000;
/** Rede, túnel e o resto do pedido fora do orçamento, até o AIOStreams. */
const NETWORK_ALLOWANCE_MS = 500;
const MIN_DEBRID_MARGIN_MS = 300;

export function timingConfigWarnings(c: TimingConfig): string[] {
  const warnings: string[] = [];
  const searchWindow = c.requestBudgetMs - c.debridMarginMs;
  if (c.requestBudgetMs + NETWORK_ALLOWANCE_MS > AIOSTREAMS_TIMEOUT_MS) {
    warnings.push(
      `TORRENT_INDEXER_REQUEST_BUDGET_MS=${c.requestBudgetMs}: no pior caso a resposta passa de ${AIOSTREAMS_TIMEOUT_MS}ms ` +
        `e o AIOStreams descarta o GuIndex; use até ${AIOSTREAMS_TIMEOUT_MS - NETWORK_ALLOWANCE_MS}`,
    );
  }
  if (c.metaBudgetMs >= searchWindow) {
    warnings.push(
      `TORRENT_INDEXER_META_BUDGET_MS=${c.metaBudgetMs} ocupa toda a janela da busca (${searchWindow}ms = orçamento − margem do debrid)`,
    );
  }
  if (c.phase3MinMs >= searchWindow) {
    warnings.push(
      `TORRENT_INDEXER_PHASE3_MIN_MS=${c.phase3MinMs} não cabe na janela da busca (${searchWindow}ms): a Fase 3 nunca roda`,
    );
  }
  if (c.multiGraceNo4kMs >= searchWindow) {
    warnings.push(
      `TORRENT_INDEXER_MULTI_GRACE_NO_4K_MS=${c.multiGraceNo4kMs} cobre a janela da busca inteira (${searchWindow}ms): ` +
        'o cache suficiente deixa de responder mais cedo',
    );
  }
  if (c.multiGraceMs > c.multiGraceNo4kMs) {
    warnings.push(
      `TORRENT_INDEXER_MULTI_GRACE_MS=${c.multiGraceMs} é maior que TORRENT_INDEXER_MULTI_GRACE_NO_4K_MS=${c.multiGraceNo4kMs}: ` +
        'com 4K no cache a busca esperaria mais que sem 4K',
    );
  }
  if (c.debridMarginMs < MIN_DEBRID_MARGIN_MS) {
    warnings.push(
      `TORRENT_INDEXER_DEBRID_MARGIN_MS=${c.debridMarginMs}: o que o multi trouxer perto do fim sai sem a checagem de cache do debrid`,
    );
  }
  if (c.sourceTimeoutMs === 0 || c.sourceTimeoutMs > c.requestBudgetMs) {
    warnings.push(
      `SOURCE_TIMEOUT_MS=${c.sourceTimeoutMs}: uma fonte lenta segura a resposta além do orçamento (${c.requestBudgetMs}ms)`,
    );
  }
  if (c.addonTimeoutMs > c.requestBudgetMs) {
    warnings.push(
      `STREMIO_ADDON_TIMEOUT_MS=${c.addonTimeoutMs}: um addon lento segura a resposta além do orçamento (${c.requestBudgetMs}ms)`,
    );
  }
  return warnings;
}

export function currentTimingConfig(): TimingConfig {
  return {
    requestBudgetMs: REQUEST_BUDGET_MS,
    debridMarginMs: DEBRID_MARGIN_MS,
    metaBudgetMs: META_BUDGET_MS,
    multiGraceMs: MULTI_GRACE_MS,
    multiGraceNo4kMs: MULTI_GRACE_NO_4K_MS,
    phase3MinMs: PHASE3_MIN_MS,
    sourceTimeoutMs: SOURCE_TIMEOUT_MS,
    addonTimeoutMs: ADDON_TIMEOUT_MS,
  };
}

export function warnInvalidTimingConfig(): void {
  for (const warning of timingConfigWarnings(currentTimingConfig())) {
    console.warn(`[GuIndex] ⚠️ Prazos: ${warning}`);
  }
}
