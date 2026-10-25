// Cache da resposta do /stream: fresco, antigo com atualização em segundo
// plano, busca vazia mantendo a anterior. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Lidos no import do módulo
process.env.STREAM_CACHE_TTL_MS = '60';
process.env.STREAM_CACHE_STALE_MS = '10000';

const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { notifyLateResults } = await import('../dist/services/torrent-indexer-shared.js');

const original = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  fetchCached: RealDebridService.fetchCachedInfoHashes,
  torboxCheck: TorboxService.checkCachedInfoHashes,
};
afterEach(() => {
  SourceService.fetchStreamsFromAllSources = original.fetchStreams;
  RealDebridService.fetchCachedInfoHashes = original.fetchCached;
  TorboxService.checkCachedInfoHashes = original.torboxCheck;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stream = (title, hash) => ({ title, infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}` });
const rdArgs = (id) => ({ type: 'movie', id, extra: { debridProvider: 'realdebrid', realdebridToken: 'tok-cache-0123456789abcdef' } });
const tbArgs = (id) => ({ type: 'movie', id, extra: { debridProvider: 'torbox', torboxToken: 'tok-cache-0123456789abcdef' } });
const availability = (cached = [], unknown = []) => ({ cached: new Set(cached), unknown: new Set(unknown) });

test('dentro do TTL a resposta sai do cache sem nova busca', async () => {
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    return [stream('a', '1'.repeat(40))];
  };
  RealDebridService.fetchCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  const first = await controller.handleStreamRequest(rdArgs('tt1000001'));
  const second = await controller.handleStreamRequest(rdArgs('tt1000001'));
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.match(StreamController.cacheControlFor(first), /^private, max-age=0, stale-while-revalidate=9, stale-if-error=9$/);
});

test('depois do TTL sai a resposta antiga na hora e a nova chega no pedido seguinte', async () => {
  let version = 'v1';
  SourceService.fetchStreamsFromAllSources = async () => [stream(version, '2'.repeat(40))];
  RealDebridService.fetchCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt1000002'));

  await sleep(80);
  version = 'v2';
  const stale = await controller.handleStreamRequest(rdArgs('tt1000002'));
  assert.ok(stale.streams[0].title.includes('v1'), stale.streams[0].title);

  await sleep(20);
  const fresh = await controller.handleStreamRequest(rdArgs('tt1000002'));
  assert.ok(fresh.streams[0].title.includes('v2'), fresh.streams[0].title);
});

test('busca nova vazia mantém a resposta anterior', async () => {
  let streams = [stream('ok', '3'.repeat(40))];
  SourceService.fetchStreamsFromAllSources = async () => streams;
  RealDebridService.fetchCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt1000003'));

  streams = [];
  const result = await controller.handleStreamRequest({ ...rdArgs('tt1000003'), extra: { ...rdArgs('tt1000003').extra, forceFresh: true } });
  assert.equal(result.streams.length, 1);
});

test('fresh=1 ignora o cache', async () => {
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    return [stream(`c${calls}`, '4'.repeat(40))];
  };
  RealDebridService.fetchCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt1000004'));
  const forced = await controller.handleStreamRequest({ ...rdArgs('tt1000004'), extra: { ...rdArgs('tt1000004').extra, forceFresh: true } });
  assert.equal(calls, 2);
  assert.ok(forced.streams[0].title.includes('c2'));
});

test('stream bloqueado pelo RD depois de guardado some da resposta do cache', async () => {
  const blocked = '5'.repeat(40);
  SourceService.fetchStreamsFromAllSources = async () => [stream('x', blocked), stream('y', '6'.repeat(40))];
  RealDebridService.fetchCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  const first = await controller.handleStreamRequest(rdArgs('tt1000005'));
  assert.equal(first.streams.length, 2);

  RealDebridService.markBlocked(blocked);
  const second = await controller.handleStreamRequest(rdArgs('tt1000005'));
  assert.equal(second.streams.length, 1);
  assert.ok(!second.streams[0].url.includes(blocked));
});

test('resposta vazia não é guardada', async () => {
  assert.equal(StreamController.cacheControlFor({ streams: [] }), 'no-store');
});

test('multi atrasado com streams novos descarta a resposta guardada do título', async () => {
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    return [stream(`r${calls}`, '9'.repeat(40))];
  };
  RealDebridService.fetchCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt1000009'));
  await controller.handleStreamRequest(rdArgs('tt1000010'));

  notifyLateResults('movie', 'tt1000009');
  const again = await controller.handleStreamRequest(rdArgs('tt1000009'));
  assert.equal(calls, 3, 'o título avisado busca de novo');
  assert.ok(again.streams[0].title.includes('r3'), again.streams[0].title);
  await controller.handleStreamRequest(rdArgs('tt1000010'));
  assert.equal(calls, 3, 'os outros títulos seguem no cache');
});

test('resposta sem a checagem do TorBox: o próximo pedido sai do cache na hora e a refaz em segundo plano', async () => {
  const hash = 'b'.repeat(40);
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    return [stream('tb', hash)];
  };
  let torboxUp = false;
  TorboxService.checkCachedInfoHashes = async () => (torboxUp ? availability([hash]) : availability([], [hash]));
  const controller = new StreamController();

  const first = await controller.handleStreamRequest(tbArgs('tt1000011'));
  assert.equal(first.streams[0].behaviorHints.cached, false);
  assert.equal(StreamController.cacheControlFor(first), 'no-store');

  torboxUp = true;
  const second = await controller.handleStreamRequest(tbArgs('tt1000011'));
  assert.equal(second.streams[0].behaviorHints.cached, false, 'sai a resposta guardada, sem esperar');
  assert.equal(calls, 2, 'e a busca refaz em segundo plano');

  await sleep(20);
  const third = await controller.handleStreamRequest(tbArgs('tt1000011'));
  assert.equal(third.streams[0].behaviorHints.cached, true);
  assert.equal(calls, 2, 'a resposta completa fica no cache');
});

test('resposta sem a checagem do TorBox não substitui a completa ainda válida', async () => {
  const hash = 'c'.repeat(40);
  SourceService.fetchStreamsFromAllSources = async () => [stream('tb', hash)];
  let torboxUp = true;
  TorboxService.checkCachedInfoHashes = async () => (torboxUp ? availability([hash]) : availability([], [hash]));
  const controller = new StreamController();

  const first = await controller.handleStreamRequest(tbArgs('tt1000012'));
  assert.equal(first.streams[0].behaviorHints.cached, true);

  await sleep(80);
  torboxUp = false;
  await controller.handleStreamRequest(tbArgs('tt1000012'));
  await sleep(20);
  const after = await controller.handleStreamRequest(tbArgs('tt1000012'));
  assert.equal(after.streams[0].behaviorHints.cached, true);
});
