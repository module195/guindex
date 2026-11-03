// Teto dos caches em memória. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { BoundedMap } = await import('../dist/utils/bounded-map.js');

test('descarta a entrada mais antiga ao passar do teto', () => {
  const map = new BoundedMap(3);
  for (const k of ['a', 'b', 'c', 'd']) map.set(k, k);
  assert.equal(map.size, 3);
  assert.deepEqual([...map.keys()], ['b', 'c', 'd']);
});

test('regravar uma chave a leva para o fim e não conta como nova', () => {
  const map = new BoundedMap(3);
  map.set('a', 1).set('b', 2).set('c', 3);
  map.set('a', 10);
  map.set('d', 4);
  assert.deepEqual([...map.entries()], [['c', 3], ['a', 10], ['d', 4]]);
});

test('teto inválido é recusado', () => {
  assert.throws(() => new BoundedMap(0), RangeError);
});
