// Metadados que o AIOStreams lê de um addon custom (P0 do RELATORIO-metadados-aiostreams).
// Roda contra o build: npm run test:aiostreams
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendFilenameTag,
  detectReleaseLanguages,
  filenameLanguageTag,
  languagesFromAudioValues,
  reconcileAudioWithRelease,
} from '../dist/services/audio-language.js';
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

test('A3: dn com carimbo de site perde o prefixo e fica só o nome do release', () => {
  const stream = mapTorrent({
    title: 'VisionQuest S01E03 04 1080p WEB-DL DUAL 5 1 (brazilian, eng)',
    magnet_link: magnet('BAIXARAPIDO.COM-.EPISODIO-03-E-04.WEB-DL.1080P.MKV.5.1.-DUBLADO-DUAL-AUDIO-.VisionQuest.S01E03-04.1080p.WEB-DL.DUAL.5.1'),
  }, episodeContext);
  assert.equal(stream.rawFileName, 'VisionQuest.S01E03-04.1080p.WEB-DL.DUAL.5.1');

  const bracketed = mapTorrent({
    title: 'O Agente Secreto 2025 1080p WEB-DL (brazilian)',
    magnet_link: magnet('[WWW.SITE.NET] O.Agente.Secreto.2025.1080p.WEB-DL'),
  });
  assert.equal(bracketed.rawFileName, 'O.Agente.Secreto.2025.1080p.WEB-DL');
});

test('A3: dn com carimbo de site sem o título dentro cai para o título', () => {
  const stream = mapTorrent({
    title: 'Movie 2020 1080p WEB-DL (brazilian)',
    magnet_link: magnet('COMANDOTORRENTS.COM-.FILME.1080P.DUBLADO'),
  });
  assert.equal(stream.rawFileName, 'Movie 2020 1080p WEB-DL');
});

test('A3: dn sem carimbo de site não muda, mesmo com grupo no fim', () => {
  const dn = 'VisionQuest.S01E03-04.WEB-DL.1080p.x264.DUAL.5.1-STARCKFILMES';
  const stream = mapTorrent({ title: 'VisionQuest S01E03 04 WEB-DL 1080p x264 DUAL 5 1 STARCKFILMES (brazilian, eng)', magnet_link: magnet(dn) }, episodeContext);
  assert.equal(stream.rawFileName, dn);
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

test('A2: audio[] é conferido com o nome do release', () => {
  // Legendado ou outro idioma sem marca PT: Português sai.
  assert.deepEqual(reconcileAudioWithRelease(['Portuguese'], 'Duna Parte 2 2024 1080p LEGENDADO (brazilian)'), ['English']);
  assert.deepEqual(reconcileAudioWithRelease(['Portuguese', 'English'], 'Movie.2020.1080p.WEB-DL.ENG.x264'), ['English']);
  assert.deepEqual(reconcileAudioWithRelease(['Portuguese'], 'Movie.2020.1080p.ITA.ENG'), ['English', 'Italian']);
  // Marca PT no nome mantém o audio[]; o sufixo "(brazilian)" do torrent-indexer não conta como marca.
  assert.deepEqual(reconcileAudioWithRelease(['Portuguese', 'English'], 'Movie 2020 1080p DUAL 5.1 Legendado'), ['Portuguese', 'English']);
  assert.deepEqual(reconcileAudioWithRelease(['Portuguese'], 'Movie 2020 1080p WEB-DL'), ['Portuguese']);
  // NACIONAL fica só com Português.
  assert.deepEqual(reconcileAudioWithRelease(['Portuguese', 'English'], 'Tropa de Elite 2007 Nacional 1080p'), ['Portuguese']);
});

test('A2: release legendado com audio[] Português sai sem Português', () => {
  const stream = mapTorrent({
    title: 'Duna Parte 2 2024 1080p WEB-DL Legendado (brazilian)',
    audio: ['Português'],
    magnet_link: magnet('Duna Parte 2 2024 1080p WEB-DL Legendado'),
  });
  assert.deepEqual(stream.languages, ['English']);
});

test('tamanho com vírgula decimal ("1,5 GB")', () => {
  const stream = mapTorrent({ ...tropaDeElite, size: '1,5 GB' });
  assert.equal(stream.size, Math.round(1.5 * GB));
  assert.equal(mapTorrent({ ...tropaDeElite, size: '711 MB' }).size, 711 * 1024 ** 2);
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

test('B1: infoHash vai também no link de resolve do debrid', () => {
  const meta = StreamService.createStreamMetadata({ ...packFile, fileIdx: 1 }, 'https://guindex.example/resolve/abc', {
    debridProvider: 'realdebrid',
    viaDebrid: true,
  });
  assert.equal(meta.infoHash, HASH);
  assert.equal(meta.fileIdx, 1);
});

test('B3: sem token o nome não leva [RD] nem [TB]', () => {
  const rd = StreamService.createStreamMetadata(packFile, packFile.magnet, {
    debridProvider: 'realdebrid',
    viaDebrid: false,
  });
  assert.ok(!rd.name.includes('[RD'), rd.name);
  assert.ok(rd.name.startsWith('GuIndex'), rd.name);

  const tb = StreamService.createStreamMetadata(packFile, packFile.magnet, {
    debridProvider: 'torbox',
    viaDebrid: false,
  });
  assert.ok(!tb.name.includes('[TB'), tb.name);

  const withToken = StreamService.createStreamMetadata(packFile, 'https://guindex.example/resolve/abc', {
    debridProvider: 'realdebrid',
    realDebridReady: true,
    viaDebrid: true,
  });
  assert.ok(withToken.name.startsWith('[RD+] GuIndex'), withToken.name);
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

test('fluxo: Tropa de Elite sai só com 🇧🇷 e filename = dn + PT-BR', () => {
  const source = mapTorrent(tropaDeElite);
  const meta = StreamService.createStreamMetadata(source, 'https://guindex.example/resolve/abc', {
    debridProvider: 'realdebrid',
    realDebridReady: true,
    viaDebrid: true,
  });

  assert.deepEqual(meta.languages, ['Portuguese']);
  assert.match(meta.name, /🇧🇷/);
  assert.doesNotMatch(meta.name, /🇩🇪|🇯🇵|🇬🇧|🇺🇸/);
  // NACIONAL o AIOStreams não reconhece; PT-BR ele lê como Portuguese (Brazil).
  assert.equal(meta.behaviorHints.filename, 'Tropa de Elite 2007 1080p BluRay x264 Nacional BluDV PT-BR');
  assert.equal(meta.behaviorHints.seeders, 15);
  // behaviorHints.indexer leva o nome legível; o slug fica no topo.
  assert.equal(meta.behaviorHints.indexer, 'Torrent dos Filmes');
  assert.equal(meta.indexer, 'torrent_dos_filmes');
  assert.equal(meta.behaviorHints.publishDate, '2016-06-29T22:44:46.000Z');
  assert.equal(meta.behaviorHints.folderName, undefined);
});

test('B2: pack sem files[] não ganha fileIdx chutado', () => {
  const pack = {
    title: 'Show S01 1080p WEB-DL Dual Audio',
    magnet_link: magnet('Show S01 1080p WEB-DL Dual Audio'),
    size: '8 GB',
    files: [],
    seed_count: 10,
  };
  const stream = mapTorrent(pack, episodeContext);
  assert.equal(stream.fileIdx, undefined);
  assert.equal(stream.infoHash, HASH);
});

// --- Melhorias do formatter (relatório "formatter do AIOStreams") -------------

const resolveUrl = 'https://guindex.example/resolve/abc';
const rdOptions = { debridProvider: 'realdebrid', realDebridReady: true, viaDebrid: true };

const dunaLegendado = {
  title: 'Duna Parte Dois 2024 2160p WEB-DL HDR10 x265 Legendado (eng)',
  original_title: 'Dune: Part Two',
  details: 'https://torrentfilmeshds.example/duna-2',
  audio: ['Inglês'],
  magnet_link: magnet('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.HDR10.x265-FLUX'),
  size: '22.4 GB',
  files: [],
  seed_count: 300,
  indexer: 'torrentfilmeshds',
};

test('item 1: legendado em inglês sem PT no nome ganha ENG Subs no filename, sem bandeira BR', () => {
  const meta = StreamService.createStreamMetadata(mapTorrent(dunaLegendado), resolveUrl, rdOptions);
  assert.equal(meta.behaviorHints.filename, 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.HDR10.x265-FLUX.ENG.Subs');
  assert.deepEqual(meta.languages, ['English']);
});

test('item 1: LEGENDADO só na página também marca legenda; scene em inglês sem marca ganha ENG', () => {
  assert.equal(filenameLanguageTag('Movie.2020.1080p.WEB-DL', ['English'], ['Movie (2020) Legendado']), 'ENG Subs');
  assert.equal(filenameLanguageTag('Movie.2020.1080p.WEB-DL', ['English'], ['Movie (2020)']), 'ENG');
  assert.equal(filenameLanguageTag('Movie.2020.2160p.WEB-DL', [], ['Movie (2020)']), undefined);
  assert.equal(filenameLanguageTag('Movie.2020.1080p.ENG.WEB-DL', ['English'], ['Legendado']), 'Subs');
  assert.equal(filenameLanguageTag('Movie.2020.1080p.MULTI', ['English'], []), undefined);
  assert.equal(filenameLanguageTag('Movie.2020.1080p.PT-BR.Subs', ['English'], ['Legendado']), 'ENG');
  assert.equal(filenameLanguageTag('Movie.2020.1080p.Subs.PT-BR', ['English'], ['Legendado']), 'ENG');
  assert.equal(filenameLanguageTag('Movie.2020.1080p.Subbed', ['English'], ['Legendado']), 'ENG');
});

test('item 5: português sem marca que o AIOStreams entenda ganha PT-BR', () => {
  assert.equal(filenameLanguageTag('Cidade de Deus 2002 1080p Nacional', ['Portuguese']), 'PT-BR');
  assert.equal(filenameLanguageTag('Movie.2020.1080p.WEB-DL', ['Portuguese', 'English']), 'PT-BR');
  assert.equal(filenameLanguageTag('Movie.2020.1080p.DUAL.5.1', ['Portuguese', 'English']), undefined);
  assert.equal(filenameLanguageTag('Movie 2020 1080p Dublado', ['Portuguese']), undefined);
  assert.equal(filenameLanguageTag('Movie.2020.1080p.PT-BR', ['Portuguese']), undefined);
});

test('marca entra antes da extensão, no separador do nome', () => {
  assert.equal(appendFilenameTag('Show.S01E02.1080p.mkv', 'PT-BR'), 'Show.S01E02.1080p.PT-BR.mkv');
  assert.equal(appendFilenameTag('Tropa de Elite 2007 1080p', 'PT-BR'), 'Tropa de Elite 2007 1080p PT-BR');
  assert.equal(appendFilenameTag('Movie.2020.1080p', undefined), 'Movie.2020.1080p');
  // LEGENDADO no nome vira Subs: o AIOStreams o leria como áudio em português.
  assert.equal(appendFilenameTag('Duna Parte 2 2024 1080p WEB-DL Legendado', 'Subs'), 'Duna Parte 2 2024 1080p WEB-DL Subs');
  assert.equal(appendFilenameTag('Duna.Parte.2.2024.LEGENDADO.1080p.mkv', 'Subs'), 'Duna.Parte.2.2024.Subs.1080p.mkv');
  assert.equal(appendFilenameTag('Duna.Parte.2.2024.LEGENDADO.1080p.mkv', 'ENG Subs'), 'Duna.Parte.2.2024.ENG.Subs.1080p.mkv');
  assert.equal(appendFilenameTag('Movie.2025.2160p.WEB-DL.mkv', 'ENG'), 'Movie.2025.2160p.WEB-DL.ENG.mkv');
});

test('item 1/5: a marca não muda rawFileName nem o nome de exibição', () => {
  const stream = mapTorrent(dunaLegendado);
  assert.equal(stream.rawFileName, 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.HDR10.x265-FLUX');
  assert.equal(stream.filenameLanguageTag, 'ENG Subs');
});

test('item 2: runtime do Cinemeta vira behaviorHints.duration em segundos', () => {
  const parser = provider.parser;
  assert.equal(parser.extractRuntimeSeconds({ runtime: '152 min' }), 152 * 60);
  assert.equal(parser.extractRuntimeSeconds({ runtime: '2h 32min' }), 152 * 60);
  assert.equal(parser.extractRuntimeSeconds({ runtime: '1h' }), 3600);
  assert.equal(parser.extractRuntimeSeconds({ runtime: 'N/A' }), undefined);
  assert.equal(parser.extractRuntimeSeconds({}), undefined);

  const movie = mapTorrent(tropaDeElite, { ...movieContext, runtimeSeconds: 115 * 60 });
  assert.equal(movie.durationSeconds, 115 * 60);
  const meta = StreamService.createStreamMetadata(movie, resolveUrl, rdOptions);
  assert.equal(meta.behaviorHints.duration, 115 * 60);
});

test('item 2: pack sem files[] não recebe a duração de um episódio', () => {
  const context = { ...episodeContext, runtimeSeconds: 60 * 60 };
  const pack = {
    title: 'Show S01 1080p WEB-DL Dual Audio',
    magnet_link: magnet('Show S01 1080p WEB-DL Dual Audio'),
    size: '8 GB',
    files: [],
    seed_count: 10,
  };
  assert.equal(mapTorrent(pack, context).durationSeconds, undefined);

  const withFiles = {
    ...pack,
    files: [1, 2, 3].map((n) => ({ path: `Show S01/Show.S01E0${n}.1080p.mkv`, size: '2 GB', size_bytes: 2 * GB })),
  };
  assert.equal(mapTorrent(withFiles, context).durationSeconds, 60 * 60);
});

test('item 4: indexer conhecido sai com nome legível, desconhecido cai para o site', () => {
  assert.equal(mapTorrent({ ...tropaDeElite, indexer: 'bludv_ru' }).indexerLabel, 'BluDV');
  assert.equal(mapTorrent({ ...tropaDeElite, indexer: 'comando_torrents' }).indexerLabel, 'Comando');
  const unknown = mapTorrent({ ...tropaDeElite, indexer: 'novo_site', details: 'https://bludv.xyz/x' });
  assert.equal(unknown.indexerLabel, 'BluDV');
  assert.equal(unknown.indexer, 'novo_site');
});

test('item 7: size_bytes dos files[] vence o tamanho formatado', () => {
  const files = provider.parser.extractFilesFromTorrent({
    files: [{ path: 'a.mkv', size: '1.23 GB', size_bytes: 1320702444 }, { path: 'b.mkv', size: '700 MB' }],
  });
  assert.equal(files[0].size, 1320702444);
  assert.equal(files[1].size, 700 * 1024 ** 2);
});
