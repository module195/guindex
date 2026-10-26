// Real-Debrid espera o magnet_conversion e consulta em intervalos curtos depois do
// selectFiles; cada play loga o tempo de cada etapa. Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.STREMIO_ADDON_SOURCES = '[]';
process.env.TORBOX_WAIT_VIDEO_URL = 'https://wait.example/downloading.mp4';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const { RealDebridService } = await import('../dist/services/realdebrid-service.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { formatSteps, timeStep, withPlaybackTiming } = await import('../dist/services/playback-timing.js');

const rd = mockAgent.get('https://api.real-debrid.com');
const torbox = mockAgent.get('https://api.torbox.app');
const files = [{ id: 1, path: '/Filme.2024.1080p.mkv', bytes: 2_000_000_000, selected: 0 }];

/** Respostas do /torrents/info/<id>, uma por consulta, na ordem. */
function infoSequence(id, statuses) {
  for (const body of statuses) {
    rd.intercept({ path: `/rest/1.0/torrents/info/${id}`, method: 'GET' }).reply(200, { id, ...body });
  }
}

function newMagnet(id) {
  rd.intercept({ path: (p) => p.startsWith('/rest/1.0/torrents?'), method: 'GET' }).reply(200, []);
  rd.intercept({ path: '/rest/1.0/torrents/addMagnet', method: 'POST' }).reply(201, { id });
}

const infoLines = [];
const originalInfo = console.info;
afterEach(() => {
  console.info = originalInfo;
  infoLines.length = 0;
});
function captureInfo() {
  console.info = (...args) => infoLines.push(args.join(' '));
}

test('formatSteps soma etapas de mesmo nome na ordem da primeira vez', () => {
  assert.equal(
    formatSteps([
      { name: 'info', ms: 100 },
      { name: 'espera', ms: 500 },
      { name: 'info', ms: 120 },
    ]),
    'info=2x 220ms, espera=500ms'
  );
});

test('timeStep fora de um play não registra nada; dentro, registra também quando falha', async () => {
  assert.equal(await timeStep('solta', async () => 1), 1);
  const { steps, done } = withPlaybackTiming(async () => {
    await timeStep('ok', async () => undefined);
    await timeStep('falha', async () => {
      throw new Error('x');
    });
  });
  await assert.rejects(done, /x/);
  assert.deepEqual(steps.map((s) => s.name), ['ok', 'falha']);
});

test('RD espera o magnet_conversion em vez de falhar sem arquivos', async () => {
  newMagnet('M1');
  infoSequence('M1', [
    { status: 'magnet_conversion' },
    { status: 'magnet_conversion' },
    { status: 'waiting_files_selection', files },
    { status: 'downloaded', files, links: ['https://real-debrid.com/d/M1'] },
  ]);
  rd.intercept({ path: '/rest/1.0/torrents/selectFiles/M1', method: 'POST' }).reply(204, '');
  rd.intercept({ path: '/rest/1.0/unrestrict/link', method: 'POST' })
    .reply(200, { download: 'https://cdn.rd.example/M1.mkv' });

  const url = await new RealDebridService('token-conv').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${'a'.repeat(40)}`);
  assert.equal(url, 'https://cdn.rd.example/M1.mkv');
});

test('RD devolve o link assim que fica downloaded, sem a espera fixa de 5 s', async () => {
  newMagnet('M2');
  infoSequence('M2', [
    { status: 'waiting_files_selection', files },
    { status: 'downloading', files },
    { status: 'downloaded', files, links: ['https://real-debrid.com/d/M2'] },
  ]);
  rd.intercept({ path: '/rest/1.0/torrents/selectFiles/M2', method: 'POST' }).reply(204, '');
  rd.intercept({ path: '/rest/1.0/unrestrict/link', method: 'POST' })
    .reply(200, { download: 'https://cdn.rd.example/M2.mkv' });

  const started = Date.now();
  const url = await new RealDebridService('token-fast').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${'b'.repeat(40)}`);
  assert.equal(url, 'https://cdn.rd.example/M2.mkv');
  assert.ok(Date.now() - started < 2500, `levou ${Date.now() - started}ms`);
});

test('RD com magnet_error falha logo, sem esperar', async () => {
  newMagnet('M3');
  infoSequence('M3', [{ status: 'magnet_error' }]);

  const started = Date.now();
  await assert.rejects(
    new RealDebridService('token-err').processMagnetToDirectUrl(`magnet:?xt=urn:btih:${'c'.repeat(40)}`),
    /magnet_error/
  );
  assert.ok(Date.now() - started < 400, `levou ${Date.now() - started}ms`);
});

test('RD ainda baixando depois das consultas devolve o vídeo de espera', async () => {
  newMagnet('M4');
  infoSequence('M4', [{ status: 'waiting_files_selection', files }]);
  rd.intercept({ path: '/rest/1.0/torrents/selectFiles/M4', method: 'POST' }).reply(204, '');
  rd.intercept({ path: '/rest/1.0/torrents/info/M4', method: 'GET' })
    .reply(200, { id: 'M4', status: 'downloading', files })
    .times(5);

  captureInfo();
  const url = await new StreamController().processLinkForPlayback({
    magnet: `magnet:?xt=urn:btih:${'d'.repeat(40)}`,
    token: 'token-slow',
    provider: 'realdebrid',
  });
  assert.match(url, /\/placeholder\/downloading\.mp4$/);
  const line = infoLines.find((l) => l.includes('⏱️ Play (realdebrid)'));
  assert.ok(line, infoLines.join('\n'));
  // 6 infos: 1 na conversão, 1 depois do selectFiles e 4 depois de cada espera
  assert.match(
    line,
    /vídeo de espera em \d+ms: lista_conta=\d+ms, add=\d+ms, info=6x \d+ms, selecionar=\d+ms, espera=4x \d+ms/
  );
});

test('play do TorBox loga criar, mylist e requestdl; o segundo play loga o cache', async () => {
  const hash = 'e'.repeat(40);
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/mylist') && !p.includes('id='), method: 'GET' })
    .reply(200, { success: true, data: [] });
  torbox
    .intercept({ path: '/v1/api/torrents/createtorrent', method: 'POST' })
    .reply(200, { success: true, data: { torrent_id: 9, hash } });
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/mylist') && p.includes('id=9'), method: 'GET' })
    .reply(200, { success: true, data: { id: 9, download_present: true, files: [{ id: 0, name: 'Filme.mkv', size: 1 }] } });
  torbox
    .intercept({ path: (p) => p.startsWith('/v1/api/torrents/requestdl'), method: 'GET' })
    .reply(200, { success: true, data: 'https://cdn.example/9.mkv' });

  captureInfo();
  const controller = new StreamController();
  const params = { magnet: `magnet:?xt=urn:btih:${hash}`, token: 'token-tb-timing', provider: 'torbox' };
  assert.equal(await controller.processLinkForPlayback(params), 'https://cdn.example/9.mkv');
  assert.equal(await controller.processLinkForPlayback(params), 'https://cdn.example/9.mkv');

  const play = infoLines.find((l) => l.includes('⏱️ Play (torbox) pronto'));
  assert.ok(play, infoLines.join('\n'));
  assert.match(play, /lista_conta=\d+ms, criar=\d+ms, mylist=\d+ms, requestdl=\d+ms/);
  assert.ok(infoLines.some((l) => l.includes('⏱️ Play (torbox): link do cache')), infoLines.join('\n'));
});
