// Cache da resposta do /stream: fresco, antigo com atualização em segundo
// plano, busca vazia mantendo a anterior. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Lidos no import do módulo
process.env.STREAM_CACHE_TTL_MS = '60';
process.env.STREAM_CACHE_STALE_MS = '10000';
// A espera pelo debrid vai até o fim do orçamento: curto, para o teste não demorar
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '600';

const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { notifyLateResults } = await import('../dist/services/torrent-indexer-shared.js');

const original = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  rdCheck: RealDebridService.checkCachedInfoHashes,
  torboxCheck: TorboxService.checkCachedInfoHashes,
};
afterEach(() => {
  SourceService.fetchStreamsFromAllSources = original.fetchStreams;
  RealDebridService.checkCachedInfoHashes = original.rdCheck;
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
  RealDebridService.checkCachedInfoHashes = async () => new Set();
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
  RealDebridService.checkCachedInfoHashes = async () => new Set();
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
  RealDebridService.checkCachedInfoHashes = async () => new Set();
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
  RealDebridService.checkCachedInfoHashes = async () => new Set();
  const controller = new StreamController();
  await controller.handleStreamRequest(rdArgs('tt1000004'));
  const forced = await controller.handleStreamRequest({ ...rdArgs('tt1000004'), extra: { ...rdArgs('tt1000004').extra, forceFresh: true } });
  assert.equal(calls, 2);
  assert.ok(forced.streams[0].title.includes('c2'));
});

test('stream bloqueado pelo RD depois de guardado some da resposta do cache', async () => {
  const blocked = '5'.repeat(40);
  SourceService.fetchStreamsFromAllSources = async () => [stream('x', blocked), stream('y', '6'.repeat(40))];
  RealDebridService.checkCachedInfoHashes = async () => new Set();
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
  RealDebridService.checkCachedInfoHashes = async () => new Set();
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
  assert.equal(second.streams[0].behaviorHints.cached, false, 'sai a resposta guardada, sem esperar nem consultar');
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

test('resposta parcial: a resposta do TorBox que chega depois vale no pedido seguinte, na hora', async () => {
  const hash = 'd'.repeat(40);
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    return [stream('tb', hash)];
  };
  const late = [];
  TorboxService.checkCachedInfoHashes = (hashes, token, onAnswer) => {
    late.push(() => onAnswer?.(hash, true));
    return new Promise(() => {});
  };
  const controller = new StreamController();

  const first = await controller.handleStreamRequest(tbArgs('tt1000013'));
  assert.equal(first.streams[0].behaviorHints.cached, false);
  assert.equal(StreamController.cacheControlFor(first), 'no-store');

  late[0]();
  const second = await controller.handleStreamRequest(tbArgs('tt1000013'));
  assert.equal(second.streams[0].behaviorHints.cached, true, 'remontada com a resposta que chegou depois');
  assert.notEqual(StreamController.cacheControlFor(second), 'no-store');
  assert.equal(calls, 2, 'e a busca refaz em segundo plano');

  const third = await controller.handleStreamRequest(tbArgs('tt1000013'));
  assert.equal(third.streams[0].behaviorHints.cached, true, 'a remontada completa fica no cache');
});

test('resposta parcial remontada sem a resposta do TorBox continua parcial', async () => {
  const hash = 'e'.repeat(40);
  SourceService.fetchStreamsFromAllSources = async () => [stream('tb', hash)];
  TorboxService.checkCachedInfoHashes = async () => availability([], [hash]);
  const controller = new StreamController();

  await controller.handleStreamRequest(tbArgs('tt1000014'));
  const second = await controller.handleStreamRequest(tbArgs('tt1000014'));
  assert.equal(second.streams[0].behaviorHints.cached, false);
  assert.equal(StreamController.cacheControlFor(second), 'no-store');
});

test('consulta do TorBox que termina depois da resposta: a guardada é remontada e o próximo pedido sai com o selo', async () => {
  const hash = 'f'.repeat(40);
  SourceService.fetchStreamsFromAllSources = async () => [stream('tb', hash)];
  // Responde em 500ms; o pedido espera até 400ms (orçamento 600 menos a folga)
  TorboxService.checkCachedInfoHashes = (hashes, token, onAnswer) =>
    new Promise((resolve) =>
      setTimeout(() => {
        onAnswer?.(hash, true);
        resolve(availability([hash]));
      }, 500)
    );
  const controller = new StreamController();

  const first = await controller.handleStreamRequest(tbArgs('tt1000015'));
  assert.equal(first.streams[0].behaviorHints.cached, false);
  assert.equal(StreamController.cacheControlFor(first), 'no-store');

  await sleep(150);
  TorboxService.checkCachedInfoHashes = () => new Promise(() => {});
  const second = await controller.handleStreamRequest(tbArgs('tt1000015'));
  assert.equal(second.streams[0].behaviorHints.cached, true);
  assert.notEqual(StreamController.cacheControlFor(second), 'no-store');
});

test('Real-Debrid sem a lista da conta: a resposta não fica guardada como definitiva', async () => {
  const hash = '0'.repeat(40);
  SourceService.fetchStreamsFromAllSources = async () => [stream('rd', hash)];
  RealDebridService.checkCachedInfoHashes = async () => undefined;
  const controller = new StreamController();

  const result = await controller.handleStreamRequest(rdArgs('tt1000016'));
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].behaviorHints.realDebridReady, false);
  assert.equal(StreamController.cacheControlFor(result), 'no-store');
});

test('multi atrasado durante a busca: a resposta sai para quem pediu, mas não fica no cache', async () => {
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    const n = calls;
    // O multi termina enquanto a busca ainda espera o debrid
    if (n === 1) setTimeout(() => notifyLateResults('movie', 'tt1000017'), 10);
    return [stream(`m${n}`, '7'.repeat(40))];
  };
  RealDebridService.checkCachedInfoHashes = () => new Promise((resolve) => setTimeout(() => resolve(new Set()), 50));
  const controller = new StreamController();

  const first = await controller.handleStreamRequest(rdArgs('tt1000017'));
  assert.ok(first.streams[0].title.includes('m1'), first.streams[0].title);
  const second = await controller.handleStreamRequest(rdArgs('tt1000017'));
  assert.equal(calls, 2, 'o pedido seguinte busca de novo');
  assert.ok(second.streams[0].title.includes('m2'), second.streams[0].title);
  await controller.handleStreamRequest(rdArgs('tt1000017'));
  assert.equal(calls, 2, 'e a busca nova fica no cache');
});

test('multi atrasado durante a busca com o TorBox lento: a parcial não volta ao cache quando a consulta termina', async () => {
  const hash = '8'.repeat(40);
  let calls = 0;
  SourceService.fetchStreamsFromAllSources = async () => {
    calls++;
    if (calls === 1) setTimeout(() => notifyLateResults('movie', 'tt1000018'), 10);
    return [stream(`p${calls}`, hash)];
  };
  // Responde depois do prazo do pedido (orçamento 600 menos a folga)
  TorboxService.checkCachedInfoHashes = (hashes, token, onAnswer) =>
    new Promise((resolve) =>
      setTimeout(() => {
        onAnswer?.(hash, true);
        resolve(availability([hash]));
      }, 450)
    );
  const controller = new StreamController();

  const first = await controller.handleStreamRequest(tbArgs('tt1000018'));
  assert.equal(StreamController.cacheControlFor(first), 'no-store');
  await sleep(100);
  TorboxService.checkCachedInfoHashes = async () => availability([hash]);
  const second = await controller.handleStreamRequest(tbArgs('tt1000018'));
  assert.equal(calls, 2, 'o pedido seguinte busca de novo, sem sair da resposta desatualizada');
  assert.ok(second.streams[0].title.includes('p2'), second.streams[0].title);
});

test('busca nova parcial atrás de uma completa ainda válida: a substitui quando a consulta do TorBox termina', async () => {
  const hash = '9a'.repeat(20);
  let version = 'v1';
  SourceService.fetchStreamsFromAllSources = async () => [stream(version, hash)];
  TorboxService.checkCachedInfoHashes = async () => availability([hash]);
  const controller = new StreamController();
  await controller.handleStreamRequest(tbArgs('tt1000019'));

  await sleep(80);
  version = 'v2';
  TorboxService.checkCachedInfoHashes = (hashes, token, onAnswer) =>
    new Promise((resolve) =>
      setTimeout(() => {
        onAnswer?.(hash, true);
        resolve(availability([hash]));
      }, 500)
    );
  const stale = await controller.handleStreamRequest(tbArgs('tt1000019'));
  assert.ok(stale.streams[0].title.includes('v1'), stale.streams[0].title);

  // A busca v2 sai parcial perto de 400ms e não substitui a v1; a consulta termina
  // em 500ms e a v2, completa, entra no lugar dela
  await sleep(600);
  const after = await controller.handleStreamRequest(tbArgs('tt1000019'));
  assert.ok(after.streams[0].title.includes('v2'), after.streams[0].title);
  assert.equal(after.streams[0].behaviorHints.cached, true);
});
