// Escolha do arquivo: provider (fileIdx), TorBox e RD usam a mesma regra e
// precisam apontar para o mesmo arquivo. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { selectBestFile } = await import('../dist/services/file-selection.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { RealDebridService } = await import('../dist/services/realdebrid-service.js');
const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');

const GB = 1e9;
const MB = 1e6;
const f = (name, size) => ({ name, size });
const sized = (names) => names.map((n, i) => f(n, ((i % 3) + 1) * GB));

const PACKS = {
  multiSeason: {
    ctx: { type: 'series', season: 1, episode: 3, title: 'Dark' },
    files: sized([1, 2, 3].flatMap((s) => [1, 2, 3, 4].map((e) => `Dark/Season ${s}/Dark.S0${s}E0${e}.1080p.mkv`))),
    expected: 'Dark/Season 1/Dark.S01E03.1080p.mkv',
  },
  bareNumbers: {
    ctx: { type: 'series', season: 2, episode: 3, title: 'Round 6' },
    files: sized(['Round 6 T2/01 - Pão.mkv', 'Round 6 T2/02 - Seis Pernas.mkv', 'Round 6 T2/03 - 001.mkv', 'Round 6 T2/10 - Final.mkv']),
    expected: 'Round 6 T2/03 - 001.mkv',
  },
  xNotation: {
    ctx: { type: 'series', season: 3, episode: 1, title: 'The Office' },
    files: sized(['The Office 3x01 Gay Witch Hunt.avi', 'The Office 3x10 A Benihana.avi', 'The Office 1x03.avi']),
    expected: 'The Office 3x01 Gay Witch Hunt.avi',
  },
  movieExtras: {
    ctx: { type: 'movie', title: 'Oppenheimer', year: 2023 },
    files: [f('Oppenheimer.2023.1080p.mkv', 8 * GB), f('Extras/Featurette.mkv', 2 * GB), f('Sample/sample.mkv', 40 * MB), f('Oppenheimer.nfo', 5000)],
    expected: 'Oppenheimer.2023.1080p.mkv',
  },
  movieDubLeg: {
    ctx: { type: 'movie', title: 'Duna', year: 2021 },
    files: [f('Duna.2021.1080p.LEGENDADO.mkv', 9 * GB), f('Duna.2021.1080p.DUBLADO.mkv', 8 * GB)],
    expected: 'Duna.2021.1080p.DUBLADO.mkv',
  },
  episodeDubLeg: {
    ctx: { type: 'series', season: 1, episode: 2, title: 'The Bear' },
    files: [f('The.Bear.S01E02.LEGENDADO.mkv', 2 * GB), f('The.Bear.S01E02.DUBLADO.mkv', 1.8 * GB), f('The.Bear.S01E01.DUBLADO.mkv', 1.9 * GB)],
    expected: 'The.Bear.S01E02.DUBLADO.mkv',
  },
  sampleBigger: {
    ctx: { type: 'series', season: 1, episode: 1, title: 'X' },
    files: [f('X.S01E01.mkv', 1 * GB), f('X.S01E01.sample.mkv', 3 * GB)],
    expected: 'X.S01E01.mkv',
  },
  episodeTitle: {
    ctx: { type: 'series', season: 1, episode: 4, title: 'Lost', episodeTitle: 'Walkabout' },
    files: sized(['Lost 1x03 Tabula Rasa.mkv', 'Lost 1x04 Walkabout.mkv', 'Lost 1x05 White Rabbit.mkv']),
    expected: 'Lost 1x04 Walkabout.mkv',
  },
};

const torbox = new TorboxService('x');
const rd = new RealDebridService('x');
const provider = new TorrentIndexerProvider('torrent-indexer', 'http://127.0.0.1:1');

for (const [name, { ctx, files, expected }] of Object.entries(PACKS)) {
  test(`${name}: provider, TorBox e RD escolhem ${expected}`, () => {
    const tbFiles = files.map((x, i) => ({ id: i, name: x.name, short_name: x.name.split('/').pop(), size: x.size }));
    const rdFiles = files.map((x, i) => ({ id: i + 1, path: `/${x.name}`, bytes: x.size, selected: 0 }));
    const torrent = { title: 'pack', files: files.map((x) => ({ path: x.name, size: x.size })) };
    const matchContext = {
      parsed: { imdbId: 'tt1', season: ctx.season, episode: ctx.episode },
      type: ctx.type,
      targetTitles: [ctx.title],
      releaseYear: ctx.year,
      episodeTitle: ctx.episodeTitle,
    };

    assert.equal(provider.selectBestTorrentFile(torrent, matchContext)?.path, expected);
    assert.equal(torbox.selectBestFile(tbFiles, ctx)?.name, expected);
    assert.equal(rd.selectBestFile(rdFiles, ctx)?.path, `/${expected}`);
  });
}

test('sem vídeo, devolve o maior arquivo', () => {
  const files = [{ path: 'a.nfo', bytes: 10 }, { path: 'a.rar', bytes: 4 * GB }];
  assert.equal(selectBestFile(files, (x) => x, { type: 'movie' })?.path, 'a.rar');
});

test('sem contexto, devolve o maior vídeo que não é lixo', () => {
  const files = [{ path: 'big.sample.mkv', bytes: 9 * GB }, { path: 'movie.mkv', bytes: 2 * GB }];
  assert.equal(selectBestFile(files, (x) => x)?.path, 'movie.mkv');
});
