// Cooldown local dos indexers alimentado pelas sub-chamadas do /indexers/multi.
// Roda contra o build: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const provider = new TorrentIndexerProvider('GuIndex', 'http://127.0.0.1:9');
const state = (slug) => TorrentIndexerProvider.indexerFailureState.get(slug);
const err = (indexer, q, status = 502) => ({ indexer, q, state: 'error', status, duration_ms: 100 });
const ok = (indexer, q) => ({ indexer, q, state: 'ok', status: 200, count: 3, duration_ms: 100, cache: 'MISS' });

beforeEach(() => {
  TorrentIndexerProvider.indexerFailureState.clear();
  TorrentIndexerProvider.indexerPerformance.clear();
});

test('várias queries com 5xx na mesma resposta contam como uma falha só', () => {
  provider.recordMultiCalls([err('betor', 'a'), err('betor', 'b'), err('betor', 'c')], 4000);
  assert.equal(state('betor').consecutiveFailures, 1);
  assert.equal(state('betor').cooldownUntil, 0, 'uma busca ruim não abre cooldown');
  assert.equal(provider.shouldSkipIndexer('betor'), false);
});

test('duas respostas ruins seguidas abrem cooldown de 5 min', () => {
  provider.recordMultiCalls([err('betor', 'a'), err('betor', 'b')], 4000);
  const before = Date.now();
  provider.recordMultiCalls([err('betor', 'a')], 4000);
  assert.equal(state('betor').consecutiveFailures, 2);
  assert.equal(provider.shouldSkipIndexer('betor'), true);
  const left = state('betor').cooldownUntil - before;
  assert.ok(left >= 299_000 && left <= 301_000, `cooldown de ~5 min, veio ${left} ms`);
});

test('um ok na mesma resposta vence as falhas das outras queries', () => {
  provider.recordMultiCalls([err('betor', 'a')], 4000);
  provider.recordMultiCalls([err('betor', 'a'), ok('betor', 'b')], 4000);
  assert.equal(state('betor').consecutiveFailures, 0);
  assert.equal(provider.shouldSkipIndexer('betor'), false);
});

test('falhas de indexers diferentes não se misturam', () => {
  provider.recordMultiCalls([err('betor', 'a'), err('rede_torrent', 'a'), ok('bludv_ru', 'a')], 4000);
  assert.equal(state('betor').consecutiveFailures, 1);
  assert.equal(state('rede_torrent').consecutiveFailures, 1);
  assert.equal(state('bludv_ru'), undefined);
});

test('4xx comum e timeout não contam como falha de saúde', () => {
  provider.recordMultiCalls([
    err('betor', 'a', 404),
    { indexer: 'betor', q: 'b', state: 'timeout', duration_ms: 4000 },
  ], 4000);
  assert.equal(state('betor'), undefined);
});
