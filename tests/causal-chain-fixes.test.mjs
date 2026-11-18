// Correções da investigação da cadeia causal (18/11/2026): títulos atrasados,
// metadado vencido, multi por IMDb antes do metadado, sinal de busca incompleta
// por pedido, motivo do multi ausente, falha do Meilisearch no log, Fase 1 sem
// esperar a query mais lenta, janela das outras fontes e resolve em voo sem IP.
// Sobe um torrent-indexer falso local. Roda contra o build: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

// Lidos no import dos módulos
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MARGIN_MS = '0';
process.env.TORRENT_INDEXER_META_BUDGET_MS = '300';
process.env.TORRENT_INDEXER_MULTI_GRACE_MS = '300';
process.env.TORRENT_INDEXER_MULTI_GRACE_NO_4K_MS = '300';
process.env.TORRENT_INDEXER_PHASE3_MIN_MS = '500';
process.env.TORRENT_INDEXER_CACHE_EXTRA_GRACE_MS = '200';
process.env.TORRENT_INDEXER_LATE_TEXT_MIN_MS = '800';
process.env.SOURCE_GRACE_MS = '200';
process.env.STREAM_NEGATIVE_TTL_MS = '1000';
delete process.env.TMDB_API_KEY;
delete process.env.TMDB_API_READ_ACCESS_TOKEN;
delete process.env.TMDB_READ_ACCESS_TOKEN;

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { runWithSearchHealth, noteIncompleteSearch } = await import('../dist/services/torrent-indexer-shared.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { SOURCES } = await import('../dist/config/sources.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (c) => c.repeat(40);
const torrent = (h, title, extra = {}) => ({
  title,
  year: '2025',
  indexer: 'starck-filmes',
  details: `https://example.invalid/${h.slice(0, 6)}`,
  magnet_link: `magnet:?xt=urn:btih:${h}`,
  info_hash: h,
  audio: ['Português'],
  size: '2 GB',
  seed_count: 10,
  ...extra,
});

const CATALOG = (indexers) => ({
  api_version: 2,
  features: { multi: true },
  indexer_names: indexers.map((i) => i.name),
  indexers,
});
const TEXT_AND_IMDB = [
  { name: 'starck-filmes', supports_text: true, supports_imdb: false, healthy: true },
  { name: 'betor', supports_text: true, supports_imdb: true, healthy: true },
];

function startServer(routes) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ url, at: Date.now() });
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
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

/** Cinemeta respondendo depois de `delayMs` (o resto da rede passa direto). */
function mockCinemeta(delayMs, meta) {
  const agent = new MockAgent();
  agent.enableNetConnect(/127\.0\.0\.1/);
  agent
    .get('https://v3-cinemeta.strem.io')
    .intercept({ path: /\/meta\// })
    .reply(200, { meta })
    .delay(delayMs)
    .persist();
  setGlobalDispatcher(agent);
  return agent;
}

const originalDispatcher = getGlobalDispatcher();
const original = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  rdCheck: RealDebridService.checkCachedInfoHashes,
  sources: [...SOURCES],
};

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

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
  SourceService.fetchStreamsFromAllSources = original.fetchStreams;
  RealDebridService.checkCachedInfoHashes = original.rdCheck;
  SOURCES.splice(0, SOURCES.length, ...original.sources);
});

const textOnlyRoutes = (tor) => ({
  '/sources': async () => [200, CATALOG(TEXT_AND_IMDB)],
  '/search': async (url) => [200, { results: /agente/i.test(url.searchParams.get('q') ?? '') ? [tor] : [] }],
  '/indexers/multi': async (url) => [200, {
    results: url.searchParams.getAll('q').some((q) => /agente/i.test(q)) ? [tor] : [],
    calls: [{ indexer: 'betor', q: 'x', state: 'ok', count: 0 }],
  }],
  '/indexers/*': async () => [200, { results: [] }],
});

test('títulos atrasados disparam as buscas por texto e acham o torrent sem IMDb', async (t) => {
  const tor = torrent(hash('a'), 'O Agente Secreto 2025 1080p WEB-DL');
  const srv = await startServer(textOnlyRoutes(tor));
  t.after(srv.close);
  mockCinemeta(600, { name: 'O Agente Secreto', year: 2025 });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const search = runWithSearchHealth(() => provider.getStreams('movie', 'tt9000001'));
  const streams = await search.done;
  assert.equal(streams.length, 1, 'antes saía vazio: o site só de texto nunca era consultado');
  assert.equal(search.incomplete(), false, 'as buscas por texto rodaram até o fim');
  const textSearch = srv.calls.find(({ url }) => url.pathname === '/search' && /agente/i.test(url.searchParams.get('q')));
  assert.ok(textSearch, 'o /search por título saiu depois que os títulos chegaram');
});

test('sem prazo para as buscas por texto, a busca sem títulos fica incompleta (sem cache negativo)', async (t) => {
  const tor = torrent(hash('b'), 'O Agente Secreto 2025 1080p WEB-DL');
  const srv = await startServer(textOnlyRoutes(tor));
  t.after(srv.close);
  // Chega com menos de LATE_TEXT_MIN_MS (800) do prazo de 3000
  mockCinemeta(2500, { name: 'O Agente Secreto', year: 2025 });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const search = runWithSearchHealth(() => provider.getStreams('movie', 'tt9000002'));
  const streams = await search.done;
  assert.equal(streams.length, 0);
  assert.equal(search.incomplete(), true, 'vazio sem as buscas por texto não é um vazio de verdade');
});

test('Cinemeta lento: o metadado vencido em memória serve de reserva e o multi por IMDb sai antes', async (t) => {
  const tor = torrent(hash('c'), 'O Agente Secreto 2025 1080p WEB-DL');
  const srv = await startServer(textOnlyRoutes(tor));
  t.after(srv.close);
  TorrentIndexerProvider.cinemetaCache.set('movie:tt9000003', {
    data: { name: 'O Agente Secreto', year: 2025 },
    ts: Date.now() - 60 * 60 * 1000,
  });
  mockCinemeta(2000, { name: 'O Agente Secreto', year: 2025 });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const startedAt = Date.now();
  const streams = await provider.getStreams('movie', 'tt9000003');
  assert.equal(streams.length, 1, 'achou pelo título vencido');
  const multis = srv.calls.filter(({ url }) => url.pathname === '/indexers/multi');
  const imdbOnly = multis.find(({ url }) => url.searchParams.getAll('q').join() === 'tt9000003');
  const withTitles = multis.find(({ url }) => url.searchParams.getAll('q').some((q) => /agente/i.test(q)));
  assert.ok(imdbOnly, 'um multi só com o IMDb');
  assert.ok(withTitles, 'outro com os títulos');
  assert.ok(imdbOnly.at - startedAt < 250, `o multi por IMDb saiu antes do META_BUDGET (${imdbOnly.at - startedAt}ms)`);
  assert.ok(!withTitles.url.searchParams.getAll('q').includes('tt9000003'), 'o IMDb não vai duas vezes');
});

test('TMDB com erro mantém os títulos PT-BR da leitura anterior', async () => {
  const provider = new TorrentIndexerProvider('GuIndex', 'http://127.0.0.1:9');
  TorrentIndexerProvider.localizedTitleCache.set('tt9000004', { ts: 0, titles: ['O Agente Secreto'] });
  // Sem chave do TMDB a falha não é exercitada pela rede: chama o registro da falha direto
  const titles = provider.cacheLocalizedTitleFailure('tt9000004', false);
  assert.deepEqual(titles, ['O Agente Secreto']);
  assert.deepEqual(TorrentIndexerProvider.localizedTitleCache.get('tt9000004').titles, ['O Agente Secreto']);
});

test('sinal de busca incompleta é por pedido: a falha de um não desliga o cache negativo do outro', async () => {
  RealDebridService.checkCachedInfoHashes = async () => new Set();
  SourceService.fetchStreamsFromAllSources = async (_type, id) => {
    if (id === 'tt9000010') {
      noteIncompleteSearch();
      await sleep(50);
    }
    await sleep(20);
    return [];
  };
  const controller = new StreamController();
  const args = (id) => ({ type: 'movie', id, extra: { debridProvider: 'realdebrid', realdebridToken: 'tok-health-0123456789' } });
  const [failed, clean] = await Promise.all([
    controller.handleStreamRequest(args('tt9000010')),
    controller.handleStreamRequest(args('tt9000011')),
  ]);
  assert.equal(StreamController.cacheControlFor(failed, { type: 'movie', id: 'tt9000010' }), 'no-store');
  assert.equal(
    StreamController.cacheControlFor(clean, { type: 'movie', id: 'tt9000011' }),
    'private, max-age=1',
    'antes, a falha do outro título deixava este sem cache',
  );
});

test('indexer no cooldown que a busca não usaria não deixa a busca incompleta', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, CATALOG([
      { name: 'betor', supports_text: true, supports_imdb: true, healthy: true },
      { name: 'comando_torrents', supports_text: true, supports_imdb: true, healthy: false },
    ])],
    '/search': async () => [200, { results: [] }],
    '/indexers/multi': async () => [200, { results: [], calls: [{ indexer: 'betor', q: 'x', state: 'ok', count: 0 }] }],
    '/indexers/*': async () => [200, { results: [] }],
  });
  t.after(srv.close);
  TorrentIndexerProvider.cinemetaCache.set('movie:tt9000012', { data: { name: 'Filme Vazio', year: 2020 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set('tt9000012', { ts: Date.now(), titles: ['Filme Vazio'] });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  // comando_torrents está healthy:false: a busca não o chamaria de qualquer jeito
  TorrentIndexerProvider.indexerFailureState.set('comando_torrents', { consecutiveFailures: 2, cooldownUntil: Date.now() + 60_000 });
  let search = runWithSearchHealth(() => provider.getStreams('movie', 'tt9000012'));
  assert.deepEqual(await search.done, []);
  assert.equal(search.incomplete(), false);

  // betor no cooldown fica de fora de uma busca que o usaria: incompleta
  TorrentIndexerProvider.indexerFailureState.set('betor', { consecutiveFailures: 2, cooldownUntil: Date.now() + 60_000 });
  search = runWithSearchHealth(() => provider.getStreams('movie', 'tt9000012'));
  assert.deepEqual(await search.done, []);
  assert.equal(search.incomplete(), true);
});

test('todos os indexers no cooldown local: o multi vai com os saudáveis, em vez de não sair', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, CATALOG([
      { name: 'betor', supports_text: true, supports_imdb: true, healthy: true },
      { name: 'comando_torrents', supports_text: true, supports_imdb: true, healthy: false },
    ])],
    '/search': async () => [200, { results: [] }],
    '/indexers/multi': async () => [200, {
      results: [torrent(hash('d'), 'Matrix 1999 1080p', { indexer: 'betor', year: '1999' })],
      calls: [],
    }],
  });
  t.after(srv.close);
  TorrentIndexerProvider.cinemetaCache.set('movie:tt0133093', { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set('tt0133093', { ts: Date.now(), titles: ['Matrix'] });
  TorrentIndexerProvider.indexerFailureState.set('betor', { consecutiveFailures: 2, cooldownUntil: Date.now() + 60_000 });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const streams = await provider.getStreams('movie', 'tt0133093');
  const multi = srv.calls.find(({ url }) => url.pathname === '/indexers/multi');
  assert.ok(multi, 'o multi saiu');
  assert.equal(multi.url.searchParams.get('indexers'), 'betor', 'só o saudável no /sources, nunca sem a lista');
  assert.equal(streams.length, 1);
});

test('todos healthy:false no /sources: o multi não sai e a busca fica incompleta', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, CATALOG([
      { name: 'betor', supports_text: true, supports_imdb: true, healthy: false },
    ])],
    '/search': async () => [200, { results: [] }],
    '/indexers/multi': async () => [200, { results: [], calls: [] }],
  });
  t.after(srv.close);
  TorrentIndexerProvider.cinemetaCache.set('movie:tt0133093', { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set('tt0133093', { ts: Date.now(), titles: ['Matrix'] });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);
  const search = runWithSearchHealth(() => provider.getStreams('movie', 'tt0133093'));
  assert.deepEqual(await search.done, []);
  assert.equal(srv.calls.filter(({ url }) => url.pathname === '/indexers/multi').length, 0);
  assert.equal(search.incomplete(), true, 'o vazio não vai para o cache negativo');
});

test('falha do Meilisearch aparece no log', async (t) => {
  const srv = await startServer({
    '/sources': async () => [200, CATALOG(TEXT_AND_IMDB)],
    '/search': async () => [503, { error: 'down' }],
    '/indexers/multi': async () => [200, { results: [], calls: [] }],
    '/indexers/*': async () => [200, { results: [] }],
  });
  t.after(srv.close);
  TorrentIndexerProvider.cinemetaCache.set('movie:tt9000020', { data: { name: 'Filme', year: 2020 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set('tt9000020', { ts: Date.now(), titles: [] });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = warn; });

  await provider.getStreams('movie', 'tt9000020');
  assert.ok(warnings.some((w) => /Meilisearch \(\/search\) falhou/.test(w) && /HTTP 503/.test(w)), warnings.join('\n'));
});

test('Fase 1 não espera a query extra mais lenta do Meilisearch', async (t) => {
  const good = (c, q) => torrent(hash(c), `Matrix 1999 ${q}`, { year: '1999', indexer: c === 'e' ? 'betor' : 'starck-filmes' });
  const srv = await startServer({
    '/sources': async () => [200, CATALOG(TEXT_AND_IMDB)],
    '/search': async (url) => {
      const q = url.searchParams.get('q');
      if (q === 'tt0133093') return [200, { results: [good('e', '1080p'), good('f', '720p')] }];
      if (q === 'Matrix') return [200, { results: [] }];
      await sleep(2500);
      return [200, { results: [] }];
    },
    '/indexers/multi': async () => [200, { results: [], calls: [] }],
  });
  t.after(srv.close);
  TorrentIndexerProvider.cinemetaCache.set('movie:tt0133093', { data: { name: 'Matrix', year: 1999 }, ts: Date.now() });
  TorrentIndexerProvider.localizedTitleCache.set('tt0133093', { ts: Date.now(), titles: ['Matrix'] });
  const provider = new TorrentIndexerProvider('GuIndex', srv.base);

  const startedAt = Date.now();
  const search = runWithSearchHealth(() => provider.getStreams('movie', 'tt0133093'));
  const streams = await search.done;
  const elapsed = Date.now() - startedAt;
  assert.equal(streams.length, 2);
  assert.ok(elapsed < 1500, `antes esperava a query lenta (2,5 s); levou ${elapsed}ms`);
  assert.equal(search.incomplete(), true, 'as queries cortadas deixam a busca incompleta');
});

test('fonte principal com streams: as outras só têm a janela curta', async () => {
  const fake = (name, primary, delayMs, streams) => ({
    name,
    primary,
    getStreams: async () => { await sleep(delayMs); return streams; },
  });
  SOURCES.splice(0, SOURCES.length,
    fake('GuIndex', true, 20, [{ title: 'a', infoHash: hash('a') }]),
    fake('Addon lento', false, 3000, [{ title: 'b', infoHash: hash('b') }]),
  );
  const startedAt = Date.now();
  const streams = await SourceService.fetchStreamsFromAllSources('movie', 'tt9000030');
  const elapsed = Date.now() - startedAt;
  assert.equal(streams.length, 1);
  assert.ok(elapsed < 1000, `antes esperava o addon (3 s); levou ${elapsed}ms`);
});

test('fonte principal vazia: espera as outras', async () => {
  const fake = (name, primary, delayMs, streams) => ({
    name,
    primary,
    getStreams: async () => { await sleep(delayMs); return streams; },
  });
  SOURCES.splice(0, SOURCES.length,
    fake('GuIndex', true, 20, []),
    fake('Addon', false, 400, [{ title: 'b', infoHash: hash('b') }]),
  );
  const streams = await SourceService.fetchStreamsFromAllSources('movie', 'tt9000031');
  assert.equal(streams.length, 1, 'o stream do addon entra');
});

test('dois aparelhos (IPs diferentes) apertando play juntos esperam o mesmo resolve', async (t) => {
  const controller = new StreamController();
  let calls = 0;
  const originalResolve = StreamController.prototype.timedResolvePlayback;
  StreamController.prototype.timedResolvePlayback = async function () {
    calls++;
    await sleep(50);
    return { url: 'https://cdn.example.invalid/video.mkv', ready: true };
  };
  t.after(() => { StreamController.prototype.timedResolvePlayback = originalResolve; });
  const params = (userIp) => ({
    magnet: `magnet:?xt=urn:btih:${hash('9')}`,
    token: 'tok-play-0123456789',
    provider: 'realdebrid',
    userIp,
  });
  const [a, b] = await Promise.all([
    controller.processLinkForPlayback(params('203.0.113.1')),
    controller.processLinkForPlayback(params('203.0.113.2')),
  ]);
  assert.equal(calls, 1, 'antes, cada IP criava o seu torrent');
  assert.equal(a, b);
});
