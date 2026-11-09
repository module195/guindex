// Integração guindex ↔ torrent-indexer (auditoria de feature de 09/11/2026):
// IF-02 (Fase 3 sem histórico usa tier/p50_ms do /sources?v=2) e IF-05 (teto de
// bytes nas respostas do torrent-indexer). Roda contra o build: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '0';
process.env.TORRENT_INDEXER_SOURCES_TIMEOUT_MS = '500';
process.env.TORRENT_INDEXER_MAX_BODY_BYTES = '65536';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const IMDB = 'tt0133093';
const h = (c) => c.repeat(40);
const torrent = (c, title, indexer = 'betor') => ({
  title,
  year: '1999',
  indexer,
  details: `https://example.invalid/${c}`,
  magnet_link: `magnet:?xt=urn:btih:${h(c)}`,
  info_hash: h(c),
  audio: ['Português'],
  size: '2 GB',
  seed_count: 10,
});

// Mesma forma do /sources?v=2 real (api/capabilities.go IndexerStatus).
const entry = (name, tier, p50) => ({
  name, supports_text: true, supports_imdb: false, tier, healthy: true,
  consecutive_failures: 0, samples: p50 === undefined ? 0 : 5,
  ...(p50 === undefined ? {} : { p50_ms: p50 }),
});
const CATALOG = {
  api_version: 2,
  features: { multi: false },
  indexers: [
    entry('baixarapido', 'reserve', 200),
    entry('betor', 'primary'),
    entry('bludv_ru', 'primary', 2500),
    entry('comando_torrents', 'reserve', 150),
    entry('rede_torrent', 'primary', 400),
    entry('starck-filmes', 'primary', 900),
    entry('torrent-dos-filmes', 'reserve', 100),
    entry('torrentfilmeshds', 'secondary', 300),
  ],
};

function startServer(routes) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(url);
    const route = routes[url.pathname] ?? (url.pathname.startsWith('/indexers/') ? routes['/indexers/*'] : undefined);
    const [status, body] = route ? route(url) : [200, { results: [] }];
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

beforeEach(() => {
  TorrentIndexerProvider.indexerCatalogCache = undefined;
  TorrentIndexerProvider.indexerCatalogInFlight = undefined;
  TorrentIndexerProvider.indexerCatalogFailedAt = 0;
  TorrentIndexerProvider.indexerNamesCache = undefined;
  TorrentIndexerProvider.indexerPerformance.clear();
  TorrentIndexerProvider.indexerFailureState.clear();
  TorrentIndexerProvider.searchCache?.clear?.();
  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix'] });
});

const phase3Indexers = (calls) => [...new Set(calls
  .map((u) => u.pathname)
  .filter((p) => p.startsWith('/indexers/') && p !== '/indexers/multi')
  .map((p) => p.slice('/indexers/'.length)))];

test('IF-02: sem histórico local, a Fase 3 escolhe primários por p50_ms, não por ordem alfabética', async (t) => {
  const srv = await startServer({ '/sources': () => [200, CATALOG] });
  t.after(srv.close);
  await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  const picked = phase3Indexers(srv.calls);
  assert.ok(picked.length > 0, 'a Fase 3 rodou');
  for (const reserve of ['baixarapido', 'comando_torrents', 'torrent-dos-filmes']) {
    assert.ok(!picked.includes(reserve), `reserva ${reserve} não devia entrar antes dos primários (${picked})`);
  }
  assert.deepEqual(picked.slice(0, 3), ['rede_torrent', 'starck-filmes', 'bludv_ru']);
});

test('IF-02: histórico local continua mandando sobre o catálogo', async (t) => {
  const srv = await startServer({ '/sources': () => [200, CATALOG] });
  t.after(srv.close);
  TorrentIndexerProvider.indexerPerformance.set('bludv_ru', {
    avgMs: 100, samples: 10, hits: 10, emptyHits: 0, lastDurationMs: 100,
  });
  await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  assert.equal(phase3Indexers(srv.calls)[0], 'bludv_ru');
});

test('IF-05: /sources acima do teto vira falha do catálogo (multi sem lista)', async (t) => {
  const huge = JSON.stringify({ ...CATALOG, features: { multi: true }, pad: 'x'.repeat(200_000) });
  const srv = await startServer({
    '/sources': () => [200, huge],
    '/indexers/multi': () => [200, { results: [torrent('a', 'Matrix 1999 1080p')], count: 1, calls: [] }],
  });
  t.after(srv.close);
  const streams = await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  const multi = srv.calls.find((u) => u.pathname === '/indexers/multi');
  assert.ok(multi, 'o multi foi chamado');
  assert.equal(multi.searchParams.has('indexers'), false, 'catálogo grande demais foi descartado');
});

test('IF-05: resposta de indexer acima do teto é descartada e conta como falha', async (t) => {
  const big = JSON.stringify({ results: [torrent('b', 'Matrix 1999 1080p ' + 'x'.repeat(200_000), 'rede_torrent')] });
  const srv = await startServer({
    '/sources': () => [200, CATALOG],
    '/indexers/rede_torrent': () => [200, big],
  });
  t.after(srv.close);
  const streams = await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  assert.equal(streams.length, 0);
  assert.ok(TorrentIndexerProvider.indexerFailureState.has('rede_torrent'), 'falha registrada');
});

test('IF-08: domínio do details reconhece os indexers ativos do torrent-indexer', () => {
  const provider = new TorrentIndexerProvider('GuIndex', 'http://127.0.0.1:1');
  const indexerOf = (details) => provider.extractIndexerRawName({ title: 'x', details });
  assert.equal(indexerOf('https://bludv.ru/filme'), 'bludv_ru');
  assert.equal(indexerOf('https://bludvfilmes1.xyz/filme'), 'bludv_ru');
  assert.equal(indexerOf('https://redestorrents.com/filme'), 'rede_torrent');
  assert.equal(indexerOf('https://starckfilmes-v29.com/filme'), 'starck-filmes');
  assert.equal(indexerOf('https://catalogo.betor.top/filme'), 'betor');
  assert.equal(indexerOf('https://torrentdosfilmes-v2.xyz/filme'), 'torrent-dos-filmes');
  assert.equal(indexerOf('https://comando1.com/filme'), 'comando_torrents');
  assert.equal(indexerOf('https://www.torrentfilmehds.org/filme'), 'torrentfilmeshds');
  assert.equal(indexerOf('https://baixarapido.com/filme'), 'baixarapido');
});
