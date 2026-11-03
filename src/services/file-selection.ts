/**
 * Escolha do arquivo dentro de um torrent: regra única para o provider (que
 * define o fileIdx mostrado no stream), o TorBox e o Real-Debrid (que definem
 * o arquivo que toca). Antes eram três cópias que podiam divergir: num pack
 * com DUBLADO e LEGENDADO do mesmo episódio, o stream mostrava o dublado e o
 * debrid tocava o legendado.
 */

import type { StreamContext } from '../models/source-model.js';

export type FileSelectionContext = StreamContext;

export interface SelectableFile {
  path: string;
  bytes: number;
}

/** Arquivos menores que isso são propaganda, sample ou lixo. */
export const MIN_VIDEO_BYTES = 5 * 1024 * 1024;

const VIDEO_EXTENSIONS =
  /\.(mp4|mkv|mov|avi|ts|m4v|m2ts|wmv|flv|webm|divx|xvid|vob|iso|3gp|ogv|rmvb|mpg|mpeg)$/i;

const JUNK_EXTENSIONS =
  /\.(txt|url|nfo|jpg|jpeg|png|gif|bmp|ico|md|html?|exe|bat|lnk|srt|sub|ass|ssa|idx|sup|mka|rar|zip|7z|pdf|doc|docx|db|torrent)$/i;

const JUNK_CONTENT_REGEX =
  /\b(sample|trailer|extras?|bonus|featurette|behind.?the.?scenes|credits?|creditos|poster|rarbg|nfo|subs?|propaganda|anuncio|promo|preview|teaser|1xbet|banner|ad[s_]|screener|watermark)\b/i;

const DUBBED_REGEX = /\b(dublado|dublada|dual|ptbr|pt[\s._-]?br|nacional)\b/i;
const SUBBED_REGEX = /\b(legendado|leg)\b/i;
const EPISODIC_REGEX = /\bS\d{1,3}E\d{1,3}\b|\b\d{1,2}[x\u00d7]\d{1,3}\b/i;

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.test(path);
}

export function isJunkFile(path: string, bytes: number): boolean {
  if (JUNK_EXTENSIONS.test(path)) return true;
  if (JUNK_CONTENT_REGEX.test(path)) return true;
  if (bytes > 0 && bytes < MIN_VIDEO_BYTES) return true;
  return false;
}

function normalizePath(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

/** Pontua um arquivo contra o pedido (temporada, episódio, título, ano, idioma). */
export function scoreFile(file: SelectableFile, context: FileSelectionContext): number {
  const rawPath = file.path;
  const normalizedPath = normalizePath(rawPath);
  if (!normalizedPath) return 0;

  let score = 0;

  if (isJunkFile(rawPath, file.bytes)) score -= 50;

  if (context.year && normalizedPath.includes(String(context.year))) score += 4;

  if (context.title) {
    const normalizedTitle = normalizePath(context.title);
    if (normalizedTitle && normalizedPath.includes(normalizedTitle)) score += 6;
  }

  // Título do episódio é o sinal mais forte
  if (context.episodeTitle) {
    const normalizedEpisodeTitle = normalizePath(context.episodeTitle);
    if (normalizedEpisodeTitle && normalizedPath.includes(normalizedEpisodeTitle)) score += 14;
  }

  if (context.episode !== undefined) {
    score += scoreEpisodeMatch(rawPath, normalizedPath, context);
  }

  if (context.type === 'movie' && EPISODIC_REGEX.test(rawPath)) score -= 20;

  // Conteúdo brasileiro: dublado > legendado > sem marca
  if (DUBBED_REGEX.test(rawPath)) score += 8;
  else if (SUBBED_REGEX.test(rawPath)) score += 3;

  // Desempate por tamanho (log, para não passar por cima do conteúdo)
  return score + Math.log10(file.bytes + 1);
}

/**
 * Escolhe o arquivo a tocar. Sem nenhum vídeo, devolve o maior arquivo. Entre
 * os vídeos, tira o lixo (se sobrar algum) e fica com a maior pontuação; em
 * empate, o maior arquivo.
 */
export function selectBestFile<T>(
  files: T[],
  describe: (file: T) => SelectableFile,
  context?: FileSelectionContext,
): T | undefined {
  if (files.length === 0) return undefined;
  const entries = files.map((file) => ({ file, info: describe(file) }));
  const bySizeDesc = (a: { info: SelectableFile }, b: { info: SelectableFile }) => b.info.bytes - a.info.bytes;

  const videos = entries.filter((entry) => isVideoFile(entry.info.path));
  if (videos.length === 0) {
    return [...entries].sort(bySizeDesc)[0]?.file;
  }

  const clean = videos.filter((entry) => !isJunkFile(entry.info.path, entry.info.bytes));
  const pool = clean.length > 0 ? clean : videos;
  if (!context) {
    return [...pool].sort(bySizeDesc)[0]?.file;
  }

  return pool
    .map((entry) => ({ ...entry, score: scoreFile(entry.info, context) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.info.bytes - a.info.bytes))[0]?.file;
}

/**
 * Pontua o episódio em todos os formatos de nome conhecidos. Recebe o caminho
 * cru (para ×, acentos) e o normalizado (para os tokens alfanuméricos).
 */
function scoreEpisodeMatch(rawPath: string, normalizedPath: string, context: FileSelectionContext): number {
  const episode = context.episode;
  if (episode === undefined) return 0;

  const ep = String(episode);
  const ep2 = ep.padStart(2, '0');
  const season = context.season;

  let matchScore = 0;

  // ────────────────────────────────────────────────────────────────────
  // 1) Normalized-path token matching
  // ────────────────────────────────────────────────────────────────────
  const normalizedTokens: string[] = [
    `e${ep}`, `e${ep2}`,
    `ep${ep}`, `ep${ep2}`,
    `episode${ep}`, `episode${ep2}`,
    `episodio${ep}`, `episodio${ep2}`,
    `capitulo${ep}`, `capitulo${ep2}`,
    `folge${ep}`, `folge${ep2}`,
    `part${ep}`, `part${ep2}`,
    `parte${ep}`, `parte${ep2}`,
    `cap${ep}`, `cap${ep2}`,
  ];

  if (season !== undefined) {
    const s = String(season);
    const s2 = s.padStart(2, '0');
    normalizedTokens.push(
      `s${s}e${ep}`, `s${s}e${ep2}`,
      `s${s2}e${ep}`, `s${s2}e${ep2}`,
      `season${s}episode${ep}`, `season${s2}episode${ep2}`,
      `temporada${s}episodio${ep}`, `temporada${s2}episodio${ep2}`,
      `${s}x${ep}`, `${s}x${ep2}`,
      `${s2}x${ep}`, `${s2}x${ep2}`,
      // Concatenated: normalize() strips × so 3×02 → "302"
      `${s}${ep2}`, `${s2}${ep2}`,
    );
  }

  const processedTokens = normalizedTokens.map((t) => normalizePath(t)).filter(Boolean);
  for (const token of processedTokens) {
    if (normalizedPath.includes(token)) {
      matchScore += token.length >= 5 ? 12 : token.length >= 3 ? 8 : 5;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // 2) Raw-path matching (for × and special chars)
  // ────────────────────────────────────────────────────────────────────
  const rawLower = rawPath.toLowerCase();

  // 2a) N×NN pattern (× = U+00D7)
  if (season !== undefined) {
    const s = String(season);
    const s2 = s.padStart(2, '0');
    const crossPatterns = [
      `${s}\u00d7${ep}`, `${s}\u00d7${ep2}`,
      `${s2}\u00d7${ep}`, `${s2}\u00d7${ep2}`,
    ];
    for (const cp of crossPatterns) {
      if (rawLower.includes(cp)) {
        matchScore += 14;
      }
    }
  }

  // 2b) Bare number at start of filename
  const bareEpRegex = new RegExp(`(?:^|[/\\\\])0*${episode}\\s*[-._\\s]+[a-z]`, 'i');
  if (bareEpRegex.test(rawPath)) {
    matchScore += 12;
  }

  // 2c) Bare number + extension: "02.mp4"
  const bareExtRegex = new RegExp(`(?:^|[/\\\\])0*${episode}\\.(mkv|mp4|avi|m4v|ts)$`, 'i');
  if (bareExtRegex.test(rawPath)) {
    matchScore += 10;
  }

  // 2d) Portuguese ordinal: "Episódio 2", "Capítulo 02"
  const ptRegex = new RegExp(`(?:epis[oó]dio|cap[ií]tulo|cap\\.?)\\s*0*${episode}\\b`, 'i');
  if (ptRegex.test(rawPath)) {
    matchScore += 12;
  }

  // 2e) Hash notation: #02
  if (rawLower.includes(`#${ep2}`) || rawLower.includes(`#${ep}`)) {
    matchScore += 8;
  }

  // ────────────────────────────────────────────────────────────────────
  // 3) Wrong-episode penalty
  // ────────────────────────────────────────────────────────────────────
  if (season !== undefined && matchScore > 0) {
    const otherEpMatch = rawLower.match(/s\d{1,3}e(\d{1,3})/i) ||
      rawLower.match(/\d{1,2}[x\u00d7](\d{1,3})/i);
    if (otherEpMatch) {
      const detectedEp = parseInt(otherEpMatch[1] ?? '', 10);
      if (!isNaN(detectedEp) && detectedEp !== episode) {
        matchScore -= 20;
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // 4) Episode list bonus
  // ────────────────────────────────────────────────────────────────────
  if (context.episodeList && context.episodeList.includes(episode)) {
    matchScore += 2;
  }

  return matchScore;
}
