// Orçamento total do pedido: a consulta de cache do debrid não pode passar dele.
// Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Orçamento curto para o teste não demorar (lido no import do módulo)
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '600';

const { StreamController, finishesWithin } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const HASH = 'a'.repeat(40);
const originals = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  fetchCached: TorboxService.fetchCachedInfoHashes,
};

afterEach(() => {
  SourceService.fetchStreamsFromAllSources = originals.fetchStreams;
  TorboxService.fetchCachedInfoHashes = originals.fetchCached;
});

const sourceStream = () => ({
  name: 'GuIndex\n1080p',
  title: 'The.Matrix.1999.1080p.DUAL.mkv',
  magnet: `magnet:?xt=urn:btih:${HASH}`,
  infoHash: HASH,
  source: 'betor',
  indexer: 'betor',
});

test('finishesWithin: true quando termina antes, false quando o prazo vence', async () => {
  assert.equal(await finishesWithin(Promise.resolve(), 50), true);
  assert.equal(await finishesWithin(new Promise(() => {}), 20), false);
  assert.equal(await finishesWithin(Promise.resolve(), 0), false);
});

test('checagem TorBox lenta: responde dentro do orçamento com streams não cacheados', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.fetchCachedInfoHashes = () => new Promise((r) => setTimeout(() => r(new Set([HASH])), 3000).unref());

  const started = Date.now();
  const result = await new StreamController().handleStreamRequest({
    type: 'movie',
    id: 'tt0133093',
    extra: { debridProvider: 'torbox', torboxToken: 'tok-0123456789' },
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1500, `levou ${elapsed}ms`);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.cached, false);
  assert.equal(result.streams[0].behaviorHints.service, 'torbox');
});

test('checagem TorBox rápida: mantém o status de cache', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.fetchCachedInfoHashes = async () => new Set([HASH]);

  const result = await new StreamController().handleStreamRequest({
    type: 'movie',
    id: 'tt0133093',
    extra: { debridProvider: 'torbox', torboxToken: 'tok-0123456789' },
  });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.cached, true);
});
