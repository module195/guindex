// Sem BASE_URL, os links de resolve usam a origem pública do pedido em vez de
// http://localhost, que o player não alcança. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.BASE_URL;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
delete process.env.VERCEL_URL;
delete process.env.RENDER_EXTERNAL_URL;

const { ConfigService } = await import('../dist/services/config-service.js');

test('sem variável de ambiente, baseUrl é localhost e marcado como fallback', () => {
  const config = ConfigService.loadConfig();
  assert.equal(config.baseUrlIsFallback, true);
  assert.match(config.baseUrl, /^http:\/\/localhost:/);
});

test('BASE_URL definido não é fallback', () => {
  process.env.BASE_URL = 'https://guindex.example.com/';
  try {
    const config = ConfigService.loadConfig();
    assert.equal(config.baseUrlIsFallback, false);
    assert.equal(config.baseUrl, 'https://guindex.example.com');
  } finally {
    delete process.env.BASE_URL;
  }
});

test('requestOrigin prefere X-Forwarded-Host/Proto do proxy', () => {
  const origin = ConfigService.requestOrigin(
    { host: 'guindex:7000', 'x-forwarded-host': 'guindex.example.com', 'x-forwarded-proto': 'https, http' },
    'http'
  );
  assert.equal(origin, 'https://guindex.example.com');
});

test('requestOrigin cai no Host e no protocolo da conexão', () => {
  assert.equal(ConfigService.requestOrigin({ host: 'meu-host:8080' }, 'http'), 'http://meu-host:8080');
  assert.equal(ConfigService.requestOrigin({}, 'http'), undefined);
});
