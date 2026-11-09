// deadline_ms do /indexers/multi alinhado ao corte da Fase 2 com o cache vazio.
// Arquivo próprio porque precisa do PHASE3_MIN_MS padrão (1500 ms): com o
// valor curto de search-phases (500 ms), o prazo antigo já cabia no corte.
// Roda contra o build: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '0';
process.env.TORRENT_INDEXER_PHASE3_MIN_MS = '1500';
delete process.env.TORRENT_INDEXER_MULTI_RTT_MARGIN_MS;

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const IMDB = 'tt0133093';
const hash = (c) => c.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCES_V2 = {
  indexer_names: ['torrent-dos-filmes', 'comando_torrents', 'betor'],
  api_version: 2,
  indexers: [
    { name: 'torrent-dos-filmes', supports_text: true, supports_imdb: false, healthy: true },
    { name: 'comando_torrents', supports_text: true, supports_imdb: false, healthy: true },
    { name: 'betor', supports_text: false, supports_imdb: true, healthy: true },
  ],
  features: { multi: true },
};

const torrent = (h, title) => ({
  title,
  year: '1999',
  details: `https://example.invalid/${h.slice(0, 6)}`,
  magnet_link: `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(title)}`,
  info_hash: h,
  audio: ['Português'],
  size: '2 GB',
  seed_count: 10,
});

function startServer(routes) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(url);
    const handler = routes[url.pathname] ?? (url.pathname.startsWith('/indexers/') ? routes['/indexers/*'] : undefined);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    const [status, body] = await handler(url);
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => { server.closeAllConnections(); server.close(); } });
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
  TorrentIndexerProvider.searchCache.clear();
  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix Brasil', 'The Matrix'] });
});

test('multi que usa o deadline_ms inteiro chega antes do corte da Fase 2 (cache vazio)', async (t) => {
  // O torrent-indexer corta o multi no deadline_ms. Com o prazo antigo
  // (orçamento − 1 s), ele chegava ~600 ms depois de a Fase 2 desistir
  // (resto − PHASE3_MIN_MS − folga) e a Fase 3 rodava à toa.
  let deadlineMs = 0;
  const srv = await startServer({
    '/sources': async () => [200, SOURCES_V2],
    '/search': async () => [200, { results: [] }],
    '/indexers/multi': async (url) => {
      deadlineMs = Number(url.searchParams.get('deadline_ms'));
      await sleep(deadlineMs);
      const results = [{ ...torrent(hash('c'), 'Matrix 1999 2160p'), found_in: ['comando_torrents'] }];
      return [200, { results, count: 1, partial: true, calls: [] }];
    },
    '/indexers/*': async () => [200, { results: [torrent(hash('d'), 'Matrix 1999 1080p')] }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', IMDB);
  // orçamento 3000 − 1500 − folga 100 − margem 300, menos o que já passou
  assert.ok(deadlineMs > 500 && deadlineMs <= 1100, `deadline_ms=${deadlineMs}`);
  assert.equal(streams.length, 1, 'o multi chegou na Fase 2');
  assert.equal(streams[0].quality, '4K');
  assert.equal(srv.calls.filter((u) => /^\/indexers\/(?!multi)/.test(u.pathname)).length, 0, 'a Fase 3 não precisou rodar');
});
