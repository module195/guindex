// Estáticos com cache de 1 dia e config-page.js versionado pelo hash do conteúdo.
// Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { setupRoutes } = await import('../dist/routes/routes.js');

test('imagens de public/ saem com max-age de 1 dia', async () => {
  const app = setupRoutes();
  const logo = await app.inject({ method: 'GET', url: '/logo.png' });
  assert.equal(logo.statusCode, 200);
  assert.equal(logo.headers['cache-control'], 'public, max-age=86400');
  await app.close();
});

test('/configure aponta para config-page.js?v=<hash do arquivo> e segue no-store', async () => {
  const app = setupRoutes();
  const page = await app.inject({ method: 'GET', url: '/configure' });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['cache-control'], 'no-store');

  const hash = createHash('sha256')
    .update(readFileSync(path.resolve('public', 'config-page.js')))
    .digest('hex')
    .slice(0, 12);
  const src = `/config-page.js?v=${hash}`;
  assert.ok(page.body.includes(`<script src="${src}"></script>`), 'script com a versão do conteúdo atual');

  const script = await app.inject({ method: 'GET', url: src });
  assert.equal(script.statusCode, 200);
  assert.equal(script.headers['cache-control'], 'public, max-age=86400');
  assert.equal(script.body, readFileSync(path.resolve('public', 'config-page.js'), 'utf8'));
  await app.close();
});
