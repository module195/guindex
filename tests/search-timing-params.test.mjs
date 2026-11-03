// Prazos que se anulavam (análise paramétrica, 4ª rodada): a Fase 3 com o multi
// lento, títulos que chegam depois do META_BUDGET e o aviso de combinações
// inválidas no boot. Roda contra o build: npm test
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '0';
process.env.TORRENT_INDEXER_META_BUDGET_MS = '300';
process.env.TMDB_API_KEY = 'x';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { timingConfigWarnings, currentTimingConfig } = await import('../dist/services/timing-config.js');

const BASE = 'http://idx.test';
const IMDB = 'tt0133093';
const h = (c) => c.repeat(40);
// Sem imdb: só passa no filtro se houver título-alvo
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
const SOURCES_V2 = {
  api_version: 2,
  features: { multi: true },
  indexer_names: ['betor'],
  indexers: [{ name: 'betor', supports_text: true, supports_imdb: true, healthy: true }],
};

const previous = getGlobalDispatcher();
let agent;
after(() => setGlobalDispatcher(previous));

function mock({ search = [], multi = [], multiDelay = 10, direct = [], metaDelay = 10 }) {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const calls = { direct: 0 };
  const idx = agent.get(BASE);
  idx.intercept({ path: /^\/sources/ }).reply(200, SOURCES_V2).persist();
  idx.intercept({ path: /^\/search/ }).reply(200, { results: search }).persist();
  idx.intercept({ path: /^\/indexers\/multi/ }).reply(200, { results: multi, count: multi.length, calls: [] }).delay(multiDelay).persist();
  idx
    .intercept({ path: /^\/indexers\/betor/ })
    .reply(() => {
      calls.direct++;
      return { statusCode: 200, data: { results: direct } };
    })
    .persist();
  agent
    .get('https://v3-cinemeta.strem.io')
    .intercept({ path: /.*/ })
    .reply(200, { meta: { name: 'Matrix', year: 1999 } })
    .delay(metaDelay)
    .persist();
  agent
    .get('https://api.themoviedb.org')
    .intercept({ path: /.*/ })
    .reply(200, { movie_results: [{ title: 'Matrix', original_title: 'The Matrix' }] })
    .delay(metaDelay)
    .persist();
  return calls;
}

beforeEach(() => {
  TorrentIndexerProvider.indexerCatalogCache = undefined;
  TorrentIndexerProvider.indexerCatalogInFlight = undefined;
  TorrentIndexerProvider.indexerCatalogFailedAt = 0;
  TorrentIndexerProvider.indexerNamesCache = undefined;
  TorrentIndexerProvider.indexerPerformance.clear();
  TorrentIndexerProvider.indexerFailureState.clear();
  TorrentIndexerProvider.cinemetaCache.clear();
  TorrentIndexerProvider.localizedTitleCache.clear();
});

test('cache vazio e multi lento: a Fase 3 roda antes do prazo, junto com o multi', async () => {
  const calls = mock({ multiDelay: 10_000, direct: [torrent('a', 'Matrix 1999 1080p')] });
  const started = Date.now();
  const streams = await new TorrentIndexerProvider('GuIndex', BASE).getStreams('movie', IMDB);
  assert.ok(calls.direct > 0, 'a Fase 3 chamou o indexer direto');
  assert.equal(streams.length, 1);
  assert.ok(Date.now() - started < 3300, `ficou no orçamento (${Date.now() - started}ms)`);
});

test('cache vazio: o multi que chega durante a Fase 3 ainda entra na resposta', async () => {
  mock({ multi: [torrent('b', 'Matrix 1999 2160p')], multiDelay: 2000 });
  const streams = await new TorrentIndexerProvider('GuIndex', BASE).getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
  assert.match(streams[0].quality ?? streams[0].title ?? '', /4K|2160/);
});

test('títulos depois do META_BUDGET: o filtro é refeito e os torrents sem IMDb voltam', async () => {
  mock({ search: [torrent('c', 'Matrix 1999 1080p')], metaDelay: 600 });
  const streams = await new TorrentIndexerProvider('GuIndex', BASE).getStreams('movie', IMDB);
  assert.equal(streams.length, 1);
});

test('aviso de prazos: o padrão passa limpo e as combinações que se anulam aparecem', () => {
  const ok = {
    requestBudgetMs: 8000,
    debridMarginMs: 1500,
    metaBudgetMs: 1500,
    multiGraceMs: 1500,
    multiGraceNo4kMs: 4000,
    phase3MinMs: 1500,
    sourceTimeoutMs: 8000,
    addonTimeoutMs: 6500,
  };
  assert.deepEqual(timingConfigWarnings(ok), []);
  const bad = timingConfigWarnings({
    ...ok,
    requestBudgetMs: 10_000,
    debridMarginMs: 0,
    phase3MinMs: 10_000,
    multiGraceMs: 5000,
    sourceTimeoutMs: 0,
  });
  for (const name of ['REQUEST_BUDGET', 'DEBRID_MARGIN', 'PHASE3_MIN', 'MULTI_GRACE_MS', 'SOURCE_TIMEOUT']) {
    assert.ok(bad.some((w) => w.includes(name)), name);
  }
  assert.equal(typeof currentTimingConfig().requestBudgetMs, 'number');
});
