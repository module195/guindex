// Relevância de torrents sem IMDb: ano dentro do título, títulos curtos,
// número por extenso e episódio duplo. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TorrentParser } = await import('../dist/services/torrent-parser.js');
const parser = new TorrentParser();

const movie = (targetTitles, releaseYear) => ({
  parsed: { imdbId: 'tt0000001' },
  type: 'movie',
  targetTitles,
  releaseYear,
});
const episode = (targetTitles, season, ep) => ({
  parsed: { imdbId: 'tt0000002', season, episode: ep },
  type: 'series',
  targetTitles,
});

test('ano que faz parte do nome não descarta o filme (Blade Runner 2049)', () => {
  assert.equal(parser.isRelevantTorrent({ title: 'Blade Runner 2049 (2017) 1080p' }, movie(['Blade Runner 2049'], 2017)), true);
  assert.equal(parser.isRelevantTorrent({ title: 'Blade Runner 2049 2017 1080p Dublado' }, movie(['Blade Runner 2049'], 2017)), true);
});

test('ano errado continua descartando', () => {
  assert.equal(parser.isRelevantTorrent({ title: 'Blade Runner 1982 1080p' }, movie(['Blade Runner'], 2017)), false);
  assert.equal(parser.isRelevantTorrent({ title: 'Duna 1984 1080p' }, movie(['Duna'], 2021)), false);
});

test('título curto casa como palavra inteira no começo (Up)', () => {
  assert.equal(parser.isRelevantTorrent({ title: 'Up 2009 1080p' }, movie(['Up'], 2009)), true);
  assert.equal(parser.isRelevantTorrent({ title: 'Up Altas Aventuras 2009 1080p' }, movie(['Up'], 2009)), true);
  assert.equal(parser.isRelevantTorrent({ title: 'Upgrade 2009 1080p' }, movie(['Up'], 2009)), false);
  assert.equal(parser.isRelevantTorrent({ title: 'Superman 2009 1080p' }, movie(['Up'], 2009)), false);
});

test('"Parte Dois" casa com "Parte 2"', () => {
  assert.equal(parser.isRelevantTorrent({ title: 'Duna Parte 2 2024 1080p' }, movie(['Duna: Parte Dois'], 2024)), true);
  assert.equal(parser.isRelevantTorrent({ title: 'Dune Part Two 2024 1080p' }, movie(['Dune: Part 2'], 2024)), true);
});

test('episódio duplo S04E01E02 extrai temporada e episódio', () => {
  const t = { title: 'The Boys S04E01E02 1080p' };
  assert.equal(parser.extractSeasonFromTorrent(t), 4);
  assert.equal(parser.extractEpisodeFromTorrent(t), 1);
  assert.equal(parser.isRelevantTorrent(t, episode(['The Boys'], 4, 1)), true);
  assert.equal(parser.isRelevantTorrent(t, episode(['The Boys'], 3, 1)), false);
});
