// IF-04 (auditoria de feature de 09/11/2026): o populate:tmdb chamava
// /indexers/all, rota que não existe no torrent-indexer (o catch-all "/" responde
// 200 com a documentação e o script contava como sucesso). Checagem de fonte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/scripts/populate-tmdb.ts', import.meta.url), 'utf8');

test('populate:tmdb usa /indexers/multi, não /indexers/all', () => {
  assert.ok(!src.includes('/indexers/all'), 'rota inexistente /indexers/all');
  assert.ok(src.includes('/indexers/multi'), 'deveria usar /indexers/multi');
});

test('populate:tmdb não conta sucesso sem "results" na resposta', () => {
  assert.match(src, /Array\.isArray\(data\??\.results\)/);
});
