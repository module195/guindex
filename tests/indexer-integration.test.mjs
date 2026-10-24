// Integração com o torrent-indexer: capacidades de /sources?v=2 e fan-out via
// /indexers/multi. Sobe um torrent-indexer falso em uma porta local.
// Roda contra o build: npm run test:indexer
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { TorrentIndexerProvider } from '../dist/services/torrent-indexer-provider.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Formato real do /sources?v=2 (torrent-indexer api/capabilities.go)
const SOURCES_V2 = {
  indexer_names: ['torrent-dos-filmes', 'comando_torrents', 'rede_torrent', 'betor'],
  api_version: 2,
  indexers: [
    { name: 'torrent-dos-filmes', supports_text: true, supports_imdb: false, healthy: true, consecutive_failures: 0, p50_ms: 900, samples: 10 },
    { name: 'comando_torrents', supports_text: true, supports_imdb: false, healthy: true, consecutive_failures: 0, samples: 0 },
    { name: 'rede_torrent', supports_text: true, supports_imdb: false, healthy: false, consecutive_failures: 3, samples: 0 },
    { name: 'betor', supports_text: false, supports_imdb: true, healthy: true, consecutive_failures: 0, samples: 0 },
  ],
  search: { meilisearch: true },
  features: { multi: true, x_cache: true, response_cache: true },
};

const torrent = (hash, title) => ({
  title,
  details: 'https://example.invalid/' + hash.slice(0, 6),
  magnet_link: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`,
  info_hash: hash,
  audio: ['Português'],
  size: '2 GB',
  seed_count: 10,
});

function startServer(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(url);
    const handler = routes[url.pathname] ?? routes['/indexers/*'];
    if (!handler || (!routes[url.pathname] && !url.pathname.startsWith('/indexers/'))) {
      res.writeHead(404).end();
      return;
    }
    const [status, body] = handler(url);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => server.close() });
    });
  });
}

beforeEach(() => {
  TorrentIndexerProvider.indexerCatalogCache = undefined;
  TorrentIndexerProvider.indexerNamesCache = undefined;
  TorrentIndexerProvider.indexerPerformance.clear();
  TorrentIndexerProvider.indexerFailureState.clear();
});

test('/sources?v=2: pula indexer doente no caminho síncrono e respeita supports_text/imdb', async (t) => {
  const srv = await startServer({ '/sources': () => [200, SOURCES_V2] });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('torrent-indexer', srv.base);

  const sync = await provider.fetchIndexerNames(false);
  assert.ok(!sync.includes('rede_torrent'));
  assert.equal(sync.length, 3);
  // o aquecimento em background ainda chama o doente, para ele poder se recuperar
  assert.ok((await provider.fetchIndexerNames()).includes('rede_torrent'));
  assert.equal(srv.calls.filter((u) => u.pathname === '/sources').length, 1, 'catálogo fica em cache');
  assert.equal(srv.calls[0].searchParams.get('v'), '2');

  assert.equal(provider.indexerSupportsQuery('betor', 'tt0111161'), true);
  assert.equal(provider.indexerSupportsQuery('betor', 'Um Sonho de Liberdade'), false);
  assert.equal(provider.indexerSupportsQuery('torrent-dos-filmes', 'tt0111161'), false);
  assert.equal(provider.indexerSupportsQuery('torrent-dos-filmes', 'Um Sonho de Liberdade'), true);
  assert.equal(provider.indexerSupportsQuery('desconhecido', 'tt0111161'), true);
});

test('IMDb não vai para indexer sem supports_imdb (sem chamada HTTP)', async (t) => {
  const srv = await startServer({
    '/sources': () => [200, SOURCES_V2],
    '/indexers/*': () => [200, { results: [], count: 0 }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('torrent-indexer', srv.base);
  await provider.fetchIndexerNames();

  assert.deepEqual(await provider.fetchSingleIndexerSearch('comando_torrents', 'tt0111161'), []);
  assert.deepEqual(await provider.fetchSingleIndexerSearch('betor', 'Matrix'), []);
  assert.equal(srv.calls.filter((u) => u.pathname.startsWith('/indexers/')).length, 0);
});

test('mid-path usa /indexers/multi com indexers saudáveis e deadline_ms', async (t) => {
  const srv = await startServer({
    '/sources': () => [200, SOURCES_V2],
    '/indexers/multi': () => [200, {
      results: [
        { ...torrent(HASH_A, 'Matrix 1999 1080p'), found_in: ['comando_torrents', 'torrent-dos-filmes'] },
        { ...torrent(HASH_B, 'Matrix 1999 720p'), found_in: ['betor'] },
      ],
      count: 2,
      partial: true,
      calls: [
        { indexer: 'torrent-dos-filmes', q: 'Matrix', state: 'ok', status: 200, count: 1, duration_ms: 1200, cache: 'MISS' },
        { indexer: 'comando_torrents', q: 'Matrix', state: 'error', status: 503, count: 0, duration_ms: 300, reason: 'boom' },
        { indexer: 'betor', q: 'tt0133093', state: 'ok', status: 200, count: 1, duration_ms: 5, cache: 'HIT' },
        { indexer: 'betor', q: 'Matrix', state: 'skipped', count: 0, duration_ms: 0, reason: 'text_not_supported' },
        { indexer: 'comando_torrents', q: 'tt0133093', state: 'timeout', count: 0, duration_ms: 7000 },
      ],
    }],
    '/indexers/*': () => [500, { error: 'não devia ser chamado' }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('torrent-indexer', srv.base);

  const results = await provider.fetchBulkSearchResultsFromIndexers(['tt0133093', 'Matrix'], { timeoutMs: 8000 });
  assert.equal(results.length, 2);
  const byHash = Object.fromEntries(results.map((r) => [r.info_hash, r]));
  assert.equal(byHash[HASH_A].indexer, 'comando_torrents', 'indexer vem de found_in[0]');
  assert.equal(byHash[HASH_B].indexer, 'betor');

  const multiCalls = srv.calls.filter((u) => u.pathname === '/indexers/multi');
  assert.equal(multiCalls.length, 1);
  assert.equal(srv.calls.filter((u) => u.pathname.startsWith('/indexers/') && u.pathname !== '/indexers/multi').length, 0);
  const url = multiCalls[0];
  assert.deepEqual(url.searchParams.getAll('q'), ['tt0133093', 'Matrix']);
  const sent = url.searchParams.get('indexers').split(',').sort();
  assert.deepEqual(sent, ['betor', 'comando_torrents', 'torrent-dos-filmes'], 'rede_torrent (healthy:false) fica de fora');
  const deadline = Number(url.searchParams.get('deadline_ms'));
  assert.ok(deadline >= 6000 && deadline <= 7000, `deadline_ms=${deadline}`);

  const perf = TorrentIndexerProvider.indexerPerformance;
  assert.equal(perf.get(provider.normalizeIndexerSlug('torrent-dos-filmes'))?.avgMs, 1200);
  assert.equal(perf.has('betor'), false, 'HIT do cache não conta como latência');
  assert.equal(TorrentIndexerProvider.indexerFailureState.get('comando_torrents')?.consecutiveFailures, 1);
});

test('torrent-indexer antigo (sem v=2 e sem multi): cai nas chamadas por indexer', async (t) => {
  const srv = await startServer({
    '/sources': () => [200, { indexer_names: ['torrent-dos-filmes', 'comando_torrents'] }],
    '/indexers/*': (url) => [200, {
      results: url.pathname === '/indexers/comando_torrents' ? [torrent(HASH_A, 'Matrix 1999')] : [],
      count: 1,
    }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('torrent-indexer', srv.base);

  const results = await provider.fetchBulkSearchResultsFromIndexers(['Matrix'], { timeoutMs: 5000 });
  assert.equal(results.length, 1);
  assert.equal(srv.calls.filter((u) => u.pathname === '/indexers/multi').length, 0);
  assert.equal(srv.calls.filter((u) => u.pathname === '/indexers/comando_torrents').length, 1);
});

test('/indexers/multi 404: marca multi indisponível e usa o fallback por indexer', async (t) => {
  const srv = await startServer({
    '/sources': () => [200, { ...SOURCES_V2, features: {} }],
    '/indexers/multi': () => [404, {}],
    '/indexers/*': (url) => [200, {
      results: url.pathname === '/indexers/torrent-dos-filmes' ? [torrent(HASH_A, 'Matrix 1999')] : [],
      count: 1,
    }],
  });
  t.after(srv.close);
  const provider = new TorrentIndexerProvider('torrent-indexer', srv.base);

  const results = await provider.fetchBulkSearchResultsFromIndexers(['Matrix'], { timeoutMs: 5000 });
  assert.equal(results.length, 1);
  assert.equal(TorrentIndexerProvider.indexerCatalogCache.multi, false);

  await provider.fetchBulkSearchResultsFromIndexers(['Matrix 2'], { timeoutMs: 5000 });
  assert.equal(srv.calls.filter((u) => u.pathname === '/indexers/multi').length, 1, 'não tenta o multi de novo');
  assert.equal(srv.calls.filter((u) => u.pathname === '/indexers/betor').length, 0, 'betor não recebe texto');
});
