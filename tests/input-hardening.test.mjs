// Entrada do usuário em /configure e no ctx do /resolve (auditoria 28/10). Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ConfigController, escapeHtml } = await import('../dist/controllers/config-controller.js');
const { StreamService } = await import('../dist/services/stream-service.js');

const encodeCtx = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('escapeHtml escapa os 5 caracteres especiais', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(undefined), '');
});

test('/configure não reflete token com HTML', () => {
  const payload = '"><script>alert(1)</script>aaaaaaaaaaaaaaaaaaaa';
  const html = new ConfigController().generateConfigHTML(
    { debridProvider: 'torbox', torboxToken: payload, realdebridToken: payload },
    true
  );
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('ctx do /resolve descarta episódio que não é inteiro', () => {
  const ctx = StreamService.decodeStreamContext(
    encodeCtx({ type: 'series', season: 1, episode: '(a+)+$', episodeList: [3, '(b+)+', 4.5, 5] })
  );
  assert.deepEqual(ctx, { type: 'series', season: 1, episodeList: [3, 5] });
});

test('ctx do /resolve mantém os campos válidos', () => {
  const ctx = StreamService.decodeStreamContext(
    encodeCtx({ type: 'series', season: 2, episode: 7, year: 2024, title: 'The Boys', episodeTitle: 'Ep' })
  );
  assert.deepEqual(ctx, { type: 'series', season: 2, episode: 7, year: 2024, title: 'The Boys', episodeTitle: 'Ep' });
  assert.equal(StreamService.decodeStreamContext(encodeCtx([1, 2])), undefined);
  assert.equal(StreamService.decodeStreamContext(encodeCtx('x')), undefined);
});
