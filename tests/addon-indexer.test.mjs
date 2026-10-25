// Stream de addon extra (ex.: Mico-Leão) sem fonte no texto: o indexer enviado ao
// AIOStreams é o nome do addon, nunca o domínio do próprio GuIndex. Roda contra o build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const { StremioAddonProvider } = await import('../dist/services/stremio-addon-provider.js');
const { StreamService } = await import('../dist/services/stream-service.js');

const HASH = '0123456789abcdef0123456789abcdef01234567';
const RESOLVE_URL = 'https://guindex.example.com/torbox/TOKEN/resolve?magnet=x';

test('addon sem fonte usa o nome do addon como indexer', async () => {
  mockAgent
    .get('https://addon.example.com')
    .intercept({ path: '/stream/movie/tt0137523.json' })
    .reply(200, { streams: [{ name: 'Dublado\n1080p', title: 'Clube da Luta 1080p', infoHash: HASH }] });

  const provider = new StremioAddonProvider('Mico-Leão Dublado', 'https://addon.example.com');
  const [stream] = await provider.getStreams('movie', 'tt0137523');
  assert.equal(stream.source, 'Mico-Leão Dublado');

  const meta = StreamService.createStreamMetadata(stream, RESOLVE_URL, { debridProvider: 'torbox', viaDebrid: true });
  assert.equal(meta.behaviorHints.indexer, 'Mico-Leão Dublado');
});

test('stream sem indexer nem fonte não herda o host do link de resolve', () => {
  const meta = StreamService.createStreamMetadata(
    { title: 'Sem fonte', infoHash: HASH, magnet: `magnet:?xt=urn:btih:${HASH}` },
    RESOLVE_URL,
    { debridProvider: 'torbox', viaDebrid: true }
  );
  assert.notEqual(meta.behaviorHints?.indexer, 'guindex.example.com');
  assert.equal(meta.behaviorHints?.indexer, undefined);
});
