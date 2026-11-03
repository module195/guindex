// Catálogo do /sources?v=2: um pedido em voo, o antigo enquanto atualiza, pausa
// depois de falha e multi sem lista quando não há catálogo. Roda contra o build: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '0';
process.env.TORRENT_INDEXER_SOURCES_TIMEOUT_MS = '500';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const IMDB = 'tt0133093';
const h = (c) => c.repeat(40);
const torrent = (c, title) => ({
  title,
  year: '1999',
  indexer: 'betor',
  details: `https://example.invalid/${c}`,
  magnet_link: `magnet:?xt=urn:btih:${h(c)}`,
  info_hash: h(c),
  audio: ['Português'],
  size: '2 GB',
  seed_count: 10,
});
const SOURCES_V2 = {
  api_version: 2,
  features: { multi: true },
  indexer_names: ['betor'],
  indexers: [{ name: 'betor', supports_text: true, supports_imdb: true, healthy: true }],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(sources) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(url);
    if (url.pathname === '/sources') {
      const [delay, status] = sources();
      await sleep(delay);
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(SOURCES_V2));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/indexers/multi') {
      res.end(JSON.stringify({ results: [torrent('a', 'Matrix 1999 1080p')], count: 1, calls: [] }));
      return;
    }
    res.end(JSON.stringify({ results: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        count: (path) => calls.filter((u) => u.pathname === path).length,
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
  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix'] });
});

test('/sources com erro: o multi sai sem lista de indexers e a busca ao vivo funciona', async (t) => {
  const srv = await startServer(() => [0, 500]);
  t.after(srv.close);
  const streams = await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  const multi = srv.calls.find((u) => u.pathname === '/indexers/multi');
  assert.ok(multi, 'o multi foi chamado');
  assert.equal(multi.searchParams.has('indexers'), false);
});

test('/sources sem resposta não segura a busca além do timeout curto', async (t) => {
  const srv = await startServer(() => [5000, 200]);
  t.after(srv.close);
  const started = Date.now();
  const streams = await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  assert.ok(Date.now() - started < 1500, `respondeu em ${Date.now() - started}ms`);
});

test('pedidos simultâneos dividem uma consulta ao /sources', async (t) => {
  const srv = await startServer(() => [200, 200]);
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);
  await Promise.all([1, 2, 3, 4, 5].map(() => provider.getStreams('movie', IMDB)));
  assert.equal(srv.count('/sources'), 1);
});

test('depois de uma falha, o /sources fica um tempo sem ser chamado', async (t) => {
  const srv = await startServer(() => [0, 500]);
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);
  await provider.getStreams('movie', IMDB);
  await provider.getStreams('movie', IMDB);
  assert.equal(srv.count('/sources'), 1);
});

test('catálogo vencido: sai o antigo na hora e atualiza em segundo plano', async (t) => {
  const srv = await startServer(() => [1000, 200]);
  t.after(srv.close);
  TorrentIndexerProvider.indexerCatalogCache = {
    ts: Date.now() - 10 * 60 * 1000,
    multi: true,
    indexers: [{ name: 'betor', supportsText: true, supportsImdb: true, healthy: true }],
  };
  const started = Date.now();
  const streams = await new TorrentIndexerProvider('GuIndex', srv.base).getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  assert.ok(Date.now() - started < 800, `não esperou o /sources lento (${Date.now() - started}ms)`);
  const multi = srv.calls.find((u) => u.pathname === '/indexers/multi');
  assert.equal(multi.searchParams.get('indexers'), 'betor');
  assert.equal(srv.count('/sources'), 1, 'a atualização saiu em segundo plano');
});
