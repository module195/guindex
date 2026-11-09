/**
 * Catálogo "Minha TorBox": os torrents já baixados na conta TorBox, navegáveis
 * no Stremio como o catálogo do addon Library do AIOStreams
 * (packages/core/src/builtins/library/catalog.ts e meta.ts).
 *
 * IDs: `gdxlib:<torrentId>` (item), `gdxlib:<torrentId>:<fileId>` (arquivo) e
 * `gdxlib:action:refresh` (ação que esquece a lista da conta).
 */

import type { TorboxTorrent } from './torbox-client.js';
import { TorboxService } from './torbox-service.js';
import { TorrentParser } from './torrent-parser.js';
import { isVideoFile } from './file-selection.js';
import { parseBoolean, parseNonNegativeInt, readEnv } from './torrent-indexer-shared.js';

export const LIBRARY_ID_PREFIX = 'gdxlib:';
export const LIBRARY_CATALOG_ID = 'guindex.torbox.library';
export const LIBRARY_TYPE = 'other';
export const LIBRARY_PAGE_SIZE = 100;
const REFRESH_ID = `${LIBRARY_ID_PREFIX}action:refresh`;
/** Busca maior que isso é cortada (a busca é em memória, mas não precisa de mais) */
const MAX_SEARCH_LENGTH = 100;
const SEARCH_THRESHOLD = 60;

/** Biblioteca TorBox no /stream (itens da conta casados com o título). */
export const LIBRARY_ENABLED = parseBoolean(readEnv('GUINDEX_TORBOX_LIBRARY'), true);
/** Espera máxima pela lista da conta depois da busca (o /stream do cache não espera: relê em segundo plano) */
export const LIBRARY_WAIT_MS = parseNonNegativeInt(readEnv('GUINDEX_TORBOX_LIBRARY_WAIT_MS'), 750);

/** Catálogo da conta TorBox no manifest (com token TorBox). */
export const LIBRARY_CATALOG_ENABLED = parseBoolean(readEnv('GUINDEX_TORBOX_LIBRARY_CATALOG'), true);

/**
 * Indexer dos streams que vêm da conta TorBox (behaviorHints.indexer), como o
 * addon Library do AIOStreams: no formatter, {stream.indexer} sai "Library TB".
 */
export const LIBRARY_INDEXER_LABEL = readEnv('GUINDEX_TORBOX_LIBRARY_INDEXER')?.trim() || 'Library TB';

export enum LibraryGenre {
  ADDED_DESC = 'Adicionados ↓',
  ADDED_ASC = 'Adicionados ↑',
  TITLE_ASC = 'Título A-Z',
  TITLE_DESC = 'Título Z-A',
  ACTIONS = 'Ações',
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  description?: string;
  posterShape?: 'landscape' | 'poster' | 'square';
  releaseInfo?: string;
}

export interface MetaVideo {
  id: string;
  title: string;
  season?: number;
  episode?: number;
  released?: string;
}

export interface LibraryMeta extends MetaPreview {
  videos: MetaVideo[];
  behaviorHints?: { defaultVideoId?: string };
}

export interface LibraryExtras {
  skip: number;
  search?: string;
  genre?: string;
}

export interface LibraryFileRef {
  torrentId: number;
  fileId?: number;
}

const parser = new TorrentParser();

export function libraryCatalogManifestEntry() {
  return {
    type: LIBRARY_TYPE,
    id: LIBRARY_CATALOG_ID,
    name: 'Minha TorBox',
    extra: [
      { name: 'skip' },
      { name: 'search' },
      { name: 'genre', options: Object.values(LibraryGenre), isRequired: false },
    ],
  };
}

/** Extras do caminho do catálogo do Stremio ("skip=100&search=duna&genre=..."). */
export function parseLibraryExtras(extra?: string): LibraryExtras {
  const result: LibraryExtras = { skip: 0 };
  if (!extra) return result;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(extra);
  } catch {
    return result;
  }
  const skip = Number.parseInt(params.get('skip') ?? '', 10);
  if (Number.isFinite(skip) && skip > 0) result.skip = skip;
  const search = params.get('search')?.trim();
  if (search) result.search = search.slice(0, MAX_SEARCH_LENGTH);
  const genre = params.get('genre')?.trim();
  if (genre) result.genre = genre;
  return result;
}

/** `gdxlib:<torrentId>[:<fileId>]`; `undefined` para id fora do formato. */
export function parseLibraryId(id: string): LibraryFileRef | 'refresh' | undefined {
  if (!id.startsWith(LIBRARY_ID_PREFIX)) return undefined;
  if (id === REFRESH_ID) return 'refresh';
  const match = /^(\d{1,12})(?::(\d{1,9}))?$/.exec(id.slice(LIBRARY_ID_PREFIX.length));
  if (!match) return undefined;
  return {
    torrentId: Number(match[1]),
    fileId: match[2] !== undefined ? Number(match[2]) : undefined,
  };
}

/** Minúsculas, sem acento, só letras e números separados por espaço. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Título "limpo" do release: o nome até o ano, a temporada ou a qualidade. */
export function releaseTitle(name: string): string {
  const words = normalizeText(name).split(' ');
  const stop = words.findIndex(
    (word, index) =>
      index > 0 &&
      (/^(19|20)\d{2}$/.test(word) ||
        /^s\d{1,2}(e\d{1,3})?$/.test(word) ||
        /^\d{1,2}x\d{1,3}$/.test(word) ||
        /^(temporada|season|2160p|1080p|720p|480p|4k|web|webrip|bluray|hdtv)$/.test(word)),
  );
  return (stop > 0 ? words.slice(0, stop) : words).join(' ');
}

/**
 * Pontuação da busca, na linha do Library: título igual (110), começa numa
 * palavra do título (100), no nome inteiro do release (95), dentro do título
 * (80), todas as palavras da busca começam palavras do nome (70). Sem regex
 * montada a partir da busca.
 */
export function scoreSearch(name: string, query: string): number {
  const q = normalizeText(query);
  if (!q) return 0;
  const title = releaseTitle(name);
  const full = normalizeText(name);
  if (title === q) return 110;
  if (` ${title}`.includes(` ${q}`)) return 100;
  if (` ${full}`.includes(` ${q}`)) return 95;
  if (title.includes(q) || full.includes(q)) return 80;
  const nameWords = full.split(' ');
  const queryWords = q.split(' ');
  if (queryWords.every((word) => nameWords.some((nameWord) => nameWord.startsWith(word)))) return 70;
  return 0;
}

function addedAt(item: TorboxTorrent): number {
  const time = item.created_at ? Date.parse(item.created_at) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function sortItems(items: TorboxTorrent[], genre?: string): TorboxTorrent[] {
  const sorted = [...items];
  if (genre === LibraryGenre.TITLE_ASC || genre === LibraryGenre.TITLE_DESC) {
    sorted.sort((a, b) => releaseTitle(a.name ?? '').localeCompare(releaseTitle(b.name ?? '')));
    if (genre === LibraryGenre.TITLE_DESC) sorted.reverse();
    return sorted;
  }
  sorted.sort((a, b) => addedAt(b) - addedAt(a) || b.id - a.id);
  if (genre === LibraryGenre.ADDED_ASC) sorted.reverse();
  return sorted;
}

function formatDate(time: number): string | undefined {
  if (!time) return undefined;
  return new Date(time).toISOString().slice(0, 10).split('-').reverse().join('/');
}

function toPreview(item: TorboxTorrent): MetaPreview {
  const name = item.name ?? `Torrent ${item.id}`;
  const parts: string[] = [];
  if (item.size) parts.push(`📦 ${parser.formatSize(item.size)}`);
  const date = formatDate(addedAt(item));
  if (date) parts.push(`📅 ${date}`);
  const quality = parser.inferQualityFromTitle(name);
  if (quality) parts.push(`🖥️ ${quality}`);
  return {
    id: `${LIBRARY_ID_PREFIX}${item.id}`,
    type: LIBRARY_TYPE,
    name,
    description: parts.join(' • '),
    posterShape: 'landscape',
  };
}

function refreshPreview(): MetaPreview {
  return {
    id: REFRESH_ID,
    type: LIBRARY_TYPE,
    name: '🔄 Atualizar biblioteca',
    description: 'Abra para recarregar a lista da sua TorBox agora (ela fica 2 minutos em cache).',
    posterShape: 'landscape',
  };
}

/** Página do catálogo "Minha TorBox". */
export async function fetchLibraryCatalog(token: string, extras: LibraryExtras): Promise<MetaPreview[]> {
  if (extras.genre === LibraryGenre.ACTIONS) {
    return extras.skip > 0 ? [] : [refreshPreview()];
  }
  const items = await TorboxService.accountLibrary(token);
  let ordered: TorboxTorrent[];
  if (extras.search) {
    const query = extras.search;
    ordered = items
      .map((item) => ({ item, score: scoreSearch(item.name ?? '', query) }))
      .filter((entry) => entry.score >= SEARCH_THRESHOLD)
      .sort((a, b) => b.score - a.score || addedAt(b.item) - addedAt(a.item))
      .map((entry) => entry.item);
  } else {
    ordered = sortItems(items, extras.genre);
  }
  return ordered.slice(extras.skip, extras.skip + LIBRARY_PAGE_SIZE).map(toPreview);
}

/** Meta de um item: um vídeo por arquivo de vídeo, com temporada/episódio do nome. */
export function buildLibraryMeta(item: TorboxTorrent): LibraryMeta {
  const preview = toPreview(item);
  const released = item.created_at && Number.isFinite(Date.parse(item.created_at))
    ? new Date(Date.parse(item.created_at)).toISOString()
    : undefined;
  const videoFiles = (item.files ?? []).filter(
    (file) => typeof file.id === 'number' && (file.size ?? 0) > 0 && isVideoFile(file.name ?? file.short_name ?? ''),
  );

  const videos: MetaVideo[] = videoFiles.length === 0
    ? [{ id: preview.id, title: preview.name, released }]
    : videoFiles.map((file) => {
        const path = file.name ?? file.short_name ?? '';
        const title = file.short_name ?? path.replace(/^.*[\\/]/, '');
        const season = parser.extractSeasonFromTorrent({ title: path });
        const episode = parser.extractEpisodeFromTorrent({ title: path });
        const video: MetaVideo = { id: `${preview.id}:${file.id}`, title, released };
        if (episode !== undefined) {
          video.season = season ?? 1;
          video.episode = episode;
        }
        return video;
      });

  if (videos.length > 1) {
    videos.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title));
  }

  const parts = [preview.description, `📁 ${videoFiles.length || 1} arquivo(s) de vídeo`].filter(Boolean);
  return {
    ...preview,
    description: parts.join(' • '),
    videos,
    behaviorHints: { defaultVideoId: videos.length === 1 ? videos[0]?.id : undefined },
  };
}

export async function fetchLibraryMeta(token: string, id: string): Promise<LibraryMeta | undefined> {
  const ref = parseLibraryId(id);
  if (!ref) return undefined;
  if (ref === 'refresh') {
    TorboxService.forgetAccount(token);
    return {
      ...refreshPreview(),
      name: '✅ Biblioteca atualizada',
      description: 'A lista da sua TorBox foi recarregada. Volte ao catálogo para ver os itens novos.',
      videos: [],
    };
  }
  const item = await TorboxService.accountTorrent(token, ref.torrentId);
  if (!item || item.id !== ref.torrentId) return undefined;
  return buildLibraryMeta(item);
}

export interface LibraryStream {
  name: string;
  title: string;
  url: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints: {
    bingeGroup: string;
    indexer: string;
    filename?: string;
    videoSize?: number;
    folderSize?: number;
    notWebReady?: boolean;
    /** Hash OpenSubtitles do arquivo; o Stremio repassa aos addons de legenda */
    videoHash?: string;
  };
}

/**
 * Hash OpenSubtitles: 64 bits em hex, 16 dígitos. Aceita sem zeros à esquerda
 * e completa; outro formato é descartado.
 */
export function openSubtitlesHash(value: string | undefined): string | undefined {
  const hash = value?.trim().toLowerCase();
  return hash && /^[0-9a-f]{1,16}$/.test(hash) ? hash.padStart(16, '0') : undefined;
}

/** URL do resolve de um arquivo da conta: o play pede o link direto, sem createtorrent. */
export function buildLibraryResolveUrl(base: string, token: string, ref: LibraryFileRef): string {
  const url = new URL(`torbox/${encodeURIComponent(token)}/resolve`, base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('linkType', 'library');
  url.searchParams.set('torrentId', String(ref.torrentId));
  if (ref.fileId !== undefined) url.searchParams.set('fileId', String(ref.fileId));
  return url.toString();
}

/** Stream de um item (ou arquivo) do catálogo "Minha TorBox". */
export async function fetchLibraryStreams(token: string, id: string, resolveBase: string): Promise<LibraryStream[]> {
  const ref = parseLibraryId(id);
  if (!ref || ref === 'refresh') return [];
  const item = await TorboxService.accountTorrent(token, ref.torrentId);
  if (!item || item.id !== ref.torrentId) return [];
  const files = item.files ?? [];
  const index = ref.fileId !== undefined ? files.findIndex((f) => f.id === ref.fileId) : -1;
  const file = index >= 0 ? files[index] : undefined;
  if (ref.fileId !== undefined && !file) return [];

  const filename = file ? (file.short_name ?? (file.name ?? '').replace(/^.*[\\/]/, '')) : item.name;
  const quality = parser.inferQualityFromTitle(filename ?? item.name ?? '') ?? '';
  const size = file?.size ?? item.size;
  const lines = [item.name ?? '', file && filename !== item.name ? `📄 ${filename}` : '', size ? `📦 ${parser.formatSize(size)}` : '']
    .filter(Boolean);
  const stream: LibraryStream = {
    name: `[TB⚡] 🗃️ Minha TorBox${quality ? ` ${quality}` : ''}`,
    title: lines.join('\n'),
    url: buildLibraryResolveUrl(resolveBase, token, ref),
    behaviorHints: {
      bingeGroup: `guindex-torbox-library-${item.id}`,
      indexer: LIBRARY_INDEXER_LABEL,
      filename: filename || undefined,
      videoSize: size,
      folderSize: file ? item.size : undefined,
      notWebReady: false,
    },
  };
  if (item.hash) stream.infoHash = item.hash.toLowerCase();
  if (index >= 0) stream.fileIdx = index;
  const videoHash = openSubtitlesHash(file?.opensubtitles_hash);
  if (videoHash) stream.behaviorHints.videoHash = videoHash;
  return [stream];
}
