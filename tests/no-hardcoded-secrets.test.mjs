// S-01 (auditoria de segurança 2026-11-09): credenciais TMDB não podem
// ficar como fallback literal no código. Scripts de teste manuais devem ler
// do ambiente e pular quando a variável não existir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = ['src', 'tests', 'scripts'];
const EXT = /\.(ts|mts|cts|js|mjs|cjs|json)$/;

// JWT (ex.: TMDB "API Read Access Token") e chave v3 TMDB (32 hex) em linha
// que menciona tmdb/api_key.
const JWT = /eyJhbGciOi[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const TMDB_V3 = /['"`][0-9a-f]{32}['"`]/i;
const TMDB_CTX = /tmdb|api_key/i;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const redact = (s) => `${s.slice(0, 4)}…(${s.length})`;

test('nenhum token/chave TMDB literal em src/, tests/ ou scripts/', () => {
  const hits = [];
  for (const d of DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const jwt = line.match(JWT);
        if (jwt) hits.push(`${relative(ROOT, file)}:${i + 1} JWT ${redact(jwt[0])}`);
        const v3 = line.match(TMDB_V3);
        if (v3 && TMDB_CTX.test(line)) {
          hits.push(`${relative(ROOT, file)}:${i + 1} TMDB v3 ${redact(v3[0].slice(1, -1))}`);
        }
      });
    }
  }
  assert.deepEqual(hits, [], `credenciais literais encontradas:\n${hits.join('\n')}`);
});
