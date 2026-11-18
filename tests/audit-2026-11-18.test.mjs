// Correções da auditoria de segurança de 18/11/2026 (C1, C4 e N1).
// Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const { StremioAddonProvider } = await import('../dist/services/stremio-addon-provider.js');
const { TorrentParser, MAX_RELEASE_TEXT_CHARS } = await import('../dist/services/torrent-parser.js');
const audio = await import('../dist/services/audio-language.js');
const access = await import('../dist/services/access-key.js');
const { setupRoutes } = await import('../dist/routes/routes.js');

const HASH = 'a'.repeat(40);
const N = 200_000;

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

// C1: as regexes de normalizeStream eram quadráticas sobre texto do addon.
for (const [name, title] of [
  ['url com ) no fim', 'http://a/' + ')'.repeat(N) + 'x'],
  ['domínio', 'a.'.repeat(N / 2)],
  ['bracket', '[' + ')'.repeat(N) + 'x]'],
  ['seeders', 'seed' + ' '.repeat(N) + 'x'],
]) {
  test(`addon: título adversarial (${name}) não trava o event loop`, async () => {
    const payload = JSON.stringify({ streams: [{ title, infoHash: HASH }] });
    await withAddon(payload, async (provider) => {
      const started = Date.now();
      const streams = await provider.getStreams('movie', 'tt1');
      assert.equal(streams.length, 1);
      assert.ok(Date.now() - started < 500, `levou ${Date.now() - started} ms`);
    });
  });
}

test('addon: seeders e fonte continuam sendo lidos do título', async () => {
  const payload = JSON.stringify({
    streams: [{ title: 'Filme 1080p\nseeders: 42\n[bludv.com])', infoHash: HASH }],
  });
  await withAddon(payload, async (provider) => {
    const [stream] = await provider.getStreams('movie', 'tt1');
    assert.equal(stream.seeders, 42);
    assert.equal(stream.source, 'bludv.com');
  });
});

// C4: título raspado (dn do magnet) com U+FEFF passava pelo strings.Fields do Go
// e chegava às regexes do TorrentParser.
test('TorrentParser: payload do indexer tem os textos limitados', () => {
  const parser = new TorrentParser();
  const long = 'Movie.2020.1080p' + '﻿'.repeat(N) + 'x';
  const [item] = parser.normalizeTorrentPayload({
    results: [{ title: long, original_title: long, files: [{ path: long }] }],
  });
  assert.equal(item.title.length, MAX_RELEASE_TEXT_CHARS);
  assert.equal(item.original_title.length, MAX_RELEASE_TEXT_CHARS);
  assert.equal(item.files[0].path.length, MAX_RELEASE_TEXT_CHARS);
  const dn = parser.extractMagnetDisplayName(`magnet:?xt=urn:btih:${HASH}&dn=${'a'.repeat(N)}`);
  assert.equal(dn.length, MAX_RELEASE_TEXT_CHARS);
});

test('TorrentParser: strips de sufixo são lineares e mantêm o comportamento', () => {
  const parser = new TorrentParser();
  const hostile = 'Movie.2020.1080p' + '﻿'.repeat(N) + 'x';
  const started = Date.now();
  parser.stripAudioSuffix(hostile);
  audio.stripAudioSuffix(hostile);
  assert.ok(Date.now() - started < 200, `levou ${Date.now() - started} ms`);

  assert.equal(parser.stripAudioSuffix('Nome (brazilian) (brazilian)'), 'Nome');
  assert.equal(parser.stripAudioSuffix('Nome (brazilian, eng)'), 'Nome');
  assert.equal(parser.stripAudioSuffix("Nome (Director's Cut)"), "Nome (Director's Cut)");
  assert.equal(parser.stripAudioSuffix('Nome'), 'Nome');
  assert.equal(audio.stripAudioSuffix('Nome (brazilian, eng)  '), 'Nome');
  assert.equal(audio.stripAudioSuffix('Nome (Versão: Estendida)'), 'Nome (Versão: Estendida)');
  assert.equal(audio.stripAudioSuffix('Nome'), 'Nome');
});

// N1: o gate do modo privado decidia pelo caminho normalizado pelo WHATWG.
const KEY = 'chave-de-acesso-0123456789abcdef';
const saved = { ...process.env };
afterEach(() => {
  for (const key of ['ADDON_ACCESS_KEY', 'TORBOX_TOKEN']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const DOT_PATHS = [
  '/resolve/../health',
  '/resolve/%2e%2e/health',
  `/resolve/DUMMYTOKEN0123456789/magnet%3A%3Fxt%3Durn%3Abtih%3A${HASH}\\..\\..\\..\\health`,
];

test('modo privado: caminho com ".." ou "\\" não vale como público', () => {
  process.env.ADDON_ACCESS_KEY = KEY;
  for (const url of DOT_PATHS) assert.equal(access.requestCarriesAccessKey(url), false, url);
  assert.equal(access.requestCarriesAccessKey('/health'), true);
  assert.equal(access.requestCarriesAccessKey('/health?x=1'), true);
  assert.equal(access.requestCarriesAccessKey(`/resolve/../${KEY}/x`), true);
});

function rawRequest(port, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${line}\r\nHost: a\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('modo privado: socket cru com ".." recebe o 404 do gate', async () => {
  process.env.ADDON_ACCESS_KEY = KEY;
  delete process.env.TORBOX_TOKEN;
  const app = setupRoutes();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const { port } = app.server.address();
    for (const path of DOT_PATHS) {
      for (const method of ['HEAD', 'GET']) {
        const res = await rawRequest(port, `${method} ${path} HTTP/1.1`);
        const status = res.split(' ')[1];
        assert.ok(status === '404' || status === '400', `${method} ${path}: ${res.split('\r\n')[0]}`);
        assert.ok(!/x-guindex-probe/i.test(res), `${method} ${path}`);
      }
    }
    const health = await rawRequest(port, 'GET /health HTTP/1.1');
    assert.match(health, /^HTTP\/1\.1 200/);
  } finally {
    await app.close();
  }
});
