// Biblioteca TorBox no /stream: o torrent que já está na conta vira stream
// cacheado e marcado, e o que a busca já trouxe ganha o selo sem checkcached.
// Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '1500';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '500';

const { TorrentIndexerProvider, accountTorrentToTorrentLike } = await import('../dist/services/torrent-indexer-provider.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { StreamService } = await import('../dist/services/stream-service.js');

const IMDB = 'tt0133093';
const HASH = 'a'.repeat(40);
const HASH_4K = 'b'.repeat(40);
const HASH_OTHER = 'c'.repeat(40);
const originals = {
  fetchCached: TorboxService.fetchCachedInfoHashes,
  checkCached: TorboxService.checkCachedInfoHashes,
  library: TorboxService.accountLibrary,
};

afterEach(() => {
  TorboxService.fetchCachedInfoHashes = originals.fetchCached;
  TorboxService.checkCachedInfoHashes = originals.checkCached;
  TorboxService.accountLibrary = originals.library;
});

const noLookup = async () => ({ cached: new Set(), unknown: new Set() });

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

const LIBRARY = [
  { id: 1, hash: HASH.toUpperCase(), name: 'Matrix.1999.1080p', size: 2e9, download_finished: true },
  {
    id: 2,
    hash: HASH_4K,
    name: 'Matrix.1999.2160p.WEB-DL.DUAL',
    size: 20e9,
    download_finished: true,
    files: [
      { id: 0, name: 'Matrix.1999.2160p.WEB-DL.DUAL/sample.mkv', size: 30e6 },
      { id: 1, name: 'Matrix.1999.2160p.WEB-DL.DUAL/Matrix.1999.2160p.WEB-DL.DUAL.mkv', size: 19e9 },
    ],
  },
  { id: 3, hash: HASH_OTHER, name: 'Duna.2021.1080p.WEB-DL', size: 3e9, download_finished: true },
];

test('item da conta que casa com o título vira stream cacheado; o que a busca trouxe ganha o selo', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  TorboxService.fetchCachedInfoHashes = async () => new Set();
  TorboxService.checkCachedInfoHashes = noLookup;
  let libraryCalls = 0;
  TorboxService.accountLibrary = async (token) => {
    libraryCalls++;
    assert.equal(token, torbox.torboxToken);
    return LIBRARY;
  };

  const streams = await newProvider(srv.base).getStreams('movie', IMDB, torbox);
  assert.equal(libraryCalls, 1);
  const byHash = new Map(streams.map((s) => [s.infoHash, s]));
  assert.equal(byHash.get(HASH)?.inLibrary, true, 'o resultado da busca que está na conta é marcado');
  assert.equal(byHash.get(HASH)?.cached, true);
  const fromLibrary = byHash.get(HASH_4K);
  assert.ok(fromLibrary, 'o 4K só da conta entra');
  assert.equal(fromLibrary.cached, true);
  assert.equal(fromLibrary.inLibrary, true);
  assert.equal(fromLibrary.fileIdx, 1, 'arquivo principal, não o sample');
  assert.equal(fromLibrary.quality, '4K');
  assert.ok(!byHash.has(HASH_OTHER), 'item de outro título não entra');

  const meta = StreamService.createStreamMetadata(fromLibrary, 'https://x.invalid/resolve', {
    debridProvider: 'torbox',
    torboxReady: true,
    viaDebrid: true,
  });
  assert.match(meta.title, /🗃️ Já está na sua TorBox/);
  assert.equal(meta.infoHash, HASH_4K);
});

test('sem token TorBox a conta não é consultada', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  let libraryCalls = 0;
  TorboxService.accountLibrary = async () => {
    libraryCalls++;
    return LIBRARY;
  };
  const streams = await newProvider(srv.base).getStreams('movie', IMDB, { debridProvider: 'realdebrid', realdebridToken: 'x' });
  assert.equal(libraryCalls, 0);
  assert.ok(streams.every((s) => !s.inLibrary));
});

test('lista da conta com erro não derruba a busca', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  TorboxService.fetchCachedInfoHashes = async () => new Set();
  TorboxService.checkCachedInfoHashes = noLookup;
  TorboxService.accountLibrary = async () => {
    throw new Error('TorBox GET /v1/api/torrents/mylist failed: 500');
  };
  const streams = await newProvider(srv.base).getStreams('movie', IMDB, torbox);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].inLibrary, undefined);
});

test('lista da conta lenta não passa do prazo da busca', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  TorboxService.fetchCachedInfoHashes = async () => new Set();
  TorboxService.checkCachedInfoHashes = noLookup;
  TorboxService.accountLibrary = () => new Promise((r) => setTimeout(() => r(LIBRARY), 5000).unref());
  const started = Date.now();
  const streams = await newProvider(srv.base).getStreams('movie', IMDB, torbox);
  assert.ok(Date.now() - started < 900, `levou ${Date.now() - started}ms`);
  assert.equal(streams.length, 1);
});

test('formato do torrent da conta para o filtro do indexer', () => {
  const like = accountTorrentToTorrentLike(LIBRARY[1]);
  assert.equal(like.info_hash, HASH_4K);
  assert.match(like.magnet_link, new RegExp(`^magnet:\\?xt=urn:btih:${HASH_4K}&dn=`));
  assert.equal(like.files.length, 2);
});
