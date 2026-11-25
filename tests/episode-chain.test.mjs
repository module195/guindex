// Episódios citados em cadeia no nome (episode-chain.ts). Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { episodesInName } = await import('../dist/utils/episode-chain.js');

const eps = (name) => [...episodesInName(name)].sort((a, b) => a - b);

test('cadeias de episódios', () => {
  assert.deepEqual(eps('The.Chosen.S06E01-02-03.1080p.WEB-DL.DUAL.5.1'), [1, 2, 3]);
  assert.deepEqual(eps('Serie.S01E05-06-07-08.1080p'), [5, 6, 7, 8]);
  assert.deepEqual(eps('Serie S01E01-E03 1080p'), [1, 2, 3]);
  assert.deepEqual(eps('Serie S02E01 ao 05'), [1, 2, 3, 4, 5]);
  assert.deepEqual(eps('Serie S03E04 e 06'), [4, 6]);
  assert.deepEqual(eps('Serie.S01E01E02E03.1080p'), [1, 2, 3]);
  assert.deepEqual(eps('Serie.S01E01-E02-E03.mkv'), [1, 2, 3]);
});

test('episódio único e nomes sem SxxEyy', () => {
  assert.deepEqual(eps('The.Chosen.S06E04.1080p.WEB-DL.DUAL.5.1'), [4]);
  assert.deepEqual(eps('Serie.S01E04-1080p.mkv'), [4]);
  assert.deepEqual(eps('Serie 2ª Temporada Completa'), []);
  assert.deepEqual(eps('Filme.2024.1080p'), []);
});

test('palavra colada não vira faixa', () => {
  assert.deepEqual(eps('Serie.S01E02a10.mkv'), [2]);
});
