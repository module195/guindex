// Credenciais TMDB vêm só do env (Easypanel). Com o read token (v4) definido,
// a chave v3 não vai na URL; e nada que é logado pode carregar api_key=.
// Roda contra o build: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

process.env.TMDB_API_KEY = 'v3-test-key-0000';
process.env.TMDB_API_READ_ACCESS_TOKEN = 'v4-test-token-0000';

const { TorrentIndexerProvider } = await import('../dist/services/torrent-indexer-provider.js');
const { redactSecrets } = await import('../dist/utils/redact-secrets.js');

let agent;
let previous;
before(() => {
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
after(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
});

test('com read token definido, a chave v3 não vai na query string', async () => {
  const provider = new TorrentIndexerProvider('torrent-indexer', 'http://127.0.0.1:1');
  let seenPath = '';
  let seenAuth = '';
  agent
    .get('https://api.themoviedb.org')
    .intercept({
      path: (p) => {
        seenPath = p;
        return p.startsWith('/3/find/tt0000601?');
      },
      method: 'GET',
    })
    .reply(200, (opts) => {
      seenAuth = String(opts.headers?.Authorization ?? opts.headers?.authorization ?? '');
      return { movie_results: [{ title: 'Matrix' }], tv_results: [] };
    });

  const titles = await provider.fetchLocalizedTitleCandidates('tt0000601');
  assert.ok(titles.length > 0);
  assert.ok(!seenPath.includes('api_key'), `api_key na URL: ${seenPath.replace(/api_key=[^&]+/, 'api_key=…')}`);
  assert.equal(seenAuth, 'Bearer v4-test-token-0000');
});

test('redactSecrets tira api_key, tokens e Bearer de mensagens', () => {
  const msg =
    'fetch failed https://api.themoviedb.org/3/find/tt1?api_key=abcd1234&language=pt-BR ' +
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y access_token=zzz';
  const out = redactSecrets(msg);
  assert.ok(!out.includes('abcd1234'), out);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), out);
  assert.ok(!out.includes('zzz'), out);
  assert.ok(out.includes('language=pt-BR'), out);
  assert.equal(redactSecrets(new Error('x api_key=k1')), 'x api_key=[redacted]');
});
