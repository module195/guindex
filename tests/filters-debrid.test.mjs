// Filtros de relevância (filme x série, faixas de episódios) e TorBox
// (checkcached em lotes, arquivo de id 0). Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
const torbox = mockAgent.get('https://api.torbox.app');

const provider = new TorrentIndexerProvider('GuIndex', 'http://127.0.0.1:1');
const relevant = (torrent, context) => provider.isRelevantTorrent(torrent, context);

const movieContext = {
  parsed: { imdbId: 'tt15398776' },
  type: 'movie',
  targetTitles: ['Oppenheimer'],
  releaseYear: 2023,
};
const movie = (title, imdb = 'tt15398776', year = '2023') => ({
  title,
  imdb: `https://www.imdb.com/title/${imdb}/`,
  year,
});

test('filme: nomes comuns de release não contam como série', () => {
  const titles = [
    'Oppenheimer 2023 1080p BluRay DTS5.1 x264',
    'Oppenheimer (2023) Filme Completo Dublado',
    'Oppenheimer 2023 1920x1080 Dual Audio',
    'Oppenheimer 2023 2160p Pack de legendas',
    'Oppenheimer 2023 Collection Edition 1080p',
    'Oppenheimer 2023 1080p BluRay DTS 5.1 Dublado',
  ];
  for (const title of titles) {
    assert.equal(relevant(movie(title), movieContext), true, title);
  }

  const others = [
    ['Star Wars: Episódio IV - Uma Nova Esperança 1977 1080p', 'tt0076759', '1977'],
    ['Star Wars Episode IV A New Hope 1977 1080p', 'tt0076759', '1977'],
    ['A Série Divergente: Insurgente 2015 1080p Dublado', 'tt2908446', '2015'],
    ['Se Beber Nao Case Wolfpack Edition 2009 1080p', 'tt1119646', '2009'],
  ];
  for (const [title, imdb, year] of others) {
    const context = { parsed: { imdbId: imdb }, type: 'movie', targetTitles: [], releaseYear: Number(year) };
    assert.equal(relevant(movie(title, imdb, year), context), true, title);
  }
});

test('filme: release de série com o mesmo IMDb continua descartado', () => {
  const titles = [
    'Oppenheimer S01E03 1080p',
    'Oppenheimer 2ª Temporada Completa',
    'Oppenheimer 1x03 Dublado',
    'Oppenheimer Season 2 Complete',
    'Oppenheimer Minissérie Completa',
  ];
  for (const title of titles) {
    assert.equal(relevant(movie(title), movieContext), false, title);
  }
  assert.equal(relevant({ ...movie('Oppenheimer 2023'), season: 1 }, movieContext), false);
});

test('série: faixa ou lista de episódios no nome decide', () => {
  const context = {
    parsed: { imdbId: 'tt0903747', season: 2, episode: 3 },
    type: 'series',
    targetTitles: ['Breaking Bad'],
  };
  const series = (title) => ({ title, imdb: 'https://www.imdb.com/title/tt0903747/' });
  const cases = [
    ['Breaking Bad S02E01-E05 1080p', true],
    ['Breaking Bad S02E01-05 1080p', true],
    ['Breaking Bad S02E02-E03 1080p', true],
    ['Breaking Bad S02E01 ao E05 1080p', true],
    ['Breaking Bad S02E01E02E03 1080p', true],
    ['Breaking Bad 2ª Temporada Episódios 01 ao 05', true],
    ['Breaking Bad 2ª Temporada Episódios 06 ao 13', false],
    ['Breaking Bad S02E03 1080p', true],
    ['Breaking Bad S02E13 1080p', false],
    ['Breaking Bad S02E04-E06 1080p', false],
    ['Breaking Bad 2x03 Dual', true],
    ['Breaking Bad 2ª Temporada Completa', true],
    ['Breaking Bad 3ª Temporada Completa', false],
  ];
  for (const [title, expected] of cases) {
    assert.equal(relevant(series(title), context), expected, title);
  }

  const e4 = { ...context, parsed: { ...context.parsed, season: 1, episode: 4 } };
  assert.equal(relevant(series('Breaking Bad EPISODIO-03-E-04 S01E03-04'), e4), true);
});

test('TorBox: checkcached vai em lotes e um lote com erro não derruba os outros', async () => {
  const hashes = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(40, '0'));
  const calls = [];
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/checkcached'), method: 'GET' })
    .reply((opts) => {
      const asked = new URL(opts.path, 'https://api.torbox.app').searchParams.getAll('hash');
      calls.push(asked.length);
      if (calls.length === 2) return { statusCode: 500, data: 'erro' };
      return { statusCode: 200, data: { success: true, data: asked.map((hash) => ({ hash, files: [{ id: 0 }] })) } };
    })
    .times(3);

  const result = await TorboxService.fetchCachedInfoHashes(hashes, 'token-lotes');
  assert.deepEqual(calls.sort((a, b) => b - a), [90, 90, 20]);
  assert.equal(result.size, 110);
});

test('TorBox: checkcached sem lista de arquivos, e pedidos simultâneos do mesmo hash viram uma consulta', async () => {
  const hash = 'd'.repeat(40);
  const asked = [];
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/checkcached'), method: 'GET' })
    .reply((opts) => {
      asked.push(new URL(opts.path, 'https://api.torbox.app').searchParams);
      return { statusCode: 200, data: { success: true, data: [{ hash, name: 'x', size: 1 }] } };
    })
    .delay(50);

  const [a, b] = await Promise.all([
    TorboxService.checkCachedInfoHashes([hash], 'token-dedupe'),
    TorboxService.checkCachedInfoHashes([hash.toUpperCase()], 'token-dedupe'),
  ]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].get('list_files'), 'false');
  assert.deepEqual([...a.cached], [hash]);
  assert.deepEqual([...b.cached], [hash]);
  assert.equal(a.unknown.size + b.unknown.size, 0);
});

test('TorBox: consulta com erro volta como desconhecida e não fica no cache de disponibilidade', async () => {
  const hash = 'e'.repeat(40);
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/checkcached'), method: 'GET' })
    .reply(503, 'fora do ar');
  const failed = await TorboxService.checkCachedInfoHashes([hash], 'token-erro');
  assert.deepEqual([...failed.unknown], [hash]);
  assert.equal(failed.cached.size, 0);

  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/checkcached'), method: 'GET' })
    .reply(200, { success: true, data: [] });
  const retried = await TorboxService.checkCachedInfoHashes([hash], 'token-erro');
  assert.equal(retried.unknown.size, 0, 'a segunda consulta vai ao TorBox de novo');
  assert.equal(retried.cached.size, 0);
});

const checkcached = { path: (p) => p.startsWith('/v1/api/torrents/checkcached'), method: 'GET' };
const askedHashes = (opts) => new URL(opts.path, 'https://api.torbox.app').searchParams.getAll('hash');
const authOf = (opts) => {
  const headers = opts.headers ?? {};
  if (Array.isArray(headers)) {
    const i = headers.findIndex((h) => String(h).toLowerCase() === 'authorization');
    return i >= 0 ? String(headers[i + 1]) : '';
  }
  return String(headers.authorization ?? headers.Authorization ?? '');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('TorBox: cada resposta chega assim que sai, e a do cache de disponibilidade na hora', async () => {
  const known = '1a'.repeat(20);
  const fresh = '1b'.repeat(20);
  torbox.intercept(checkcached).reply(200, { success: true, data: [{ hash: known }] });
  await TorboxService.checkCachedInfoHashes([known], 'token-respostas');

  torbox.intercept(checkcached).reply(200, { success: true, data: [] }).delay(50);
  const answers = [];
  const pending = TorboxService.checkCachedInfoHashes([known, fresh], 'token-respostas', (hash, isCached) =>
    answers.push([hash, isCached])
  );
  assert.deepEqual(answers, [[known, true]], 'o hash já conhecido sai antes da consulta nova');
  const result = await pending;
  assert.deepEqual(answers, [[known, true], [fresh, false]]);
  assert.deepEqual([...result.cached], [known]);
  assert.equal(result.unknown.size, 0);
});

test('TorBox: a chave com erro de um usuário não deixa o mesmo hash sem resposta para outro', async () => {
  const hash = '2a'.repeat(20);
  const tokens = [];
  torbox
    .intercept(checkcached)
    .reply((opts) => {
      const auth = authOf(opts);
      tokens.push(auth);
      if (auth.includes('token-invalido')) return { statusCode: 401, data: { success: false, error: 'AUTH_ERROR' } };
      return { statusCode: 200, data: { success: true, data: askedHashes(opts).map((h) => ({ hash: h })) } };
    })
    .times(2);

  const [bad, good] = await Promise.all([
    TorboxService.checkCachedInfoHashes([hash], 'token-invalido'),
    TorboxService.checkCachedInfoHashes([hash], 'token-valido'),
  ]);
  assert.equal(tokens.length, 2, 'cada chave faz a sua consulta');
  assert.deepEqual([...bad.unknown], [hash]);
  assert.deepEqual([...good.cached], [hash]);
  assert.equal(good.unknown.size, 0);
});

test('TorBox: consulta presa não segura quem chega depois; vale a primeira resposta', async () => {
  const hash = '3a'.repeat(20);
  const shareMs = TorboxService.IN_FLIGHT_SHARE_MS;
  TorboxService.IN_FLIGHT_SHARE_MS = 30;
  try {
    let calls = 0;
    torbox
      .intercept(checkcached)
      .reply(() => {
        calls++;
        return { statusCode: 200, data: { success: true, data: [{ hash }] } };
      })
      .delay(800);
    torbox
      .intercept(checkcached)
      .reply(() => {
        calls++;
        return { statusCode: 200, data: { success: true, data: [{ hash }] } };
      });

    const first = TorboxService.checkCachedInfoHashes([hash], 'token-presa');
    await sleep(60);
    const started = Date.now();
    const second = await TorboxService.checkCachedInfoHashes([hash], 'token-presa');
    assert.ok(Date.now() - started < 400, `levou ${Date.now() - started}ms`);
    assert.equal(calls, 2, 'a consulta antiga continua; a nova sai ao lado dela');
    assert.deepEqual([...second.cached], [hash]);
    assert.deepEqual([...(await first).cached], [hash]);
  } finally {
    TorboxService.IN_FLIGHT_SHARE_MS = shareMs;
  }
});

test('TorBox: consulta que trava depois que outro pedido entrou nela abre outra sozinha', async () => {
  const hash = '5a'.repeat(20);
  const shareMs = TorboxService.IN_FLIGHT_SHARE_MS;
  TorboxService.IN_FLIGHT_SHARE_MS = 60;
  try {
    let calls = 0;
    const reply = () => {
      calls++;
      return { statusCode: 200, data: { success: true, data: [{ hash }] } };
    };
    torbox.intercept(checkcached).reply(reply).delay(1500);
    torbox.intercept(checkcached).reply(reply);

    const first = TorboxService.checkCachedInfoHashes([hash], 'token-trava');
    await sleep(10);
    const started = Date.now();
    const joined = await TorboxService.checkCachedInfoHashes([hash], 'token-trava');
    assert.ok(Date.now() - started < 500, `quem entrou na consulta presa esperou ${Date.now() - started}ms`);
    assert.equal(calls, 2);
    assert.deepEqual([...joined.cached], [hash]);
    assert.deepEqual([...(await first).cached], [hash]);
    assert.equal(TorboxService.knownAvailability(hash), true, 'e a resposta fica no cache de disponibilidade');
  } finally {
    TorboxService.IN_FLIGHT_SHARE_MS = shareMs;
  }
});

test('TorBox: item malformado no checkcached não derruba a consulta', async () => {
  const hash = '4a'.repeat(20);
  torbox.intercept(checkcached).reply(200, { success: true, data: [null, { hash: 123 }, 'x', { hash }] });
  const result = await TorboxService.checkCachedInfoHashes([hash, '4b'.repeat(20)], 'token-malformado');
  assert.deepEqual([...result.cached], [hash]);
  assert.equal(result.unknown.size, 0);
});

test('TorBox: arquivo de id 0 é pedido com file_id=0, sem trocar de episódio', async () => {
  const requested = [];
  torbox
    .intercept({ path: '/v1/api/torrents/createtorrent', method: 'POST' })
    .reply(200, { success: true, data: { torrent_id: 7, hash: 'a'.repeat(40) } });
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/mylist'), method: 'GET' })
    .reply(200, {
      success: true,
      data: {
        id: 7,
        download_present: true,
        files: [
          { id: 0, name: 'Show.S01E01.1080p.mkv', size: 1_000_000_000 },
          { id: 1, name: 'Show.S01E02.1080p.mkv', size: 2_000_000_000 },
        ],
      },
    })
    .persist();
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/requestdl'), method: 'GET' })
    .reply((opts) => {
      const fileId = new URL(opts.path, 'https://api.torbox.app').searchParams.get('file_id');
      requested.push(fileId);
      return { statusCode: 200, data: { success: true, data: `https://cdn.example/${fileId}.mkv` } };
    })
    .persist();

  const service = new TorboxService('token-arquivo');
  const result = await service.processMagnetToDirectUrl(`magnet:?xt=urn:btih:${'a'.repeat(40)}`, {
    type: 'series',
    season: 1,
    episode: 1,
  });
  assert.equal(result.url, 'https://cdn.example/0.mkv');
  assert.deepEqual(requested, ['0']);
});
