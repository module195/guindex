// Token debrid do env só vale com ALLOW_ENV_DEBRID_TOKEN=true; sem isso, um
// pedido anônimo a /stream não recebe links com o token do dono. npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { StreamService } = await import('../dist/services/stream-service.js');

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['ALLOW_ENV_DEBRID_TOKEN', 'TORBOX_TOKEN', 'REALDEBRID_TOKEN']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const anonymousSelection = () =>
  StreamService.resolveDebridSelection({ query: {}, headers: {}, env: StreamController.envDebridTokens() });

test('sem ALLOW_ENV_DEBRID_TOKEN o token do env é ignorado', () => {
  delete process.env.ALLOW_ENV_DEBRID_TOKEN;
  process.env.TORBOX_TOKEN = 'dono-torbox';
  process.env.REALDEBRID_TOKEN = 'dono-rd';
  const selection = anonymousSelection();
  assert.equal(selection.token, undefined);
  assert.equal(selection.torboxToken, undefined);
  assert.equal(selection.realdebridToken, undefined);
});

test('valores diferentes de "true" não liberam o token', () => {
  process.env.ALLOW_ENV_DEBRID_TOKEN = '1';
  process.env.TORBOX_TOKEN = 'dono-torbox';
  assert.equal(anonymousSelection().token, undefined);
});

test('com ALLOW_ENV_DEBRID_TOKEN=true o token do env é usado', () => {
  process.env.ALLOW_ENV_DEBRID_TOKEN = 'true';
  delete process.env.REALDEBRID_TOKEN;
  process.env.TORBOX_TOKEN = 'dono-torbox';
  const selection = anonymousSelection();
  assert.equal(selection.provider, 'torbox');
  assert.equal(selection.token, 'dono-torbox');
});
