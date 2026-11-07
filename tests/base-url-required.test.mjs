// Com NODE_ENV=production o servidor recusa subir sem BASE_URL: os links
// cairiam na origem do pedido, que vem de cabeçalhos que o cliente controla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(extraEnv) {
  const env = { PATH: process.env.PATH, PORT: '0', ...extraEnv };
  return spawnSync(process.execPath, ['dist/server.js'], { env, encoding: 'utf8', timeout: 5000 });
}

test('produção sem BASE_URL encerra com erro', () => {
  const r = run({ NODE_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BASE_URL é obrigatória/);
});

test('produção com a URL da plataforma não cai na checagem', () => {
  // o servidor sobe e fica rodando: o timeout do spawnSync o encerra
  const r = run({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://guindex.example' });
  assert.doesNotMatch(r.stderr ?? '', /BASE_URL é obrigatória/);
  assert.notEqual(r.status, 1);
});
