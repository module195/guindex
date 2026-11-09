// G1: streams da "Minha TorBox" levam behaviorHints.videoHash (hash OpenSubtitles
// que o TorBox calcula por arquivo), para addons de legenda casarem pelo arquivo.
// Roda contra o build: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { setupRoutes } = await import('../dist/routes/routes.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');
const { openSubtitlesHash } = await import('../dist/services/torbox-library.js');

const TOKEN = 't'.repeat(36);
const original = TorboxService.accountTorrent;
afterEach(() => { TorboxService.accountTorrent = original; });

const ITEM = {
  id: 7,
  hash: 'D'.repeat(40),
  name: 'Lupin.S04.1080p.WEB-DL.DUAL',
  size: 4e9,
  download_finished: true,
  files: [
    { id: 0, short_name: 'Lupin.S04E01.1080p.mkv', size: 2e9, opensubtitles_hash: '8e245d9679d31e12' },
    { id: 1, short_name: 'Lupin.S04E02.1080p.mkv', size: 2e9 },
    { id: 2, short_name: 'Lupin.S04E03.1080p.mkv', size: 2e9, opensubtitles_hash: 'not-a-hash' },
  ],
};

async function streamsFor(id) {
  TorboxService.accountTorrent = async () => ITEM;
  const app = setupRoutes();
  try {
    return (await app.inject({ url: `/torbox/${TOKEN}/stream/other/${id}.json` })).json().streams;
  } finally {
    await app.close();
  }
}

test('arquivo com hash OpenSubtitles vira behaviorHints.videoHash', async () => {
  const [stream] = await streamsFor('gdxlib:7:0');
  assert.equal(stream.behaviorHints.videoHash, '8e245d9679d31e12');
});

test('arquivo sem hash não manda videoHash', async () => {
  const [stream] = await streamsFor('gdxlib:7:1');
  assert.ok(stream);
  assert.equal('videoHash' in stream.behaviorHints, false);
});

test('hash fora do formato (16 hex) é descartado', async () => {
  const [stream] = await streamsFor('gdxlib:7:2');
  assert.equal('videoHash' in stream.behaviorHints, false);
});

test('item inteiro, sem arquivo escolhido, não manda videoHash', async () => {
  const [stream] = await streamsFor('gdxlib:7');
  assert.ok(stream);
  assert.equal('videoHash' in stream.behaviorHints, false);
});

test('formato do hash: minúsculo, com zeros à esquerda, só hex', () => {
  assert.equal(openSubtitlesHash('8E245D9679D31E12'), '8e245d9679d31e12');
  assert.equal(openSubtitlesHash('45d9679d31e12'), '00045d9679d31e12');
  assert.equal(openSubtitlesHash(' 8e245d9679d31e12 '), '8e245d9679d31e12');
  assert.equal(openSubtitlesHash('8e245d9679d31e12ff'), undefined);
  assert.equal(openSubtitlesHash(''), undefined);
  assert.equal(openSubtitlesHash(undefined), undefined);
});
