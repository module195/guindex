// Play mais rápido: IP do usuário no TorBox (CDN mais perto), sources com trackers
// nos streams e link resolvido reaproveitado. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.STREMIO_ADDON_SOURCES = '[]';
process.env.TORBOX_WAIT_VIDEO_URL = 'https://wait.example/downloading.mp4';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const { publicClientIp } = await import('../dist/services/client-ip.js');
const { StreamService } = await import('../dist/services/stream-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { setupRoutes } = await import('../dist/routes/routes.js');

const torbox = mockAgent.get('https://api.torbox.app');
const query = (path) => new URL(path, 'https://api.torbox.app').searchParams;

const original = {
  magnet: TorboxService.prototype.processMagnetToDirectUrl,
  play: StreamController.prototype.processLinkForPlayback,
};
afterEach(() => {
  TorboxService.prototype.processMagnetToDirectUrl = original.magnet;
  StreamController.prototype.processLinkForPlayback = original.play;
});

test('publicClientIp aceita só IP público', () => {
  assert.equal(publicClientIp('177.10.20.30'), '177.10.20.30');
  assert.equal(publicClientIp('::ffff:177.10.20.30'), '177.10.20.30');
  assert.equal(publicClientIp('2804:14c::1'), '2804:14c::1');
  for (const ip of ['10.0.0.5', '172.18.0.2', '192.168.1.10', '127.0.0.1', '100.64.1.1', '169.254.0.1', '::1', 'fd00::1', 'fe80::1', '', undefined, 'abc']) {
    assert.equal(publicClientIp(ip), undefined, String(ip));
  }
});

test('sources junta os trackers do magnet e do indexer, sem repetir, e o nó DHT', () => {
  const hash = 'a'.repeat(40);
  const sources = StreamService.buildSources(
    {
      magnet: `magnet:?xt=urn:btih:${hash}&dn=x&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=wss%3A%2F%2Fignored`,
      trackers: ['udp://tracker.opentrackr.org:1337/announce', 'https://tracker.example/announce', ''],
    },
    hash
  );
  assert.deepEqual(sources, [
    'tracker:udp://tracker.opentrackr.org:1337/announce',
    'tracker:https://tracker.example/announce',
    `dht:${hash}`,
  ]);
});

test('stream formatado leva sources quando tem infoHash', () => {
  const hash = 'b'.repeat(40);
  const stream = StreamService.createStreamMetadata(
    { title: 'Filme.2024.1080p', infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, trackers: ['udp://t.example:80/announce'] },
    `magnet:?xt=urn:btih:${hash}`
  );
  assert.deepEqual(stream.sources, ['tracker:udp://t.example:80/announce', `dht:${hash}`]);
});

test('requestdl do TorBox leva o user_ip', async () => {
  const id = 71;
  const seen = [];
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/mylist') && !query(p).has('id'), method: 'GET' })
    .reply(200, { success: true, data: [{ id, hash: 'c'.repeat(40) }] });
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/mylist') && query(p).get('id') === String(id), method: 'GET' })
    .reply(200, { success: true, data: { id, download_present: true, files: [{ id: 0, name: 'Filme.mkv', size: 1 }] } });
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/requestdl') && (seen.push(query(p).get('user_ip')), true), method: 'GET' })
    .reply(200, { success: true, data: 'https://cdn.example/71.mkv' });

  const result = await new TorboxService('token-ip', { userIp: '177.10.20.30' }).processMagnetToDirectUrl(
    `magnet:?xt=urn:btih:${'c'.repeat(40)}`
  );
  assert.equal(result.url, 'https://cdn.example/71.mkv');
  assert.ok(seen.includes('177.10.20.30'), `user_ip enviado: ${seen}`);
});

test('plays iguais ao mesmo tempo resolvem uma vez só, e o link pronto é reaproveitado', async () => {
  let calls = 0;
  TorboxService.prototype.processMagnetToDirectUrl = async function () {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { url: 'https://cdn.example/pronto.mkv', ready: true };
  };
  const controller = new StreamController();
  const params = { magnet: `magnet:?xt=urn:btih:${'d'.repeat(40)}`, token: 'token-sf', provider: 'torbox', userIp: '177.1.1.1' };

  const [a, b] = await Promise.all([controller.processLinkForPlayback(params), controller.processLinkForPlayback(params)]);
  assert.equal(a, 'https://cdn.example/pronto.mkv');
  assert.equal(b, a);
  assert.equal(calls, 1);

  assert.equal(await controller.processLinkForPlayback(params), a);
  assert.equal(calls, 1, 'segundo play sai do cache');

  await controller.processLinkForPlayback({ ...params, userIp: '200.2.2.2' });
  assert.equal(calls, 2, 'outro IP pode ter outro CDN');
});

test('vídeo de espera não fica no cache', async () => {
  let calls = 0;
  TorboxService.prototype.processMagnetToDirectUrl = async function () {
    calls++;
    return { url: 'https://wait.example/downloading.mp4', ready: false };
  };
  const controller = new StreamController();
  const params = { magnet: `magnet:?xt=urn:btih:${'e'.repeat(40)}`, token: 'token-wait', provider: 'torbox' };
  await controller.processLinkForPlayback(params);
  await controller.processLinkForPlayback(params);
  assert.equal(calls, 2);
});

test('resolve passa o IP do X-Forwarded-For (proxy confiável) e descarta IP interno', async () => {
  const seen = [];
  StreamController.prototype.processLinkForPlayback = async function (params) {
    seen.push(params.userIp);
    return 'https://cdn.example/ok.mkv';
  };
  const app = setupRoutes();
  const url = `/torbox/token-route-0123456789abcdef/resolve?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'f'.repeat(40)}`)}`;

  const res = await app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': '177.10.20.30' } });
  assert.equal(res.statusCode, 302);
  await app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': '10.0.0.8' } });
  assert.deepEqual(seen, ['177.10.20.30', undefined]);
  await app.close();
});
