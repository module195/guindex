// Fases de busca de getStreams: 1) cache (Meilisearch) + ping no multi,
// 2) multi, 3) indexers mais rápidos. Sobe um torrent-indexer falso local.
// Roda contra o build: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Orçamento curto para os testes não demorarem (lido no import do módulo)
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '0';
process.env.TORRENT_INDEXER_MULTI_GRACE_MS = '300';
process.env.TORRENT_INDEXER_PHASE3_MIN_MS = '500';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const IMDB = 'tt0133093';
const hash = (c) => c.repeat(40);

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

const torrent = (h, title, indexer) => ({
  title,
  year: '1999',
  indexer,
  details: `https://example.invalid/${h.slice(0, 6)}`,
  magnet_link: `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(title)}`,
  info_hash: h,
  audio: ['Português'],
  size: '2 GB',
  seed_count: 10,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// routes: pathname -> async (url) => [status, body]
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
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

beforeEach(() => {
  TorrentIndexerProvider.indexerCatalogCache = undefined;
  TorrentIndexerProvider.indexerNamesCache = undefined;
  TorrentIndexerProvider.indexerPerformance.clear();
  TorrentIndexerProvider.indexerFailureState.clear();
  TorrentIndexerProvider.searchCache.clear();
  // Sem rede: Cinemeta e TMDB vêm do cache
  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix Brasil', 'The Matrix'] });
});

const multiPayload = (results) => ({ results, count: results.length, partial: false, calls: [] });

test('Fase 1: uma chamada /search por query, cada uma com um q só', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, SOURCES_V2],
    '/search': async (url) => [200, {
      results: url.searchParams.get('q') === 'Matrix Brasil'
        ? [torrent(hash('a'), 'Matrix 1999 1080p', 'comando_torrents'), torrent(hash('b'), 'Matrix 1999 720p', 'torrent-dos-filmes')]
        : [],
    }],
    '/indexers/multi': async () => [200, multiPayload([])],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', IMDB);
  const searches = srv.calls.filter((u) => u.pathname === '/search');
  assert.ok(searches.length > 1);
  for (const u of searches) assert.equal(u.searchParams.getAll('q').length, 1);
  assert.deepEqual(searches.map((u) => u.searchParams.get('q')).slice(0, 3).sort(), [IMDB, 'Matrix Brasil', 'The Matrix'].sort());
  assert.equal(streams.length, 2, 'acha pelo título, não só pelo IMDb');
});

test('Fase 1 + 2: cache suficiente junta o multi que volta dentro da janela', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, SOURCES_V2],
    '/search': async (url) => [200, {
      results: url.searchParams.get('q') === IMDB
        ? [torrent(hash('a'), 'Matrix 1999 1080p', 'comando_torrents'), torrent(hash('b'), 'Matrix 1999 720p', 'torrent-dos-filmes')]
        : [],
    }],
    '/indexers/multi': async () => {
      await sleep(50);
      return [200, multiPayload([{ ...torrent(hash('c'), 'Matrix 1999 2160p'), found_in: ['betor'] }])];
    },
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', IMDB);
  assert.equal(streams.length, 3, 'cache (2) + multi (1)');
  const multi = srv.calls.find((u) => u.pathname === '/indexers/multi');
  assert.deepEqual(multi.searchParams.getAll('q'), [IMDB, 'Matrix Brasil', 'The Matrix']);
});

test('Fase 2: com cache suficiente, multi lento não segura a resposta', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, SOURCES_V2],
    '/search': async (url) => [200, {
      results: url.searchParams.get('q') === IMDB
        ? [torrent(hash('a'), 'Matrix 1999 1080p', 'comando_torrents'), torrent(hash('b'), 'Matrix 1999 720p', 'torrent-dos-filmes')]
        : [],
    }],
    '/indexers/multi': async () => {
      await sleep(2500);
      return [200, multiPayload([{ ...torrent(hash('c'), 'Matrix 1999 2160p'), found_in: ['betor'] }])];
    },
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const started = Date.now();
  const streams = await provider.getStreams('movie', IMDB);
  const elapsed = Date.now() - started;
  assert.equal(streams.length, 2);
  assert.ok(elapsed < 1200, `respondeu em ${elapsed}ms (janela de 300ms)`);
});

test('Fase 2: cache vazio espera o multi', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, SOURCES_V2],
    '/search': async () => [200, { results: [] }],
    '/indexers/multi': async () => {
      await sleep(800);
      return [200, multiPayload([{ ...torrent(hash('c'), 'Matrix 1999 2160p'), found_in: ['comando_torrents'] }])];
    },
    '/indexers/*': async () => [500, { error: 'Fase 3 não devia rodar' }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  assert.equal(srv.calls.filter((u) => /^\/indexers\/(?!multi)/.test(u.pathname)).length, 0);
});

test('Fase 3: cache e multi vazios caem nos indexers mais rápidos com as queries extras', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, SOURCES_V2],
    '/search': async () => [200, { results: [] }],
    '/indexers/multi': async () => [200, multiPayload([])],
    '/indexers/*': async (url) => [200, {
      results: url.pathname === '/indexers/comando_torrents' && url.searchParams.get('q') === 'Matrix Brasil 1999'
        ? [torrent(hash('d'), 'Matrix 1999 1080p')]
        : [],
    }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  const perIndexer = srv.calls.filter((u) => /^\/indexers\/(?!multi)/.test(u.pathname));
  assert.ok(perIndexer.length > 0);
  const midPath = new Set([IMDB, 'Matrix Brasil', 'The Matrix']);
  assert.ok(perIndexer.every((u) => !midPath.has(u.searchParams.get('q'))), 'não repete o que o multi já buscou');
  assert.equal(perIndexer.filter((u) => u.pathname === '/indexers/betor').length, 0, 'betor não recebe texto');
});

test('Fase 3: multi indisponível repete também as queries do mid-path', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, { ...SOURCES_V2, features: { multi: false } }],
    '/search': async () => [200, { results: [] }],
    '/indexers/*': async (url) => [200, {
      results: url.pathname === '/indexers/torrent-dos-filmes' && url.searchParams.get('q') === 'Matrix Brasil'
        ? [torrent(hash('e'), 'Matrix 1999 1080p')]
        : [],
    }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  assert.equal(srv.calls.filter((u) => u.pathname === '/indexers/multi').length, 0);
});
