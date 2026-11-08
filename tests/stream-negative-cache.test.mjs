// Cache negativo do /stream: vazio limpo fica guardado por pouco tempo; vazio
// com falha, corte ou multi atrasado no caminho, não. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Lidos no import do módulo
process.env.STREAM_CACHE_TTL_MS = '120000';
process.env.STREAM_CACHE_STALE_MS = '600000';
process.env.STREAM_NEGATIVE_TTL_MS = '1000';
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '600';

const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');
const { noteIncompleteSearch, notifyLateResults, markLateResultsPending } = await import(
  '../dist/services/torrent-indexer-shared.js'
);

const original = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  rdCheck: RealDebridService.checkCachedInfoHashes,
};
afterEach(() => {
  SourceService.fetchStreamsFromAllSources = original.fetchStreams;
  RealDebridService.checkCachedInfoHashes = original.rdCheck;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stream = (title, hash) => ({ title, infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}` });
const rdArgs = (id, extra = {}) => ({
  type: 'movie',
  id,
  extra: { debridProvider: 'realdebrid', realdebridToken: 'tok-neg-0123456789abcdef', ...extra },
});

const countingSource = (impl) => {
  const state = { calls: 0 };
  SourceService.fetchStreamsFromAllSources = async (...args) => {
    state.calls++;
    return impl(...args);
  };
  RealDebridService.checkCachedInfoHashes = async () => new Set();
  return state;
};

test('vazio limpo: o pedido seguinte sai do cache, com max-age curto e sem stale', async () => {
  const src = countingSource(async () => []);
  const controller = new StreamController();
  const first = await controller.handleStreamRequest(rdArgs('tt2000001'));
  const second = await controller.handleStreamRequest(rdArgs('tt2000001'));
  assert.equal(first.streams.length, 0);
  assert.equal(second.streams.length, 0);
  assert.equal(src.calls, 1);
  assert.equal(
    StreamController.cacheControlFor(first, { type: 'movie', id: 'tt2000001' }),
    'private, max-age=1',
  );
});

test('vazio limpo expira no TTL negativo e a busca roda de novo', async () => {
  const src = countingSource(async () => []);
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt2000002'));
  await sleep(1100);
  await controller.handleStreamRequest(rdArgs('tt2000002'));
  assert.equal(src.calls, 2);
});

test('vazio depois de falha no caminho não fica guardado (no-store)', async () => {
  const src = countingSource(async () => {
    noteIncompleteSearch();
    return [];
  });
  const controller = new StreamController();
  const first = await controller.handleStreamRequest(rdArgs('tt2000003'));
  await controller.handleStreamRequest(rdArgs('tt2000003'));
  assert.equal(src.calls, 2);
  assert.equal(StreamController.cacheControlFor(first, { type: 'movie', id: 'tt2000003' }), 'no-store');
});

test('falha anterior ao início da busca não impede o cache negativo', async () => {
  noteIncompleteSearch();
  await sleep(5);
  const src = countingSource(async () => []);
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt2000004'));
  await controller.handleStreamRequest(rdArgs('tt2000004'));
  assert.equal(src.calls, 1);
});

test('vazio com multi atrasado pendente não fica guardado', async () => {
  let done;
  const src = countingSource(async () => {
    done ??= markLateResultsPending('movie', 'tt2000005');
    return [];
  });
  const controller = new StreamController();
  const first = await controller.handleStreamRequest(rdArgs('tt2000005'));
  await controller.handleStreamRequest(rdArgs('tt2000005'));
  assert.equal(src.calls, 2);
  assert.equal(StreamController.cacheControlFor(first, { type: 'movie', id: 'tt2000005' }), 'no-store');
  done();
});

test('vazio não substitui a resposta com streams ainda válida', async () => {
  let streams = [stream('ok', 'a'.repeat(40))];
  const src = countingSource(async () => streams);
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt2000006'));
  streams = [];
  const forced = await controller.handleStreamRequest(rdArgs('tt2000006', { forceFresh: true }));
  assert.equal(forced.streams.length, 1, 'busca nova vazia devolve a anterior');
  const after = await controller.handleStreamRequest(rdArgs('tt2000006'));
  assert.equal(after.streams.length, 1, 'o cache segue com a resposta com streams');
  assert.equal(src.calls, 2);
});

test('multi atrasado com resultados descarta o vazio guardado', async () => {
  let streams = [];
  const src = countingSource(async () => streams);
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt2000007'));
  notifyLateResults('movie', 'tt2000007', ['b'.repeat(40)]);
  streams = [stream('late', 'b'.repeat(40))];
  const next = await controller.handleStreamRequest(rdArgs('tt2000007'));
  assert.equal(src.calls, 2);
  assert.equal(next.streams.length, 1);
});
