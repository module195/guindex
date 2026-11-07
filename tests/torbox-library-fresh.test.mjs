// Torrent novo na conta TorBox aparece no /stream mesmo com a resposta do
// título já guardada: a lista da conta vem sem o cache do TorBox
// (bypass_cache) e uma biblioteca maior invalida a resposta guardada.
// Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MockAgent, setGlobalDispatcher } from 'undici';

const IMDB = 'tt0133093';
let searchCalls = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/search' || url.pathname === '/indexers/multi') searchCalls++;
  const body = url.pathname === '/sources'
    ? {
        indexer_names: ['comando_torrents'],
        api_version: 2,
        indexers: [{ name: 'comando_torrents', supports_text: true, supports_imdb: false, healthy: true }],
        features: { multi: true },
      }
    : url.pathname === '/indexers/multi'
      ? { results: [], count: 0, partial: false, calls: [] }
      : { results: [] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.STREMIO_ADDON_SOURCES = '[]';
process.env.TORRENT_INDEXER_URL = `http://127.0.0.1:${server.address().port}`;
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '1500';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '500';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
mockAgent.enableNetConnect(/127\.0\.0\.1/);
setGlobalDispatcher(mockAgent);

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { setupRoutes } = await import('../dist/routes/routes.js');

const TOKEN = 't'.repeat(36);
const OLD = { id: 1, hash: 'a'.repeat(40), name: 'The.Matrix.1999.1080p.BluRay.x264-YIFY', size: 2e9, download_finished: true };
const NEW = { id: 2, hash: 'b'.repeat(40), name: 'The.Matrix.1999.2160p.UHD.BluRay.REMUX-FGT', size: 6e10, download_finished: true };
const DOWNLOADING = { id: 3, hash: 'c'.repeat(40), name: 'The.Matrix.1999.720p.WEB', size: 1e9, download_finished: false, download_state: 'downloading' };
let account = [OLD];
const listQueries = [];
mockAgent
  .get('https://api.torbox.app')
  .intercept({ path: (p) => p.startsWith('/v1/api/torrents/mylist'), method: 'GET' })
  .reply((opts) => {
    listQueries.push(new URL(opts.path, 'https://api.torbox.app').searchParams);
    return { statusCode: 200, data: { success: true, data: account } };
  })
  .persist();

TorboxService.fetchCachedInfoHashes = async () => new Set();
TorboxService.checkCachedInfoHashes = async () => ({ cached: new Set(), unknown: new Set() });
TorrentIndexerProvider.cinemetaCache.set(`movie:${IMDB}`, { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
TorrentIndexerProvider.localizedTitleCache.set(IMDB, { ts: Date.now(), titles: ['Matrix'] });

const expireAccountList = () => {
  TorboxService.accountTorrents.get(TOKEN).expires = 0;
};

test('torrent novo pronto na conta invalida a resposta guardada do título', async (t) => {
  const app = setupRoutes();
  t.after(async () => {
    await app.close();
    server.closeAllConnections();
    server.close();
  });
  const hashes = async () => {
    const res = await app.inject({ url: `/torbox/${TOKEN}/stream/movie/${IMDB}.json` });
    return res.json().streams.map((s) => s.infoHash).sort();
  };

  assert.deepEqual(await hashes(), [OLD.hash]);
  assert.equal(listQueries.at(-1).get('bypass_cache'), 'true', 'lista da conta sem o cache do TorBox');
  const searches = searchCalls;

  assert.deepEqual(await hashes(), [OLD.hash]);
  assert.equal(searchCalls, searches, 'mesma biblioteca: resposta do cache');

  // Lista vencida, conta igual (e um torrent ainda baixando): continua no cache
  account = [OLD, DOWNLOADING];
  expireAccountList();
  const lists = listQueries.length;
  assert.deepEqual(await hashes(), [OLD.hash]);
  assert.equal(listQueries.length, lists + 1, 'a lista vencida é relida');
  assert.equal(searchCalls, searches, 'nada novo pronto: resposta do cache');

  // Torrent novo pronto na conta: a busca roda de novo e ele aparece
  account = [OLD, DOWNLOADING, NEW];
  expireAccountList();
  assert.deepEqual(await hashes(), [OLD.hash, NEW.hash]);
  assert.ok(searchCalls > searches, 'biblioteca maior refaz a busca');
});
