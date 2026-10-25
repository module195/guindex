// Arquivo bloqueado pelo Real-Debrid (error_code 35, infringing_file): cache
// negativo, stream escondido na próxima listagem e 451 no play. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.STREMIO_ADDON_SOURCES = '[]';
process.env.REALDEBRID_TOKEN = 'token-env';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const { RealDebridService, RealDebridBlockedError } = await import('../dist/services/realdebrid-service.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SOURCES } = await import('../dist/config/sources.js');
const { setupRoutes } = await import('../dist/routes/routes.js');

const rd = mockAgent.get('https://api.real-debrid.com');
const blockedBody = JSON.stringify({ error: 'infringing_file', error_code: 35 });
const files = [
  { id: 1, path: '/Show.S01E01.1080p.mkv', bytes: 1_000_000_000, selected: 1 },
  { id: 2, path: '/Show.S01E02.1080p.mkv', bytes: 1_000_000_000, selected: 1 },
];
const ep1 = { type: 'series', season: 1, episode: 1 };
const ep2 = { type: 'series', season: 1, episode: 2 };

test('unrestrict com error_code 35 lança RealDebridBlockedError e marca hash + episódio', async () => {
  const hash = '1'.repeat(40);
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' }).reply(200, []);
  rd.intercept({ path: '/rest/1.0/torrents/addMagnet', method: 'POST' }).reply(201, { id: 'B1' });
  rd.intercept({ path: '/rest/1.0/torrents/info/B1', method: 'GET' })
    .reply(200, { id: 'B1', status: 'downloaded', files, links: ['b1'] })
    .persist();
  rd.intercept({ path: '/rest/1.0/torrents/selectFiles/B1', method: 'POST' }).reply(204, '');
  rd.intercept({ path: '/rest/1.0/unrestrict/link', method: 'POST' }).reply(503, blockedBody);

  await assert.rejects(
    new RealDebridService('token-a').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${hash}`, ep1),
    RealDebridBlockedError
  );
  assert.equal(RealDebridService.isBlocked(hash, ep1), true);
  assert.equal(RealDebridService.isBlocked(hash, ep2), false, 'outro episódio do mesmo pack segue liberado');

  // Segundo play não chama a API (sem intercept, o MockAgent recusaria a conexão)
  await assert.rejects(
    new RealDebridService('token-b').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${hash}`, ep1),
    RealDebridBlockedError
  );
});

test('bloqueio no torrent já da conta não cai para addMagnet', async () => {
  const hash = '2'.repeat(40);
  let added = 0;
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' })
    .reply(200, [{ id: 'C1', hash, status: 'downloaded' }]);
  rd.intercept({ path: '/rest/1.0/torrents/info/C1', method: 'GET' })
    .reply(200, { id: 'C1', status: 'downloaded', files, links: ['c1', 'c2'] });
  rd.intercept({ path: '/rest/1.0/unrestrict/link', method: 'POST' }).reply(503, blockedBody);
  rd.intercept({ path: '/rest/1.0/torrents/addMagnet', method: 'POST' })
    .reply(() => {
      added++;
      return { statusCode: 201, data: { id: 'C2' } };
    });

  await assert.rejects(
    new RealDebridService('token-c').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${hash}`, ep2),
    RealDebridBlockedError
  );
  assert.equal(added, 0);
  assert.equal(RealDebridService.isBlocked(hash, ep2), true);
});

test('erro comum do RD continua sendo Error, sem marcar bloqueio', async () => {
  const hash = '3'.repeat(40);
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' }).reply(200, []);
  rd.intercept({ path: '/rest/1.0/torrents/addMagnet', method: 'POST' })
    .reply(503, JSON.stringify({ error: 'service_unavailable', error_code: 25 }));

  await assert.rejects(
    new RealDebridService('token-d').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${hash}`),
    (error) => !(error instanceof RealDebridBlockedError)
  );
  assert.equal(RealDebridService.isBlocked(hash), false);
});

test('listagem esconde o stream bloqueado e mantém os outros', async () => {
  const blocked = '4'.repeat(40);
  const ok = '5'.repeat(40);
  RealDebridService.markBlocked(blocked);
  SOURCES.splice(0, SOURCES.length, {
    name: 'GuIndex',
    getStreams: async () => [
      { title: 'bloqueado', infoHash: blocked },
      { title: 'liberado', infoHash: ok },
    ],
  });
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' }).reply(200, []).persist();

  const { streams } = await new StreamController().handleStreamRequest({ type: 'movie', id: 'tt0000001' });
  const urls = streams.map((s) => s.url ?? '');
  assert.equal(streams.length, 1);
  assert.ok(urls[0].includes(ok), urls[0]);
});

test('resolve de arquivo bloqueado responde 451 com mensagem clara', async () => {
  const hash = '6'.repeat(40);
  RealDebridService.markBlocked(hash);
  const app = setupRoutes();
  const res = await app.inject({
    method: 'GET',
    url: `/realdebrid/token-e/resolve?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${hash}`)}`,
  });
  assert.equal(res.statusCode, 451);
  assert.equal(res.json().error, 'infringing_file');
  await app.close();
});
