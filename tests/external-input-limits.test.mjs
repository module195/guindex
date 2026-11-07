// Tetos sobre entrada externa (auditoria de segurança de 06/11/2026, C1 e C6).
// Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { StremioAddonProvider } = await import('../dist/services/stremio-addon-provider.js');
const { setupRoutes } = await import('../dist/routes/routes.js');
const { readJsonCapped } = await import('../dist/utils/read-capped.js');

const HASH = 'a'.repeat(40);

async function withAddon(payload, fn) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await fn(new StremioAddonProvider('teste', `http://127.0.0.1:${port}`));
  } finally {
    server.close();
  }
}

test('título de 32 mil dígitos sem unidade não trava o event loop', async () => {
  const payload = JSON.stringify({ streams: [{ title: '1'.repeat(32000), infoHash: HASH }] });
  await withAddon(payload, async (provider) => {
    const started = Date.now();
    const streams = await provider.getStreams('movie', 'tt1');
    assert.equal(streams.length, 1);
    assert.ok(Date.now() - started < 500, `levou ${Date.now() - started} ms`);
  });
});

test('o tamanho continua sendo lido do título', async () => {
  const payload = JSON.stringify({ streams: [{ title: 'Filme 1080p 💾 2.5 GB', infoHash: HASH }] });
  await withAddon(payload, async (provider) => {
    const [stream] = await provider.getStreams('movie', 'tt1');
    assert.equal(stream.size, 2.5 * 1024 ** 3);
  });
});

test('resposta acima do teto de bytes é recusada', async () => {
  const payload = JSON.stringify({ streams: [{ title: 'x'.repeat(3 * 1024 * 1024), infoHash: HASH }] });
  await withAddon(payload, async (provider) => {
    await assert.rejects(provider.getStreams('movie', 'tt1'), /teto/);
  });
});

test('número de streams é limitado', async () => {
  const streams = Array.from({ length: 1000 }, (_, i) => ({ title: `s${i}`, infoHash: HASH }));
  await withAddon(JSON.stringify({ streams }), async (provider) => {
    assert.equal((await provider.getStreams('movie', 'tt1')).length, 200);
  });
});

test('readJsonCapped lê JSON dentro do teto', async () => {
  async function* body() {
    yield Buffer.from('{"a":');
    yield Buffer.from('1}');
  }
  assert.deepEqual(await readJsonCapped(body(), 100), { a: 1 });
});

test('/resolve recusa token gigante antes de qualquer chamada ao debrid', async () => {
  const saved = process.env.ADDON_ACCESS_KEY;
  delete process.env.ADDON_ACCESS_KEY;
  try {
    const app = setupRoutes();
    const res = await app.inject({
      method: 'GET',
      url: `/resolve?token=${'t'.repeat(8000)}&magnet=magnet:?xt=urn:btih:${HASH}`
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Invalid debrid token/);
    await app.close();
  } finally {
    if (saved !== undefined) process.env.ADDON_ACCESS_KEY = saved;
  }
});
