// TORRENT_INDEXER_DEBRID_MAX_WAIT_MS=0: o /stream não espera pelo debrid, mas usa
// o que já se sabe (o cache de disponibilidade do TorBox).
// Roda contra o build: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Lidos no import do módulo
process.env.TORRENT_INDEXER_REQUEST_BUDGET_MS = '3000';
process.env.TORRENT_INDEXER_DEBRID_MAX_WAIT_MS = '0';

const { StreamController } = await import('../dist/controllers/stream-controller.js');
const { SourceService } = await import('../dist/services/source-service.js');
const { TorboxService } = await import('../dist/services/torbox-service.js');

const KNOWN = '1'.repeat(40);
const SLOW = '2'.repeat(40);
const originals = {
  fetchStreams: SourceService.fetchStreamsFromAllSources,
  checkCached: TorboxService.checkCachedInfoHashes,
};
after(() => {
  SourceService.fetchStreamsFromAllSources = originals.fetchStreams;
  TorboxService.checkCachedInfoHashes = originals.checkCached;
});

test('com 0, responde na hora com o que o TorBox já respondeu', async () => {
  SourceService.fetchStreamsFromAllSources = async () =>
    [KNOWN, SLOW].map((hash) => ({ title: `${hash}.1080p.mkv`, magnet: `magnet:?xt=urn:btih:${hash}`, infoHash: hash, source: 'betor' }));
  TorboxService.checkCachedInfoHashes = (hashes, token, onAnswer) => {
    onAnswer?.(KNOWN, true);
    return new Promise(() => {});
  };

  const started = Date.now();
  const result = await new StreamController().handleStreamRequest({
    type: 'movie',
    id: 'tt0133100',
    extra: { debridProvider: 'torbox', torboxToken: 'tok-0123456789' },
  });

  assert.ok(Date.now() - started < 150, `levou ${Date.now() - started}ms`);
  const byHash = Object.fromEntries(result.streams.map((s) => [s.url.includes(KNOWN) ? 'known' : 'slow', s.behaviorHints.cached]));
  assert.deepEqual(byHash, { known: true, slow: false });
});
