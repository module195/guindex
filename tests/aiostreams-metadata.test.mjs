// Metadados que o AIOStreams lê de um addon custom (P0 do RELATORIO-metadados-aiostreams).
// Roda contra o build: npm run test:aiostreams
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectReleaseLanguages, languagesFromAudioValues } from '../dist/services/audio-language.js';
import { StreamService } from '../dist/services/stream-service.js';
import { TorrentIndexerProvider } from '../dist/services/torrent-indexer-provider.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const GB = 1024 ** 3;

const movieContext = { parsed: {}, type: 'movie', targetTitles: [] };
const episodeContext = { parsed: { season: 1, episode: 2 }, type: 'series', targetTitles: ['Show'] };

const provider = new TorrentIndexerProvider('torrent-indexer', 'http://localhost:7006');
const mapTorrent = (torrent, context = movieContext) => provider.mapTorrentToStream(torrent, 'fallback', context);

const magnet = (dn) => `magnet:?xt=urn:btih:${HASH}${dn ? `&dn=${encodeURIComponent(dn)}` : ''}&tr=udp%3A%2F%2Ftracker`;

// Formato do /indexers/* do torrent-indexer: título = dn + sufixo de áudio.
const tropaDeElite = {
  title: 'Tropa de Elite 2007 1080p BluRay x264 Nacional BluDV (brazilian)',
  original_title: 'Tropa de Elite',
  details: 'https://torrentdosfilmes.example/tropa-de-elite',
  audio: ['Português'],
  magnet_link: magnet('Tropa de Elite 2007 1080p BluRay x264 Nacional BluDV'),
  date: '2016-06-29T22:44:46Z',
  size: '4.29 GB',
  files: [],
  seed_count: 15,
  indexer: 'torrent-dos-filmes',
  // Texto que antes virava idioma: "de" (alemão), "en", "ja".
  description: 'Filme de ação. Elenco: Wagner Moura. Áudio original en, legendas ja disponíveis.',
  category: 'Filmes Nacionais',
};

// --- A2: idiomas ---------------------------------------------------------------

test('A2: audio[] do torrent-indexer vira nome canônico', () => {
  assert.deepEqual(languagesFromAudioValues(['Português']), ['Portuguese']);
  assert.deepEqual(languagesFromAudioValues(['Nacional']), ['Portuguese']);
  assert.deepEqual(languagesFromAudioValues(['PT-BR', 'Inglês']), ['Portuguese', 'English']);
  assert.deepEqual(languagesFromAudioValues(['Alemão', 'Japonês', 'Polaco']), ['German', 'Japanese', 'Polish']);
  assert.deepEqual(languagesFromAudioValues(['Klingon', '', null, 42]), []);
});

test('A2: códigos de 2 letras e palavras de título não viram idioma', () => {
  assert.deepEqual(detectReleaseLanguages('Tropa de Elite 2007 1080p BluRay'), []);
  assert.deepEqual(detectReleaseLanguages('Casamento Grego 2002 720p'), []);
  assert.deepEqual(detectReleaseLanguages('Movie 2020 DE EN IT JA 1080p'), []);
  assert.deepEqual(detectReleaseLanguages('Já Era 2023 1080p Dublado'), ['Portuguese']);
});

test('A2: marcadores fortes no nome do release', () => {
  assert.deepEqual(detectReleaseLanguages('Cidade de Deus 2002 Nacional 1080p'), ['Portuguese']);
  assert.deepEqual(detectReleaseLanguages('Movie.2020.1080p.PT-BR'), ['Portuguese']);
  assert.deepEqual(detectReleaseLanguages('Movie.2020.ENG.ITA.1080p'), ['English', 'Italian']);
  assert.deepEqual(detectReleaseLanguages('Movie 2020 Dual Áudio 1080p').sort(), ['English', 'Portuguese']);
});

test('A2: audio[] vence o texto; sinopse e categoria são ignoradas', () => {
  const stream = mapTorrent(tropaDeElite);
  assert.deepEqual(stream.languages, ['Portuguese']);
});

test('A2: sem audio[], só o nome do release conta', () => {
  const stream = mapTorrent({
    title: 'Já Era 2023 1080p WEB-DL Dublado',
    magnet_link: magnet('Ja Era 2023 1080p WEB-DL Dublado'),
    description: 'Japanese english german french',
    slug: 'ja-era-italian',
  });
  assert.deepEqual(stream.languages, ['Portuguese']);
});

test('A2: título da página (original_title) não rotula releases scene', () => {
  const stream = mapTorrent({
    title: 'Star.Wars.The.Bad.Batch.S02E10.Retrieval.1080p.DSNP.WEBRip.DDP5.1.x264-NTb [TGx]',
    original_title: 'Star Wars: The Bad Batch 2ª Temporada Torrent (2023) WEB-DL 720p/1080p/4K Dual Áudio',
    audio: [],
    magnet_link: magnet('Star.Wars.The.Bad.Batch.S02E10.Retrieval.1080p.DSNP.WEBRip.DDP5.1.x264-NTb [TGx]'),
  });
  assert.equal(stream.languages, undefined);
});

test('A2: release sem idioma não ganha idioma', () => {
  const stream = mapTorrent({ title: 'Tropa de Elite 2007 1080p', magnet_link: magnet('Tropa de Elite 2007 1080p') });
  assert.equal(stream.languages, undefined);
});

// --- A3: filename cru ----------------------------------------------------------

test('A3: sem files[], filename cru é o dn do magnet', () => {
  const stream = mapTorrent(tropaDeElite);
  assert.equal(stream.rawFileName, 'Tropa de Elite 2007 1080p BluRay x264 Nacional BluDV');
  assert.equal(stream.folderName, undefined);
  assert.equal(stream.folderSize, undefined);
});

test('A3: sem dn, usa o título sem o sufixo de áudio do torrent-indexer', () => {
  const stream = mapTorrent({
    title: 'Movie 2020 1080p WEB-DL (brazilian, eng)',
    magnet_link: magnet(),
  });
  assert.equal(stream.rawFileName, 'Movie 2020 1080p WEB-DL');

  const doubled = mapTorrent({ title: 'Listão de Filmes Dublado BDRip (brazilian) (brazilian)', magnet_link: magnet() });
  assert.equal(doubled.rawFileName, 'Listão de Filmes Dublado BDRip');

  const kept = mapTorrent({ title: 'Movie (2020) 1080p (Dublado)', magnet_link: magnet() });
  assert.equal(kept.rawFileName, 'Movie (2020) 1080p (Dublado)');
});

test('A3: arquivo dentro de pack usa o basename com extensão; o torrent vira pasta', () => {
  const stream = mapTorrent(
    {
      title: 'Show S01 1080p WEB-DL Dual Áudio (brazilian, eng)',
      magnet_link: magnet('Show S01 1080p WEB-DL Dual Audio'),
      size: '8 GB',
      files: [
        { path: 'Show S01/Show.S01E01.1080p.WEB-DL.mkv', size: 1 * GB },
        { path: 'Show S01/Show.S01E02.1080p.WEB-DL.mkv', size: 1 * GB },
      ],
    },
    episodeContext,
  );
  assert.equal(stream.fileIdx, 1);
  assert.equal(stream.rawFileName, 'Show.S01E02.1080p.WEB-DL.mkv');
  assert.equal(stream.folderName, 'Show S01 1080p WEB-DL Dual Audio');
  assert.equal(stream.folderSize, 8 * GB);
});

// --- A1: data de publicação ----------------------------------------------------

test('A1: date vira publishDate ISO; data zero do Go é ignorada', () => {
  assert.equal(mapTorrent(tropaDeElite).publishDate, '2016-06-29T22:44:46.000Z');
  assert.equal(mapTorrent({ ...tropaDeElite, date: '0001-01-01T00:00:00Z' }).publishDate, undefined);
  assert.equal(mapTorrent({ ...tropaDeElite, date: 'ontem' }).publishDate, undefined);
});

// --- A1 + A3: behaviorHints ----------------------------------------------------

const packFile = {
  title: 'Show S01E02 1080p WEB-DL',
  fileName: 'Show S01 1080p/Show.S01E02.1080p.WEB-DL.mkv',
  rawFileName: 'Show.S01E02.1080p.WEB-DL.mkv',
  folderName: 'Show S01 1080p WEB-DL Dual Audio',
  folderSize: 8 * GB,
  publishDate: '2024-03-01T12:00:00.000Z',
  languages: ['Portuguese', 'English'],
  indexer: 'comando',
  magnet: magnet('Show S01 1080p WEB-DL Dual Audio'),
  size: 1 * GB,
  seeders: 42,
  quality: '1080p',
};

test('A1: behaviorHints leva seeders, indexer, publishDate, pasta, service e cached', () => {
  const meta = StreamService.createStreamMetadata(packFile, 'https://guindex.example/resolve/abc', {
    debridProvider: 'realdebrid',
    realDebridReady: true,
    viaDebrid: true,
  });
  const hints = meta.behaviorHints;
  assert.equal(hints.seeders, 42);
  assert.equal(hints.indexer, 'comando');
  assert.equal(hints.publishDate, '2024-03-01T12:00:00.000Z');
  assert.equal(hints.folderName, 'Show S01 1080p WEB-DL Dual Audio');
  assert.equal(hints.folderSize, 8 * GB);
  assert.equal(hints.videoSize, 1 * GB);
  assert.equal(hints.service, 'realdebrid');
  assert.equal(hints.cached, true);
});

test('A1: TorBox não pronto anuncia service torbox e cached false', () => {
  const meta = StreamService.createStreamMetadata(packFile, 'https://guindex.example/resolve/abc', {
    debridProvider: 'torbox',
    torboxReady: false,
    viaDebrid: true,
  });
  assert.equal(meta.behaviorHints.service, 'torbox');
  assert.equal(meta.behaviorHints.cached, false);
});

test('A1: stream P2P (magnet, sem token) não anuncia serviço de debrid', () => {
  const meta = StreamService.createStreamMetadata(packFile, packFile.magnet, {
    debridProvider: 'realdebrid',
    viaDebrid: false,
  });
  assert.equal(meta.behaviorHints.service, undefined);
  assert.equal(meta.behaviorHints.cached, undefined);
  assert.equal(meta.behaviorHints.seeders, 42);

  // Sem a opção, magnet também conta como P2P.
  const implicit = StreamService.createStreamMetadata(packFile, packFile.magnet);
  assert.equal(implicit.behaviorHints.service, undefined);
});

test('A3: behaviorHints.filename é o nome cru, sem idioma, tamanho ou indexador', () => {
  const meta = StreamService.createStreamMetadata(packFile, 'https://guindex.example/resolve/abc', { viaDebrid: true });
  assert.equal(meta.behaviorHints.filename, 'Show.S01E02.1080p.WEB-DL.mkv');
  assert.equal(meta.filename, 'Show.S01E02.1080p.WEB-DL.mkv');
});

test('A3: sem rawFileName, usa o basename do fileName de exibição', () => {
  const { rawFileName, ...withoutRaw } = packFile;
  const meta = StreamService.createStreamMetadata(withoutRaw, 'https://guindex.example/resolve/abc', { viaDebrid: true });
  assert.equal(meta.behaviorHints.filename, 'Show.S01E02.1080p.WEB-DL.mkv');
});

// --- Fluxo provider → service ---------------------------------------------------

test('fluxo: Tropa de Elite sai só com 🇧🇷 e filename = dn', () => {
  const source = mapTorrent(tropaDeElite);
  const meta = StreamService.createStreamMetadata(source, 'https://guindex.example/resolve/abc', {
    debridProvider: 'realdebrid',
    realDebridReady: true,
    viaDebrid: true,
  });

  assert.deepEqual(meta.languages, ['Portuguese']);
  assert.match(meta.name, /🇧🇷/);
  assert.doesNotMatch(meta.name, /🇩🇪|🇯🇵|🇬🇧|🇺🇸/);
  assert.equal(meta.behaviorHints.filename, 'Tropa de Elite 2007 1080p BluRay x264 Nacional BluDV');
  assert.equal(meta.behaviorHints.seeders, 15);
  // normalizeIndexerSlug do provider troca '-' por '_'.
  assert.equal(meta.behaviorHints.indexer, 'torrent_dos_filmes');
  assert.equal(meta.behaviorHints.publishDate, '2016-06-29T22:44:46.000Z');
  assert.equal(meta.behaviorHints.folderName, undefined);
});
