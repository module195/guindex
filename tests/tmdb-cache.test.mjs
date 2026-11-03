// Cache de títulos PT-BR do TMDB: falha (timeout, rede, HTTP fora de 2xx) não
// pode ficar 7 dias em cache. Roda contra o build: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

process.env.TMDB_API_KEY = 'test-key';
process.env.TORRENT_INDEXER_LOCALIZED_TITLE_FAILURE_TTL_MS = '50';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIND_PATH = (imdb) => (path) => path.startsWith(`/3/find/${imdb}?`);
const OK_BODY = { movie_results: [{ title: 'Matrix', original_title: 'The Matrix' }], tv_results: [] };

let agent;
let previous;
before(() => {
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
after(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
});

const tmdb = () => agent.get('https://api.themoviedb.org');

test('HTTP 500 do TMDB fica só no TTL curto e a próxima consulta pega os títulos', async () => {
  const provider = new TorrentIndexerProvider('torrent-indexer', 'http://127.0.0.1:1');
  const imdb = 'tt0000501';
  tmdb().intercept({ path: FIND_PATH(imdb), method: 'GET' }).reply(500, 'erro');
  tmdb().intercept({ path: FIND_PATH(imdb), method: 'GET' }).reply(200, OK_BODY);

  assert.deepEqual(await provider.fetchLocalizedTitleCandidates(imdb), []);
  // Dentro do TTL curto: não consulta de novo
  assert.deepEqual(await provider.fetchLocalizedTitleCandidates(imdb), []);
  await sleep(80);
  const titles = await provider.fetchLocalizedTitleCandidates(imdb);
  assert.ok(titles.length > 0, 'depois do TTL curto deve trazer os títulos');
});

test('erro de rede também usa o TTL curto', async () => {
  const provider = new TorrentIndexerProvider('torrent-indexer', 'http://127.0.0.1:1');
  const imdb = 'tt0000502';
  tmdb().intercept({ path: FIND_PATH(imdb), method: 'GET' }).replyWithError(new Error('ECONNRESET'));
  tmdb().intercept({ path: FIND_PATH(imdb), method: 'GET' }).reply(200, OK_BODY);

  assert.deepEqual(await provider.fetchLocalizedTitleCandidates(imdb), []);
  await sleep(80);
  assert.ok((await provider.fetchLocalizedTitleCandidates(imdb)).length > 0);
});

test('resposta 200 continua no cache longo', async () => {
  const provider = new TorrentIndexerProvider('torrent-indexer', 'http://127.0.0.1:1');
  const imdb = 'tt0000503';
  tmdb().intercept({ path: FIND_PATH(imdb), method: 'GET' }).reply(200, OK_BODY);

  const first = await provider.fetchLocalizedTitleCandidates(imdb);
  assert.ok(first.length > 0);
  await sleep(80);
  // Sem novo intercept: se consultasse de novo, o MockAgent recusaria a conexão
  assert.deepEqual(await provider.fetchLocalizedTitleCandidates(imdb), first);
});
