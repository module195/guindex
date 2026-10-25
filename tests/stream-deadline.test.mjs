// Orçamento total do pedido: a consulta de cache do debrid não pode passar dele
// nem da sua fatia (TORRENT_INDEXER_DEBRID_MARGIN_MS).
// Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Orçamento curto para o teste não demorar (lido no import do módulo)
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '600';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '300';

const { StreamController, finishesWithin } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const HASH = 'a'.repeat(40);
const originals = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  checkCached: TorboxService.checkCachedInfoHashes,
};

afterEach(() => {
  SourceService.fetchStreamsFromAllSources = originals.fetchStreams;
  TorboxService.checkCachedInfoHashes = originals.checkCached;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const availability = (cached = [], unknown = []) => ({ cached: new Set(cached), unknown: new Set(unknown) });
const torboxArgs = (id) => ({
  type: 'movie',
  id,
  extra: { debridProvider: 'torbox', torboxToken: 'tok-0123456789' },
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

test('checagem TorBox lenta: espera só a fatia do debrid e responde sem o selo', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.checkCachedInfoHashes = () =>
    new Promise((r) => setTimeout(() => r(availability([HASH])), 3000).unref());

  const started = Date.now();
  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133093'));
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 280 && elapsed < 550, `levou ${elapsed}ms, a fatia do debrid é 300ms`);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.cached, false);
  assert.equal(result.streams[0].behaviorHints.service, 'torbox');
  assert.equal(StreamController.cacheControlFor(result), 'no-store');
});

test('busca lenta + TorBox lento: a resposta sai dentro do orçamento do pedido', async () => {
  SourceService.fetchStreamsFromAllSources = async () => {
    await sleep(450);
    return [sourceStream()];
  };
  TorboxService.checkCachedInfoHashes = () => new Promise(() => {});

  const started = Date.now();
  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133094'));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 700, `levou ${elapsed}ms, o orçamento é 600ms`);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.cached, false);
});

test('checagem TorBox rápida: mantém o status de cache', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.checkCachedInfoHashes = async () => availability([HASH]);

  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133095'));

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.cached, true);
  assert.notEqual(StreamController.cacheControlFor(result), 'no-store');
});

test('checagem TorBox com erro: o stream sai sem selo e a resposta não fica guardada como definitiva', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.checkCachedInfoHashes = async () => availability([], [HASH]);

  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133096'));

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.cached, false);
  assert.equal(StreamController.cacheControlFor(result), 'no-store');
});
