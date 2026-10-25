// Orçamento total do pedido: a consulta de cache do debrid espera até o fim dele
// (menos a folga para montar a resposta), nunca além.
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
const OTHER = 'b'.repeat(40);
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

const sourceStream = (hash = HASH) => ({
  name: 'GuIndex\n1080p',
  title: 'The.Matrix.1999.1080p.DUAL.mkv',
  magnet: `magnet:?xt=urn:btih:${hash}`,
  infoHash: hash,
  source: 'betor',
  indexer: 'betor',
});

test('finishesWithin: true quando termina antes, false quando o prazo vence', async () => {
  assert.equal(await finishesWithin(Promise.resolve(), 50), true);
  assert.equal(await finishesWithin(new Promise(() => {}), 20), false);
  assert.equal(await finishesWithin(Promise.resolve(), 0), false);
});

test('checagem TorBox lenta: espera até o fim do orçamento e responde sem o selo', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.checkCachedInfoHashes = () =>
    new Promise((r) => setTimeout(() => r(availability([HASH])), 3000).unref());

  const started = Date.now();
  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133093'));
  const elapsed = Date.now() - started;

  // orçamento 600ms, menos 200ms de folga para montar a resposta
  assert.ok(elapsed >= 380 && elapsed < 600, `levou ${elapsed}ms, a espera vai até 400ms`);
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

test('checagem TorBox que passa da fatia do debrid ainda vale se chegar dentro do orçamento', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream()];
  TorboxService.checkCachedInfoHashes = () =>
    new Promise((r) => setTimeout(() => r(availability([HASH])), 350).unref());

  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133097'));

  assert.equal(result.streams[0].behaviorHints.cached, true);
  assert.notEqual(StreamController.cacheControlFor(result), 'no-store');
});

test('um hash lento não apaga o selo dos que o TorBox já respondeu', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [sourceStream(HASH), sourceStream(OTHER)];
  TorboxService.checkCachedInfoHashes = (hashes, token, onAnswer) => {
    onAnswer?.(HASH, true);
    return new Promise(() => {});
  };

  const result = await new StreamController().handleStreamRequest(torboxArgs('tt0133098'));
  const byHash = Object.fromEntries(
    result.streams.map((s) => [s.url.includes(HASH) ? 'known' : 'slow', s.behaviorHints.cached])
  );

  assert.deepEqual(byHash, { known: true, slow: false });
  assert.equal(StreamController.cacheControlFor(result), 'no-store', 'falta a resposta do hash lento');
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
