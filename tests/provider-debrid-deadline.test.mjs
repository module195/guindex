// O provedor devolve os streams logo depois da busca, sem esperar a checagem de
// cache no debrid: quem espera por ela (com prazo curto) é o StreamController.
// Com o TorBox lento, esperar aqui fazia o provedor passar do timeout da
// SourceService e a resposta inteira era descartada.
// Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Orçamento curto para o teste não demorar (lido no import do módulo)
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '1500';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '500';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const IMDB = 'tt0133093';
const HASH = 'a'.repeat(40);
const originals = {
  fetchCached: TorboxService.fetchCachedInfoHashes,
  checkCached: TorboxService.checkCachedInfoHashes,
};

afterEach(() => {
  TorboxService.fetchCachedInfoHashes = originals.fetchCached;
  TorboxService.checkCachedInfoHashes = originals.checkCached;
});

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body;
    if (url.pathname === '/sources') {
      body = {
        indexer_names: ['comando_torrents'],
        api_version: 2,
        indexers: [{ name: 'comando_torrents', supports_text: true, supports_imdb: false, healthy: true }],
        features: { multi: true },
      };
    } else if (url.pathname === '/search') {
      body = {
        results: url.searchParams.get('q') === IMDB
          ? [{
              title: 'Matrix 1999 1080p',
              year: '1999',
              indexer: 'comando_torrents',
              details: 'https://example.invalid/a',
              magnet_link: `magnet:?xt=urn:btih:${HASH}&dn=Matrix.1999.1080p`,
              info_hash: HASH,
              audio: ['Português'],
              size: '2 GB',
              seed_count: 10,
            }]
          : [],
      };
    } else if (url.pathname === '/indexers/multi') {
      body = { results: [], count: 0, partial: false, calls: [] };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

function newProvider(base) {
  TorrentIndexerProvider.indexerCatalogCache = undefined;
  TorrentIndexerProvider.indexerNamesCache = undefined;
  TorrentIndexerProvider.searchCache.clear();
  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['The Matrix'] });
  return new TorrentIndexerProvider('GuIndex', base);
}

const torbox = { debridProvider: 'torbox', torboxToken: 'tok-0123456789' };

test('TorBox lento não atrasa o provedor: os streams saem sem consultar o debrid', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  let lookups = 0;
  const slow = () => {
    lookups++;
    return new Promise((r) => setTimeout(() => r(new Set([HASH])), 5000).unref());
  };
  TorboxService.fetchCachedInfoHashes = slow;
  TorboxService.checkCachedInfoHashes = slow;

  const started = Date.now();
  const streams = await newProvider(srv.base).getStreams('movie', IMDB, torbox);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `levou ${elapsed}ms`);
  assert.equal(lookups, 0);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].cached, undefined, 'a checagem fica com o StreamController');
});
