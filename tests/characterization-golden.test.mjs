// Testes de caracterização (auditoria de desempenho, 06/11/2026): congelam o
// que o guindex devolve hoje para um lote real de torrents (saída gravada do
// torrent-indexer + casos de lixo): filtro de relevância (título, ano,
// temporada/episódio), remoção de lixo, escolha de arquivo, ordenação e o
// JSON final do /stream. Otimizações não podem mudar estes arquivos.
// Regravar só depois de mudança aprovada: UPDATE_GOLDEN=1 npm test
// Roda contra o build: npm test
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'indexer-corpus.json'), 'utf8'));

const SOURCES_V2 = {
  indexer_names: ['bludv_ru', 'rede_torrent', 'starck-filmes', 'betor', 'torrentfilmeshds', 'baixarapido'],
  api_version: 2,
  indexers: [
    { name: 'bludv_ru', supports_text: true, supports_imdb: true, healthy: true },
    { name: 'rede_torrent', supports_text: true, supports_imdb: false, healthy: true },
    { name: 'starck-filmes', supports_text: true, supports_imdb: false, healthy: true },
    { name: 'betor', supports_text: false, supports_imdb: true, healthy: true },
    { name: 'torrentfilmeshds', supports_text: true, supports_imdb: false, healthy: true },
    { name: 'baixarapido', supports_text: true, supports_imdb: false, healthy: true },
  ],
  features: { multi: true },
};

// O torrent-indexer falso devolve o lote inteiro em toda busca: quem filtra é o guindex.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body;
  if (url.pathname === '/sources') body = SOURCES_V2;
  else if (url.pathname === '/search') body = { results: corpus, count: corpus.length };
  else if (url.pathname === '/indexers/multi') body = { results: [], count: 0, partial: false, calls: [] };
  else if (url.pathname.startsWith('/indexers/')) body = { results: [], count: 0 };
  else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.TORRENT_INDEXER_URL = base;
process.env.STREMIO_ADDON_SOURCES = '[]';
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '4000';
process.env.BASE_URL = 'https://guindex.test';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { TorrentParser } = await import('../dist/services/torrent-parser.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

after(() => {
  server.closeAllConnections();
  server.close();
});

// Pedidos de teste: id do Stremio + metadados que o Cinemeta/TMDB dariam.
const CASES = [
  { type: 'movie', id: 'tt15398776', name: 'Oppenheimer', year: 2023, localized: ['Oppenheimer'] },
  { type: 'movie', id: 'tt22084616', name: 'Spider-Man: Brand New Day', year: 2026, localized: ['Homem-Aranha: Um Novo Dia'] },
  { type: 'movie', id: 'tt27419466', name: 'Moana', year: 2026, localized: ['Moana'] },
  { type: 'movie', id: 'tt17490712', name: 'Mortal Kombat II', year: 2026, localized: ['Mortal Kombat 2'] },
  { type: 'series', id: 'tt1190634:5:1', name: 'The Boys', year: 2019, localized: ['The Boys'] },
  { type: 'series', id: 'tt2531336:4:2', name: 'Lupin', year: 2021, localized: ['Lupin'] },
  { type: 'series', id: 'tt18332852:2:1', name: 'Outlander: Blood of My Blood', year: 2025, localized: ['Outlander: Blood of My Blood'] },
];

function seedMetadata() {
  for (const c of CASES) {
    const imdb = c.id.split(':')[0];
    TorrentIndexerProvider.cinemetaCache.set(`${c.type}:${imdb}`, { data: { name: c.name, year: c.year }, ts: Date.now() });
    TorrentIndexerProvider.localizedTitleCache.set(imdb, { ts: Date.now(), titles: c.localized });
  }
}

beforeEach(() => {
  TorrentIndexerProvider.indexerCatalogCache = undefined;
  TorrentIndexerProvider.indexerCatalogInFlight = undefined;
  TorrentIndexerProvider.indexerCatalogFailedAt = 0;
  TorrentIndexerProvider.indexerNamesCache = undefined;
  TorrentIndexerProvider.indexerPerformance.clear();
  TorrentIndexerProvider.indexerFailureState.clear();
  TorrentIndexerProvider.searchCache.clear();
  seedMetadata();
});

function assertGolden(name, value) {
  const file = path.join(here, 'golden', `${name}.json`);
  const got = JSON.stringify(value, null, 2) + '\n';
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, got);
  assert.ok(fs.existsSync(file), `golden ${file} ausente (rode com UPDATE_GOLDEN=1)`);
  assert.equal(got, fs.readFileSync(file, 'utf8'), `saída de ${name} mudou`);
}

const slug = (c) => `${c.type}-${c.id.replace(/:/g, '-')}`;

// 1) Filtro de relevância puro, torrent a torrent.
test('golden: relevância de cada torrent do lote para cada pedido', () => {
  const parser = new TorrentParser();
  for (const c of CASES) {
    const parsed = parser.parseId(c.id);
    const context = { parsed, type: c.type, targetTitles: [...c.localized, c.name], releaseYear: c.year };
    const relevant = corpus.filter((t) => parser.isRelevantTorrent(t, context)).map((t) => `${t.info_hash} | ${t.title}`);
    assertGolden(`relevance-${slug(c)}`, relevant);
  }
});

// 2) getStreams: relevância + lixo + arquivo escolhido + dedup + teto por fonte.
test('golden: streams que o provider devolve (sem debrid)', async () => {
  const provider = new TorrentIndexerProvider('GuIndex', base);
  for (const c of CASES) {
    const streams = await provider.getStreams(c.type, c.id);
    assertGolden(`provider-${slug(c)}`, streams);
  }
});

// 3) /stream inteiro sem debrid: formato e ordem final.
test('golden: resposta do /stream sem debrid', async () => {
  for (const c of CASES) {
    const res = await new StreamController().handleStreamRequest({ type: c.type, id: c.id, extra: {} });
    assertGolden(`stream-p2p-${slug(c)}`, res);
  }
});

// 4) /stream com TorBox: selo de cache, prontos primeiro e o limite do TorBox.
test('golden: resposta do /stream com TorBox (metade dos hashes em cache)', async (t) => {
  const original = TorboxService.checkCachedInfoHashes;
  t.after(() => { TorboxService.checkCachedInfoHashes = original; });
  TorboxService.checkCachedInfoHashes = async (hashes) => {
    const list = [...hashes];
    return { cached: new Set(list.filter((h) => parseInt(h.slice(-1), 16) % 2 === 0)), unknown: new Set() };
  };
  for (const c of CASES) {
    const res = await new StreamController().handleStreamRequest({
      type: c.type,
      id: c.id,
      extra: { debridProvider: 'torbox', torboxToken: 'tok-0123456789' },
    });
    assertGolden(`stream-torbox-${slug(c)}`, res);
  }
});
