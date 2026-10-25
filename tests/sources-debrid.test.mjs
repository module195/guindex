// Addon externo com prazo, reaproveitamento de torrent no Real-Debrid e
// timeout do multi no histórico. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.STREMIO_ADDON_TIMEOUT_MS = '300';
process.env.STREMIO_ADDON_SOURCES = '[]';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const { StremioAddonProvider } = await import('../dist/services/stremio-addon-provider.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { SOURCES } = await import('../dist/config/sources.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');
const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

test('addon externo que não responde é cortado no prazo e os streams do GuIndex saem', async () => {
  mockAgent
    .get('https://addon-lento.example')
    .intercept({ path: '/stream/movie/tt15398776.json', method: 'GET' })
    .reply(200, { streams: [{ title: 'lento', infoHash: 'f'.repeat(40) }] })
    .delay(5000);

  const guindex = { name: 'GuIndex', getStreams: async () => [{ title: 'rápido', infoHash: 'e'.repeat(40) }] };
  SOURCES.splice(0, SOURCES.length, guindex, new StremioAddonProvider('Lento', 'https://addon-lento.example'));

  const started = Date.now();
  const streams = await SourceService.fetchStreamsFromAllSources('movie', 'tt15398776');
  assert.ok(Date.now() - started < 2000, `demorou ${Date.now() - started}ms`);
  assert.deepEqual(streams.map((s) => s.title), ['rápido']);
});

test('a checagem de cache do debrid começa quando cada fonte responde, sem esperar a mais lenta', async () => {
  const fast = { name: 'Rápida', getStreams: async () => [{ title: 'rápido', infoHash: 'c'.repeat(40) }] };
  const slow = {
    name: 'Lenta',
    getStreams: () => new Promise((r) => setTimeout(() => r([{ title: 'lento', magnet: `magnet:?xt=urn:btih:${'D'.repeat(40)}` }]), 300)),
  };
  SOURCES.splice(0, SOURCES.length, fast, slow);
  const original = TorboxService.checkCachedInfoHashes;
  const lookups = [];
  const started = Date.now();
  TorboxService.checkCachedInfoHashes = async (hashes, token) => {
    lookups.push({ at: Date.now() - started, hashes, token });
    return { cached: new Set(), unknown: new Set() };
  };
  try {
    await SourceService.fetchStreamsFromAllSources('movie', 'tt15398777', { debridProvider: 'torbox', torboxToken: 'tok-pre' });
  } finally {
    TorboxService.checkCachedInfoHashes = original;
  }
  assert.equal(lookups.length, 2);
  assert.deepEqual(lookups[0].hashes, ['c'.repeat(40)]);
  assert.ok(lookups[0].at < 150, `a rápida foi consultada em ${lookups[0].at}ms`);
  assert.deepEqual(lookups[1].hashes, ['d'.repeat(40)]);
  assert.equal(lookups[1].token, 'tok-pre');
});

test('sem token, nenhuma checagem antecipada', async () => {
  SOURCES.splice(0, SOURCES.length, { name: 'X', getStreams: async () => [{ title: 'x', infoHash: 'c'.repeat(40) }] });
  const original = TorboxService.checkCachedInfoHashes;
  let calls = 0;
  TorboxService.checkCachedInfoHashes = async () => {
    calls++;
    return { cached: new Set(), unknown: new Set() };
  };
  try {
    await SourceService.fetchStreamsFromAllSources('movie', 'tt15398778');
  } finally {
    TorboxService.checkCachedInfoHashes = original;
  }
  assert.equal(calls, 0);
});

const rd = mockAgent.get('https://api.real-debrid.com');
const HASH = 'a'.repeat(40);
const magnet = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Show`;
const files = [
  { id: 1, path: '/Show.S01E01.1080p.mkv', bytes: 1_000_000_000, selected: 1 },
  { id: 2, path: '/Show.S01E02.1080p.mkv', bytes: 1_000_000_000, selected: 1 },
  { id: 3, path: '/Show.S01E03.1080p.mkv', bytes: 1_000_000_000, selected: 1 },
];

test('Real-Debrid: torrent já na conta é reaproveitado, com o link do episódio certo', async () => {
  const unrestricted = [];
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' })
    .reply(200, [{ id: 'ABC', hash: HASH, status: 'downloaded' }]);
  rd.intercept({ path: '/rest/1.0/torrents/info/ABC', method: 'GET' })
    .reply(200, { id: 'ABC', status: 'downloaded', files, links: ['l1', 'l2', 'l3'] });
  rd.intercept({ path: '/rest/1.0/unrestrict/link', method: 'POST' })
    .reply((opts) => {
      unrestricted.push(new URLSearchParams(String(opts.body)).get('link'));
      return { statusCode: 200, data: { download: 'https://cdn.example/e02.mkv' } };
    });

  const url = await new RealDebridService('token-reuse').processMagnetToDirectUrl(magnet, {
    type: 'series',
    season: 1,
    episode: 2,
  });
  assert.equal(url, 'https://cdn.example/e02.mkv');
  assert.deepEqual(unrestricted, ['l2']);
});

test('Real-Debrid: hash fora da conta continua adicionando o magnet', async () => {
  let added = 0;
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' }).reply(200, []);
  rd.intercept({ path: '/rest/1.0/torrents/addMagnet', method: 'POST' })
    .reply(() => {
      added++;
      return { statusCode: 201, data: { id: 'NEW' } };
    });
  rd.intercept({ path: '/rest/1.0/torrents/info/NEW', method: 'GET' })
    .reply(200, { id: 'NEW', status: 'downloaded', files, links: ['n2'] })
    .persist();
  rd.intercept({ path: '/rest/1.0/torrents/selectFiles/NEW', method: 'POST' }).reply(204, '');
  rd.intercept({ path: '/rest/1.0/unrestrict/link', method: 'POST' })
    .reply(200, { download: 'https://cdn.example/new.mkv' });

  const url = await new RealDebridService('token-new').processMagnetToDirectUrl(magnet, {
    type: 'series',
    season: 1,
    episode: 2,
  });
  assert.equal(url, 'https://cdn.example/new.mkv');
  assert.equal(added, 1);
});

test('multi: sub-chamada em timeout entra no histórico com pelo menos o prazo', () => {
  const provider = new TorrentIndexerProvider('GuIndex', 'http://127.0.0.1:1');
  provider.recordMultiCalls([{ indexer: 'rede_torrent', state: 'timeout', duration_ms: 1200 }], 4000);
  const perf = TorrentIndexerProvider.indexerPerformance.get(provider.normalizeIndexerSlug('rede_torrent'));
  assert.ok(perf, 'timeout deveria gerar amostra');
  assert.equal(perf.lastDurationMs, 4000);
  assert.equal(perf.hits, 0);
});
