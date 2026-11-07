// Busca que nenhum indexer responde a tempo gasta o prazo todo; o torrent da
// conta TorBox, com a lista já pronta, ainda tem que sair no /stream.
// Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '2500';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '300';
process.env.TORRENT_INDEXER_PHASE3_MIN_MS = '800';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const IMDB = 'tt0133093';
const HASH = 'e'.repeat(40);

test('lista da conta pronta entra mesmo com a busca vazia esgotando o prazo', async (t) => {
  // Indexers lentos: o multi e o /indexers/<nome> só respondem depois do prazo
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (body) => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/sources') {
      send({
        indexer_names: ['comando_torrents'],
        api_version: 2,
        indexers: [{ name: 'comando_torrents', supports_text: true, supports_imdb: false, healthy: true }],
        features: { multi: true },
      });
    } else if (url.pathname === '/search') {
      send({ results: [] });
    } else {
      setTimeout(() => send({ results: [], count: 0, partial: false, calls: [] }), 5000).unref();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const originals = {
    library: TorboxService.accountLibrary,
    fetchCached: TorboxService.fetchCachedInfoHashes,
    checkCached: TorboxService.checkCachedInfoHashes,
  };
  t.after(() => Object.assign(TorboxService, {
    accountLibrary: originals.library,
    fetchCachedInfoHashes: originals.fetchCached,
    checkCachedInfoHashes: originals.checkCached,
  }));
  TorboxService.fetchCachedInfoHashes = async () => new Set();
  TorboxService.checkCachedInfoHashes = async () => ({ cached: new Set(), unknown: new Set() });
  TorboxService.accountLibrary = async () => [
    { id: 9, hash: HASH, name: 'The.Matrix.1999.1080p.BluRay.x264-YIFY', size: 2e9, download_finished: true },
  ];

  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix'] });
  const provider = new TorrentIndexerProvider('GuIndex', `http://127.0.0.1:${server.address().port}`);
  const started = Date.now();
  const streams = await provider.getStreams('movie', IMDB, { debridProvider: 'torbox', torboxToken: 'tok-0123456789' });
  assert.ok(Date.now() - started < 2600, `respeita o prazo (${Date.now() - started}ms)`);
  assert.deepEqual(streams.map((s) => s.infoHash), [HASH], 'o torrent da conta sai sem a ajuda dos indexers');
  assert.equal(streams[0].inLibrary, true);
});

test('torrent-indexer fora do ar: o torrent da conta ainda sai', async (t) => {
  // Porta fechada: toda chamada ao indexer falha na conexão
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  const originals = {
    library: TorboxService.accountLibrary,
    fetchCached: TorboxService.fetchCachedInfoHashes,
    checkCached: TorboxService.checkCachedInfoHashes,
  };
  t.after(() => Object.assign(TorboxService, {
    accountLibrary: originals.library,
    fetchCachedInfoHashes: originals.fetchCached,
    checkCachedInfoHashes: originals.checkCached,
  }));
  TorboxService.fetchCachedInfoHashes = async () => new Set();
  TorboxService.checkCachedInfoHashes = async () => ({ cached: new Set(), unknown: new Set() });
  const DOWN_HASH = 'f'.repeat(40);
  TorboxService.accountLibrary = async () => [
    { id: 10, hash: DOWN_HASH, name: 'The.Matrix.1999.2160p.WEB-DL.DUAL', size: 9e9, download_finished: true },
  ];

  TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix'] });
  const provider = new TorrentIndexerProvider('GuIndex', `http://127.0.0.1:${port}`);
  const started = Date.now();
  const streams = await provider.getStreams('movie', IMDB, { debridProvider: 'torbox', torboxToken: 'tok-0123456789' });
  assert.ok(Date.now() - started < 2600, `respeita o prazo (${Date.now() - started}ms)`);
  assert.deepEqual(streams.map((s) => s.infoHash), [DOWN_HASH]);
  assert.equal(streams[0].inLibrary, true);
});
