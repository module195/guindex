// TorBox reaproveita o torrent que já está na conta em vez de chamar
// createtorrent a cada play. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const { TorboxService } = await import('../dist/services/torbox-service.js');
const torbox = mockAgent.get('https://api.torbox.app');

const files = [{ id: 0, name: 'Movie.2024.1080p.mkv', size: 2_000_000_000 }];
const query = (opts) => new URL(opts.path, 'https://api.torbox.app').searchParams;
const isList = (path) => path.startsWith('/v1/api/torrents/mylist') && !query({ path }).has('id');
const isInfo = (path) => path.startsWith('/v1/api/torrents/mylist') && query({ path }).has('id');

function mockInfoAndLink(id) {
  torbox
    .intercept({ path: (p) => isInfo(p) && query({ path: p }).get('id') === String(id), method: 'GET' })
    .reply(200, { success: true, data: { id, download_present: true, files } })
    .persist();
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/requestdl') && query({ path: p }).get('torrent_id') === String(id), method: 'GET' })
    .reply(200, { success: true, data: `https://cdn.example/${id}.mkv` })
    .persist();
}

test('torrent já na conta é reaproveitado sem createtorrent', async () => {
  const hash = 'b'.repeat(40);
  // Sem intercept para createtorrent: se fosse chamado, o MockAgent recusaria e o play cairia no placeholder
  torbox
    .intercept({ path: isList, method: 'GET' })
    .reply(200, { success: true, data: [{ id: 41, hash: hash.toUpperCase() }, { id: 42, hash: 'c'.repeat(40) }] });
  mockInfoAndLink(41);

  const result = await new TorboxService('token-reuse').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${hash}`);
  assert.equal(result.url, 'https://cdn.example/41.mkv');
});

test('hash fora da conta cria o torrent uma vez; o play seguinte reaproveita', async () => {
  const hash = 'd'.repeat(40);
  let created = 0;
  let listed = 0;
  torbox
    .intercept({ path: isList, method: 'GET' })
    .reply(() => {
      listed++;
      return { statusCode: 200, data: { success: true, data: [] } };
    })
    .persist();
  torbox
    .intercept({ path: '/v1/api/torrents/createtorrent', method: 'POST', body: (b) => b.includes(hash) })
    .reply(() => {
      created++;
      return { statusCode: 200, data: { success: true, data: { torrent_id: 51, hash } } };
    })
    .persist();
  mockInfoAndLink(51);

  const service = new TorboxService('token-novo');
  const magnet = `magnet:?xt=urn:btih:${hash}`;
  assert.equal((await service.processMagnetToDirectUrl(magnet)).url, 'https://cdn.example/51.mkv');
  assert.equal((await new TorboxService('token-novo').processMagnetToDirectUrl(magnet)).url, 'https://cdn.example/51.mkv');
  assert.equal(created, 1);
  assert.equal(listed, 1, 'a lista da conta fica em cache entre plays');
});

test('falha ao listar a conta não impede o play', async () => {
  const hash = 'e'.repeat(40);
  torbox.intercept({ path: isList, method: 'GET' }).reply(500, 'erro');
  torbox
    .intercept({ path: '/v1/api/torrents/createtorrent', method: 'POST', body: (b) => b.includes(hash) })
    .reply(200, { success: true, data: { torrent_id: 61, hash } });
  mockInfoAndLink(61);

  const result = await new TorboxService('token-falha').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${hash}`);
  assert.equal(result.url, 'https://cdn.example/61.mkv');
});
