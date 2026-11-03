// Catálogo "Minha TorBox": manifest, catalog, meta, stream e resolve dos itens
// da conta, como o catálogo do Library do AIOStreams. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupRoutes } = await import('../dist/routes/routes.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const lib = await import('../dist/services/torbox-library.js');

const TOKEN = 't'.repeat(36);
const originals = {
  library: TorboxService.accountLibrary,
  torrent: TorboxService.accountTorrent,
  link: TorboxService.accountFileLink,
  forget: TorboxService.forgetAccount,
};
afterEach(() => Object.assign(TorboxService, {
  accountLibrary: originals.library,
  accountTorrent: originals.torrent,
  accountFileLink: originals.link,
  forgetAccount: originals.forget,
}));

const SERIES = {
  id: 2,
  hash: 'B'.repeat(40),
  name: 'Lupin.S04.1080p.WEB-DL.DUAL',
  size: 8e9,
  created_at: '2026-10-30T12:00:00Z',
  download_finished: true,
  files: [
    { id: 0, name: 'Lupin.S04.1080p.WEB-DL.DUAL/Lupin.S04E02.1080p.mkv', short_name: 'Lupin.S04E02.1080p.mkv', size: 2e9 },
    { id: 1, name: 'Lupin.S04.1080p.WEB-DL.DUAL/Lupin.S04E01.1080p.mkv', short_name: 'Lupin.S04E01.1080p.mkv', size: 2e9 },
    { id: 2, name: 'Lupin.S04.1080p.WEB-DL.DUAL/leia.txt', short_name: 'leia.txt', size: 100 },
  ],
};
const LIBRARY = [
  { id: 1, hash: 'a'.repeat(40), name: 'Duna.Parte.Dois.2024.2160p.WEB-DL', size: 2e10, created_at: '2026-10-01T00:00:00Z', download_finished: true },
  SERIES,
  { id: 3, hash: 'c'.repeat(40), name: 'Ainda.Estou.Aqui.2024.1080p', size: 3e9, created_at: '2026-09-01T00:00:00Z', download_finished: true },
];

function stubAccount() {
  TorboxService.accountLibrary = async (token) => {
    assert.equal(token, TOKEN);
    return LIBRARY;
  };
  TorboxService.accountTorrent = async (token, id) => {
    assert.equal(token, TOKEN);
    const item = LIBRARY.find((entry) => entry.id === id);
    if (!item) throw new Error('not found');
    return item;
  };
}

test('manifest com o catálogo só no formato /torbox/TOKEN/', async (t) => {
  const app = setupRoutes();
  t.after(() => app.close());
  const tb = (await app.inject({ url: `/torbox/${TOKEN}/manifest.json` })).json();
  assert.deepEqual(tb.catalogs.map((c) => c.id), [lib.LIBRARY_CATALOG_ID]);
  assert.ok(tb.types.includes('other'));
  assert.ok(tb.idPrefixes.includes('gdxlib:'));
  const stream = tb.resources.find((r) => r.name === 'stream');
  assert.deepEqual(stream.idPrefixes, ['tt', 'gdxlib:']);
  assert.ok(tb.resources.some((r) => r.name === 'meta'));

  for (const url of [`/realdebrid/${TOKEN}/manifest.json`, `/${TOKEN}/manifest.json`, '/manifest.json']) {
    const res = await app.inject({ url });
    assert.deepEqual(res.json().catalogs, [], url);
    assert.deepEqual(res.json().resources, ['stream'], url);
  }
  const raw = (await app.inject({ url: `/torbox/${TOKEN}/manifest.json` })).body;
  assert.ok(!raw.includes(TOKEN), 'o manifest não leva o token');
});

test('catálogo: mais recentes primeiro, busca, ações e paginação', async (t) => {
  stubAccount();
  const app = setupRoutes();
  t.after(() => app.close());
  const base = `/torbox/${TOKEN}/catalog/other/${lib.LIBRARY_CATALOG_ID}`;

  const all = (await app.inject({ url: `${base}.json` })).json().metas;
  assert.deepEqual(all.map((m) => m.id), ['gdxlib:2', 'gdxlib:1', 'gdxlib:3']);
  assert.equal(all[0].type, 'other');
  assert.equal(all[0].posterShape, 'landscape');

  const az = (await app.inject({ url: `${base}/genre=${encodeURIComponent('Título A-Z')}.json` })).json().metas;
  assert.deepEqual(az.map((m) => m.name), [LIBRARY[2].name, LIBRARY[0].name, SERIES.name]);

  const search = (await app.inject({ url: `${base}/search=duna.json` })).json().metas;
  assert.deepEqual(search.map((m) => m.id), ['gdxlib:1']);
  const accent = (await app.inject({ url: `${base}/search=${encodeURIComponent('aínda estóu')}.json` })).json().metas;
  assert.deepEqual(accent.map((m) => m.id), ['gdxlib:3']);

  const actions = (await app.inject({ url: `${base}/genre=${encodeURIComponent('Ações')}.json` })).json().metas;
  assert.deepEqual(actions.map((m) => m.id), ['gdxlib:action:refresh']);

  const page2 = (await app.inject({ url: `${base}/skip=100.json` })).json().metas;
  assert.deepEqual(page2, []);

  const other = (await app.inject({ url: `/realdebrid/${TOKEN}/catalog/other/${lib.LIBRARY_CATALOG_ID}.json` })).json();
  assert.deepEqual(other.metas, [], 'sem TorBox não há catálogo');
});

test('meta: um vídeo por arquivo de vídeo, em ordem de episódio', async (t) => {
  stubAccount();
  const app = setupRoutes();
  t.after(() => app.close());
  const meta = (await app.inject({ url: `/torbox/${TOKEN}/meta/other/gdxlib:2.json` })).json().meta;
  assert.equal(meta.name, SERIES.name);
  assert.deepEqual(
    meta.videos.map((v) => [v.id, v.season, v.episode]),
    [['gdxlib:2:1', 4, 1], ['gdxlib:2:0', 4, 2]],
  );
  const movie = (await app.inject({ url: `/torbox/${TOKEN}/meta/other/gdxlib:1.json` })).json().meta;
  assert.deepEqual(movie.videos.map((v) => v.id), ['gdxlib:1']);
  assert.equal(movie.behaviorHints.defaultVideoId, 'gdxlib:1');

  assert.equal((await app.inject({ url: `/torbox/${TOKEN}/meta/other/gdxlib:abc.json` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/torbox/${TOKEN}/meta/other/gdxlib:99.json` })).statusCode, 404);
});

test('ação Atualizar esquece a lista da conta', async (t) => {
  let forgotten;
  TorboxService.forgetAccount = (token) => { forgotten = token; };
  const app = setupRoutes();
  t.after(() => app.close());
  const meta = (await app.inject({ url: `/torbox/${TOKEN}/meta/other/gdxlib:action:refresh.json` })).json().meta;
  assert.equal(forgotten, TOKEN);
  assert.match(meta.name, /atualizada/);
});

test('stream de um arquivo e play pelo torrent da conta', async (t) => {
  stubAccount();
  const calls = [];
  TorboxService.accountFileLink = async (token, torrentId, fileId) => {
    calls.push([token, torrentId, fileId]);
    return 'https://cdn.torbox.invalid/Lupin.S04E01.1080p.mkv';
  };
  const app = setupRoutes();
  t.after(() => app.close());

  const { streams } = (await app.inject({ url: `/torbox/${TOKEN}/stream/other/gdxlib:2:1.json` })).json();
  assert.equal(streams.length, 1);
  const [stream] = streams;
  assert.match(stream.name, /^\[TB⚡\] 🗃️ Minha TorBox/);
  assert.equal(stream.infoHash, 'b'.repeat(40));
  assert.equal(stream.fileIdx, 1);
  assert.equal(stream.behaviorHints.filename, 'Lupin.S04E01.1080p.mkv');
  assert.ok(stream.behaviorHints.bingeGroup);
  assert.equal(stream.behaviorHints.indexer, 'Library TB');
  const url = new URL(stream.url);
  assert.equal(url.pathname, `/torbox/${TOKEN}/resolve`);
  assert.equal(url.searchParams.get('linkType'), 'library');
  assert.equal(url.searchParams.get('torrentId'), '2');
  assert.equal(url.searchParams.get('fileId'), '1');

  const play = await app.inject({ url: `${url.pathname}${url.search}` });
  assert.equal(play.statusCode, 302);
  assert.equal(play.headers.location, 'https://cdn.torbox.invalid/Lupin.S04E01.1080p.mkv');
  assert.deepEqual(calls, [[TOKEN, 2, 1]]);

  const bad = await app.inject({ url: `/torbox/${TOKEN}/resolve?linkType=library&torrentId=x` });
  assert.equal(bad.statusCode, 400);
  const missing = (await app.inject({ url: `/torbox/${TOKEN}/stream/other/gdxlib:2:9.json` })).json();
  assert.deepEqual(missing.streams, [], 'arquivo que não existe no torrent');
});

test('pontuação da busca e ids', () => {
  assert.equal(lib.scoreSearch('Duna.Parte.Dois.2024.2160p', 'duna parte dois'), 110);
  assert.equal(lib.scoreSearch('Duna.Parte.Dois.2024.2160p', 'parte'), 100);
  assert.equal(lib.scoreSearch('Duna.Parte.Dois.2024.2160p', '2160p'), 95);
  assert.equal(lib.scoreSearch('Duna.Parte.Dois.2024.2160p', 'zzz'), 0);
  assert.equal(lib.scoreSearch('Duna', '(.*)+$'), 0, 'entrada com símbolos de regex não quebra nada');
  assert.deepEqual(lib.parseLibraryId('gdxlib:12:3'), { torrentId: 12, fileId: 3 });
  assert.deepEqual(lib.parseLibraryId('gdxlib:12'), { torrentId: 12, fileId: undefined });
  assert.equal(lib.parseLibraryId('gdxlib:12:../x'), undefined);
  assert.equal(lib.parseLibraryId('tt123'), undefined);
});
