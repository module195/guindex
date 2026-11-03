// Sem BASE_URL, os links de resolve usam a origem pública do pedido em vez de
// http://localhost, que o player não alcança. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.BASE_URL;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
delete process.env.VERCEL_URL;
delete process.env.RENDER_EXTERNAL_URL;

const { ConfigService } = await import('../dist/services/config-service.js');

test('sem variável de ambiente, baseUrl é localhost e marcado como fallback', () => {
  const config = ConfigService.loadConfig();
  assert.equal(config.baseUrlIsFallback, true);
  assert.match(config.baseUrl, /^http:\/\/localhost:/);
});

test('BASE_URL definido não é fallback', () => {
  process.env.BASE_URL = 'https://guindex.example.com/';
  try {
    const config = ConfigService.loadConfig();
    assert.equal(config.baseUrlIsFallback, false);
    assert.equal(config.baseUrl, 'https://guindex.example.com');
  } finally {
    delete process.env.BASE_URL;
  }
});

test('requestOrigin prefere X-Forwarded-Host/Proto do proxy', () => {
  const origin = ConfigService.requestOrigin(
    { host: 'guindex:7000', 'x-forwarded-host': 'guindex.example.com', 'x-forwarded-proto': 'https, http' },
    'http'
  );
  assert.equal(origin, 'https://guindex.example.com');
});

test('requestOrigin cai no Host e no protocolo da conexão', () => {
  assert.equal(ConfigService.requestOrigin({ host: 'meu-host:8080' }, 'http'), 'http://meu-host:8080');
  assert.equal(ConfigService.requestOrigin({}, 'http'), undefined);
});

const { setupRoutes } = await import('../dist/routes/routes.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');

test('/configure sem BASE_URL usa a origem do pedido em data-base-url', async () => {
  const app = setupRoutes();
  const res = await app.inject({
    method: 'GET',
    url: '/configure',
    headers: { host: 'guindex:7000', 'x-forwarded-host': 'guindex.example.com', 'x-forwarded-proto': 'https' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /data-base-url="https:\/\/guindex\.example\.com"/);
  assert.doesNotMatch(res.body, /data-base-url="http:\/\/localhost/);
  await app.close();
});

test('resolve sem BASE_URL redireciona o placeholder para a origem do pedido', async () => {
  const original = StreamController.prototype.processLinkForPlayback;
  const local = ConfigService.loadConfig().baseUrl;
  StreamController.prototype.processLinkForPlayback = async () => `${local}/placeholder/downloading.mp4`;
  const app = setupRoutes();
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/torbox/tok/resolve?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'a'.repeat(40)}`)}`,
      headers: { host: 'guindex.example.com', 'x-forwarded-proto': 'https' },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, 'https://guindex.example.com/placeholder/downloading.mp4');
  } finally {
    StreamController.prototype.processLinkForPlayback = original;
    await app.close();
  }
});

test('resolve não mexe em URL externa do debrid', async () => {
  const original = StreamController.prototype.processLinkForPlayback;
  StreamController.prototype.processLinkForPlayback = async () => 'https://cdn.torbox.example/file.mkv';
  const app = setupRoutes();
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/torbox/tok/resolve?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${'b'.repeat(40)}`)}`,
      headers: { host: 'guindex.example.com' },
    });
    assert.equal(res.headers.location, 'https://cdn.torbox.example/file.mkv');
  } finally {
    StreamController.prototype.processLinkForPlayback = original;
    await app.close();
  }
});
