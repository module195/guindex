// STREMIO_ADDON_SOURCES com JSON inválido não derruba o boot: segue com os
// defaults e avisa. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STREMIO_ADDON_SOURCES = '[{"name": "quebrado",';

test('JSON inválido em STREMIO_ADDON_SOURCES usa os defaults', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { SOURCES } = await import('../dist/config/sources.js');
    assert.ok(SOURCES.some((source) => source.name === 'Mico-Leão Dublado'), 'addon padrão');
    assert.ok(SOURCES.some((source) => source.name === 'GuIndex'), 'o torrent-indexer segue');
    assert.ok(warnings.some((w) => /STREMIO_ADDON_SOURCES não é JSON válido/.test(w)));
  } finally {
    console.warn = warn;
  }
});
