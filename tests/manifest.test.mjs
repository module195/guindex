// Manifest montado uma vez e entregue com cache HTTP longo. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { setupRoutes } = await import('../dist/routes/routes.js');
const { ConfigController } = await import('../dist/controllers/config-controller.js');

test('manifest é o mesmo objeto entre chamadas', () => {
  const controller = new ConfigController();
  assert.equal(controller.createAddonManifest(true), controller.createAddonManifest(true));
  assert.notEqual(controller.createAddonManifest(true), controller.createAddonManifest(false));
  assert.equal(controller.createAddonManifest(false).behaviorHints.configurationRequired, true);
  assert.equal(controller.createAddonManifest(true).behaviorHints.configurationRequired, false);
});

test('as três rotas de manifest mandam Cache-Control público e longo', async () => {
  const app = setupRoutes();
  const token = 'x'.repeat(32);
  for (const url of ['/manifest.json', `/${token}/manifest.json`, `/realdebrid/${token}/manifest.json`]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.match(res.headers['cache-control'], /^public, max-age=3600, .*stale-if-error=604800$/, url);
    assert.equal(res.json().id, 'org.guindex.addon');
    assert.ok(!res.body.includes(token), `o manifest não pode levar o token (${url})`);
  }
  await app.close();
});
