import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { RealDebridService } from '../dist/services/realdebrid-service.js';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
const rd = mockAgent.get('https://api.real-debrid.com');

const HASH_DONE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_DOWNLOADING = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_UNKNOWN = 'cccccccccccccccccccccccccccccccccccccccc';

test('marca como cacheado só o que já está baixado na conta, sem chamar instantAvailability', async () => {
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' })
    .reply(200, [
      { hash: HASH_DONE.toUpperCase(), status: 'downloaded' },
      { hash: HASH_DOWNLOADING, status: 'downloading' },
    ]);

  const result = await RealDebridService.fetchCachedInfoHashes(
    [HASH_DONE, HASH_DOWNLOADING, HASH_UNKNOWN],
    'token-a',
  );
  assert.deepEqual([...result], [HASH_DONE]);

  // Segunda chamada usa o cache em memória: sem novo intercept, o MockAgent falharia
  const again = await RealDebridService.fetchCachedInfoHashes([HASH_DONE], 'token-a');
  assert.deepEqual([...again], [HASH_DONE]);
});

test('401 devolve vazio e pausa novas chamadas para o token', async () => {
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' })
    .reply(401, { error: 'bad_token', error_code: 8 });

  const first = await RealDebridService.fetchCachedInfoHashes([HASH_DONE], 'token-b');
  assert.equal(first.size, 0);

  const second = await RealDebridService.fetchCachedInfoHashes([HASH_DONE], 'token-b');
  assert.equal(second.size, 0);
});

test('sem token não faz chamada nenhuma', async () => {
  const result = await RealDebridService.fetchCachedInfoHashes([HASH_DONE]);
  assert.equal(result.size, 0);
});

test('conta sem torrents (204) devolve vazio', async () => {
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' }).reply(204, '');
  const result = await RealDebridService.fetchCachedInfoHashes([HASH_DONE], 'token-c');
  assert.equal(result.size, 0);
});
