// Modo privado (ADDON_ACCESS_KEY): sem a chave a instância responde 404, e o
// token debrid do env nunca aparece na URL nem nos links. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupRoutes } = await import('../dist/routes/routes.js');
const access = await import('../dist/services/access-key.js');
const { TorboxClient } = await import('../dist/services/torbox-client.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');

const KEY = 'chave-de-acesso-0123456789abcdef';
const TB = 'token-torbox-secreto-do-dono';
const RD = 'token-rd-secreto-do-dono';

const saved = { ...process.env };
const ENV_KEYS = ['ADDON_ACCESS_KEY', 'TORBOX_TOKEN', 'REALDEBRID_TOKEN', 'ALLOW_ENV_DEBRID_TOKEN'];
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const privateEnv = () => {
  process.env.ADDON_ACCESS_KEY = KEY;
  process.env.TORBOX_TOKEN = TB;
  delete process.env.REALDEBRID_TOKEN;
  delete process.env.ALLOW_ENV_DEBRID_TOKEN;
};

test('sem ADDON_ACCESS_KEY nada muda: o token passa como veio', () => {
  delete process.env.ADDON_ACCESS_KEY;
  process.env.TORBOX_TOKEN = TB;
  assert.equal(access.isPrivateMode(), false);
  assert.equal(access.debridApiToken(KEY, 'torbox'), KEY);
});

test('a chave vira o token do env só na chamada à API', () => {
  privateEnv();
  process.env.REALDEBRID_TOKEN = RD;
  assert.equal(access.debridApiToken(KEY, 'torbox'), TB);
  assert.equal(access.debridApiToken(KEY, 'realdebrid'), RD);
  assert.equal(access.debridApiToken('outro-token', 'torbox'), 'outro-token');
  assert.equal(new TorboxClient({ token: KEY }).token, TB);
  assert.equal(new RealDebridService(KEY).token, RD);
});

test('requestCarriesAccessKey aceita a chave no caminho ou em ?key=', () => {
  privateEnv();
  assert.equal(access.requestCarriesAccessKey(`/torbox/${KEY}/manifest.json`), true);
  assert.equal(access.requestCarriesAccessKey(`/${KEY}/stream/movie/tt1.json`), true);
  assert.equal(access.requestCarriesAccessKey(`/resolve/${KEY}/magnet`), true);
  assert.equal(access.requestCarriesAccessKey(`/configure?key=${KEY}`), true);
  assert.equal(access.requestCarriesAccessKey(`/torbox/${TB}/manifest.json`), false);
  assert.equal(access.requestCarriesAccessKey(`/torbox/${KEY}x/manifest.json`), false);
  assert.equal(access.requestCarriesAccessKey(`/configure?key=${KEY.slice(0, -1)}`), false);
  assert.equal(access.requestCarriesAccessKey('/health'), true);
});

test('sem a chave, configure, manifest, stream e resolve dão 404', async () => {
  privateEnv();
  const app = setupRoutes();
  for (const url of [
    '/',
    '/configure',
    '/manifest.json',
    `/torbox/${TB}/manifest.json`,
    `/torbox/${TB}/stream/movie/tt0111161.json`,
    '/stream/movie/tt0111161.json',
    `/torbox/${TB}/resolve?magnet=x`,
    `/resolve?token=${TB}&magnet=x`
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.ok(!res.body.includes(TB), url);
  }
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  await app.close();
});

test('com a chave, manifest e configure funcionam sem expor o token', async () => {
  privateEnv();
  const app = setupRoutes();
  const manifest = await app.inject({ method: 'GET', url: `/torbox/${KEY}/manifest.json` });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().behaviorHints.configurationRequired, false);

  const page = await app.inject({ method: 'GET', url: `/configure?key=${KEY}` });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(KEY), 'a página preenche a chave no campo do token');
  assert.ok(!page.body.includes(TB), 'a página nunca mostra o token do env');
  assert.equal(page.headers['cache-control'], 'no-store');

  const script = await app.inject({ method: 'GET', url: '/config-page.js' });
  assert.equal(script.statusCode, 200);
  await app.close();
});

test('o link de resolve leva a chave que veio na URL, não o token do env', async () => {
  privateEnv();
  const { StreamController } = await import('../dist/controllers/stream-controller.js');
  const url = new StreamController().buildResolveUrl({
    base: 'https://warp.example.com',
    token: KEY,
    magnet: 'magnet:?xt=urn:btih:abc',
    provider: 'torbox'
  });
  assert.ok(url.startsWith(`https://warp.example.com/torbox/${KEY}/resolve?`));
  assert.ok(!url.includes(TB));
  assert.equal(access.requestCarriesAccessKey(new URL(url).pathname + new URL(url).search), true);
});
