// Teto opcional da espera pelo debrid (TORRENT_INDEXER_DEBRID_MAX_WAIT_MS): com
// ele, a resposta sai mais cedo que o fim do orçamento, sem o selo.
// Roda contra o build: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Lidos no import do módulo
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MAX_WAIT_MS = '150';

const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const HASH = 'f'.repeat(40);
const originals = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  checkCached: TorboxService.checkCachedInfoHashes,
};
after(() => {
  SourceService.fetchStreamsFromAllSources = originals.fetchStreams;
  TorboxService.checkCachedInfoHashes = originals.checkCached;
});

test('com o teto, o TorBox lento só segura a resposta até ele', async () => {
  SourceService.fetchStreamsFromAllSources = async () => [
    { title: 'The.Matrix.1999.1080p.mkv', magnet: `magnet:?xt=urn:btih:${HASH}`, infoHash: HASH, source: 'betor' },
  ];
  TorboxService.checkCachedInfoHashes = () => new Promise(() => {});

  const started = Date.now();
  const result = await new StreamController().handleStreamRequest({
    type: 'movie',
    id: 'tt0133099',
    extra: { debridProvider: 'torbox', torboxToken: 'tok-0123456789' },
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 140 && elapsed < 600, `levou ${elapsed}ms, o teto é 150ms`);
  assert.equal(result.streams[0].behaviorHints.cached, false);
  assert.equal(StreamController.cacheControlFor(result), 'no-store');
});
