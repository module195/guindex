/**
 * Parsing, matching e formatação de resultados do torrent-indexer.
 * Funções sem estado extraídas do TorrentIndexerProvider.
 */

import type { SourceStream } from '../models/source-model.js';
import { detectReleaseLanguages, languagesFromAudioValues, reconcileAudioWithRelease, stripAudioSuffix } from './audio-language.js';
import type {
  ParsedIdInfo,
  CinemetaMeta,
  TorrentLike,
  IndexedTorrentFile,
  IndexerCapability,
  IndexerCatalog,
  MatchContext,
} from './torrent-indexer-shared.js';
import {
  MAX_DYNAMIC_QUERIES,
  MAX_TEXT_QUERIES,
  STRONG_EPISODE_REGEX,
  LANGUAGE_FLAG_MAP,
} from './torrent-indexer-shared.js';

export class TorrentParser {
  getDedupeKey(stream: SourceStream): string | undefined {
    let base: string | undefined;
    if (stream.infoHash) {
      base = stream.infoHash.toLowerCase();
    } else if (stream.magnet) {
      const infoHash = this.extractInfoHash(stream.magnet);
      base = infoHash ? infoHash.toLowerCase() : stream.magnet;
    }
    if (!base) return undefined;
    return stream.fileIdx !== undefined && stream.fileIdx >= 0
      ? `${base}:${stream.fileIdx}`
      : base;
  }

  getTorrentDedupKey(torrent: TorrentLike): string | undefined {
    const infoHash = this.toString(torrent.info_hash ?? torrent.infoHash ?? torrent.hash);
    if (infoHash) {
      return infoHash.toLowerCase();
    }

    const magnet = this.toString(torrent.magnet_link ?? torrent.magnet);
    if (magnet) {
      const hash = this.extractInfoHash(magnet);
      if (hash) {
        return hash.toLowerCase();
      }
      return magnet;
    }

    const title = this.toString(torrent.title ?? torrent.original_title ?? torrent.details);
    return title ? title.toLowerCase() : undefined;
  }

  getStreamInfoHash(stream: SourceStream): string | undefined {
    if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
      return stream.infoHash.trim().toLowerCase();
    }

    if (typeof stream.magnet === 'string' && stream.magnet.startsWith('magnet:')) {
      const extracted = this.extractInfoHash(stream.magnet);
      if (extracted) {
        return extracted.toLowerCase();
      }
    }

    return undefined;
  }

  applyDebridBadge(stream: SourceStream, provider: 'realdebrid' | 'torbox'): void {
    if (!stream) return;
  
    if (typeof stream.name === 'string' && stream.name.length > 0) {
      const nameLines = stream.name.split('\n');
      const firstLine = nameLines[0] ?? '';
  
      let cleaned = firstLine
        .replace(/\[RD\]/gi, '')
        .replace(/RD\+/gi, '')
        .replace(/\bRD\b/gi, '')
        .replace(/\[TB\]/gi, '')
        .replace(/\[?GuIndex\]?/gi, '')
        .trim();
        
      if (!cleaned) cleaned = 'GuIndex';
  
      const qualityStr = nameLines.slice(1).join('\n');
  
      if (provider === 'torbox') {
        stream.name = `[TB] ${cleaned}\n${qualityStr}`.trim();
      } else {
        stream.name = `[RD+] ${cleaned}\n${qualityStr}`.trim();
      }
    }
  }


  parseIndexerCatalog(payload: Record<string, unknown>): IndexerCatalog | undefined {
    const ts = Date.now();
    if (payload?.api_version === 2 && Array.isArray(payload.indexers)) {
      const indexers: IndexerCapability[] = [];
      for (const raw of payload.indexers) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = raw as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        if (!name) continue;
        indexers.push({
          name,
          supportsText: typeof rec.supports_text === 'boolean' ? rec.supports_text : undefined,
          supportsImdb: typeof rec.supports_imdb === 'boolean' ? rec.supports_imdb : undefined,
          healthy: rec.healthy !== false,
        });
      }
      const features = payload.features as Record<string, unknown> | undefined;
      return {
        ts,
        indexers,
        multi: typeof features?.multi === 'boolean' ? features.multi : undefined,
      };
    }

    const names = payload?.indexer_names;
    if (!Array.isArray(names)) {
      return undefined;
    }
    return {
      ts,
      indexers: names
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => ({ name: name.trim(), healthy: true })),
      multi: false,
    };
  }

  buildSearchRetryQueries(query: string): string[] {
    const base = this.sanitizeQuery(query);
    if (!base) {
      return [query];
    }

    const variants: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned) {
        return;
      }
      if (!variants.includes(cleaned)) {
        variants.push(cleaned);
      }
    };

    add(base);

    if (!/^tt\d+$/i.test(base)) {
      const withoutEpisode = base
        .replace(/\bS\d{1,3}E\d{1,3}\b/gi, ' ')
        .replace(/\b\d{1,3}x\d{1,3}\b/gi, ' ')
        .replace(/\b(?:epis[oó]dio|episodio|episode|ep|cap[ií]tulo|capitulo|cap)\.?\s*\d{1,3}\b/gi, ' ')
        .replace(/\b(?:temporada|season|temp\.?|t)\s*\d{1,3}\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      add(withoutEpisode);

      const withoutYear = base.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
      add(withoutYear);
    }

    return variants.slice(0, 4);
  }

  // Slugs do torrent-indexer (normalizeIndexerSlug) → nome legível para o formatter do AIOStreams.
  static readonly INDEXER_LABEL_MAP: Record<string, string> = {
    'torrent-dos-filmes': 'Torrent dos Filmes',
    torrent_dos_filmes: 'Torrent dos Filmes',
    comando_torrents: 'Comando',
    rede_torrent: 'Rede Torrent',
    torrentfilmeshds: 'Torrent Filmes HDs',
    bludv: 'BluDV',
    bludv_ru: 'BluDV',
    baixarapido: 'Baixa Rápido',
    betor: 'BeTor',
    via_filmes: 'Via Filmes',
    'starck-filmes': 'Starck Filmes',
    filme_torrent: 'Filme Torrent',
    vaca_torrent: 'Vaca Torrent',
  };

  /** Nome legível de um slug de indexador conhecido. */
  indexerLabel(slug: string): string | undefined {
    return TorrentParser.INDEXER_LABEL_MAP[slug.toLowerCase()];
  }

  normalizeIndexerSlug(value: string): string {
    const cleaned = this.sanitizeQuery(value)?.toLowerCase() ?? value.toLowerCase();
    return cleaned
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]+/g, '')
      .trim();
  }

  rankTorrentsByQuery(results: TorrentLike[], query: string): TorrentLike[] {
    if (results.length <= 1) {
      return results;
    }

    return [...results].sort((a, b) => this.scoreTorrentForQuery(b, query) - this.scoreTorrentForQuery(a, query));
  }

  hasStrongQueryMatch(results: TorrentLike[], query: string): boolean {
    if (results.length === 0) {
      return false;
    }

    const imdbQuery = /^tt\d+$/i.test(query.trim());
    const threshold = imdbQuery ? 85 : 52;
    const candidates = results.slice(0, 40);
    return candidates.some((torrent) => this.scoreTorrentForQuery(torrent, query) >= threshold);
  }

  scoreTorrentForQuery(torrent: TorrentLike, query: string): number {
    const record = torrent as Record<string, unknown>;
    let score = 0;
    const rawQuery = query.trim();
    const rawTitle = this.extractTitle(torrent) ?? '';
    const rawOriginalTitle = this.toString(record.original_title) ?? '';
    const normalizedTitle = this.normalizeLooseText(`${rawTitle} ${rawOriginalTitle}`);

    const similarity = this.toNumber(record.similarity);
    if (similarity !== undefined) {
      score += Math.max(0, similarity) * 25;
    }

    const seeds = this.toNumber(record.seed_count ?? record.seeders ?? record.seeds);
    if (seeds !== undefined && seeds > 0) {
      score += Math.min(seeds, 200) / 20;
    }

    if (/^tt\d+$/i.test(rawQuery)) {
      const imdb = this.extractImdb(torrent);
      if (imdb && imdb.toLowerCase() === rawQuery.toLowerCase()) {
        score += 120;
      } else {
        score -= 20;
      }
      return score;
    }

    const normalizedQuery = this.normalizeLooseText(rawQuery);
    if (normalizedQuery.length >= 4 && normalizedTitle.includes(normalizedQuery)) {
      score += 55;
    }

    const queryTokens = this.tokenizeQuery(rawQuery);
    if (queryTokens.length > 0) {
      let matchedTokens = 0;
      for (const token of queryTokens) {
        if (normalizedTitle.includes(token)) {
          matchedTokens += 1;
        }
      }

      score += matchedTokens * 10;
      score += (matchedTokens / queryTokens.length) * 45;

      if (matchedTokens === 0) {
        score -= 15;
      }
    }

    const yearMatch = rawQuery.match(/\b((?:19|20)\d{2})\b/);
    if (yearMatch?.[1]) {
      if (new RegExp(`\\b${yearMatch[1]}\\b`).test(rawTitle) || new RegExp(`\\b${yearMatch[1]}\\b`).test(rawOriginalTitle)) {
        score += 8;
      } else {
        score -= 2;
      }
    }

    const querySeasonEpisode = this.extractSeasonEpisodeFromText(rawQuery);
    if (querySeasonEpisode.season !== undefined) {
      const titleSeasonEpisode = this.extractSeasonEpisodeFromText(rawTitle);
      if (titleSeasonEpisode.season !== undefined) {
        if (titleSeasonEpisode.season === querySeasonEpisode.season) {
          score += 14;
        } else {
          score -= 12;
        }
      }

      if (querySeasonEpisode.episode !== undefined && titleSeasonEpisode.episode !== undefined) {
        if (titleSeasonEpisode.episode === querySeasonEpisode.episode) {
          score += 18;
        } else {
          score -= 15;
        }
      }
    }

    if (/\[unsafe\]/i.test(rawTitle)) {
      score -= 6;
    }

    return score;
  }

  normalizeLooseText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tokenizeQuery(value: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'da', 'de', 'do', 'dos', 'das', 'e',
      'temporada', 'season', 'episodio', 'episodio', 'episode', 'parte', 'part',
    ]);

    return this.normalizeLooseText(value)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !stopWords.has(token));
  }

  extractSeasonEpisodeFromText(value: string): { season?: number; episode?: number } {
    const text = value.toLowerCase();
    const sxe = text.match(/s(\d{1,3})e(\d{1,3})/i);
    if (sxe?.[1] && sxe?.[2]) {
      return { season: Number(sxe[1]), episode: Number(sxe[2]) };
    }

    const xFormat = text.match(/(\d{1,3})x(\d{1,3})/i);
    if (xFormat?.[1] && xFormat?.[2]) {
      return { season: Number(xFormat[1]), episode: Number(xFormat[2]) };
    }

    const season = text.match(/(?:temporada|season|temp\.?|t)\s*(\d{1,3})/i);
    const episode = text.match(/(?:epis[oó]dio|episodio|episode|ep|cap[ií]tulo|capitulo|cap\.?)[\s._-]*(\d{1,3})/i);

    return {
      season: season?.[1] ? Number(season[1]) : undefined,
      episode: episode?.[1] ? Number(episode[1]) : undefined,
    };
  }

  mergeTorrentResults(primary: TorrentLike[], secondary: TorrentLike[]): TorrentLike[] {
    if (secondary.length === 0) {
      return [...primary];
    }

    const merged = [...primary];
    const seen = new Set<string>();

    for (const torrent of primary) {
      seen.add(this.buildTorrentMergeKey(torrent));
    }

    for (const torrent of secondary) {
      const key = this.buildTorrentMergeKey(torrent);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(torrent);
    }

    return merged;
  }

  buildTorrentMergeKey(torrent: TorrentLike): string {
    const record = torrent as Record<string, unknown>;
    const magnet = this.toString(record.magnet_link) || this.toString(record.magnet);
    if (magnet) {
      return `magnet:${magnet}`;
    }

    const hash =
      this.toString(record.info_hash) ||
      this.toString(record.infoHash) ||
      this.toString(record.hash) ||
      this.toString(record.btih);
    if (hash) {
      return `hash:${hash.toLowerCase()}`;
    }

    const details = this.toString(record.details) || this.toString(record.url) || this.toString(record.link);
    if (details) {
      return `details:${details}`;
    }

    const title = this.toString(record.title) || this.toString(record.original_title) || this.toString(record.name) || '';
    const size = this.toString(record.size) || this.toString(record.size_bytes) || '';
    return `title:${title.toLowerCase()}|size:${size}`;
  }

  parseId(id: string): ParsedIdInfo {
    const parts = (id || '').split(':');
    const rawId = parts[0] ?? '';
    const season = parts[1];
    const episode = parts[2];

    const info: ParsedIdInfo = {};

    if (/^tt\d+$/.test(rawId)) {
      info.imdbId = rawId;
    } else {
      const sanitizedQuery = this.sanitizeQuery(rawId);
      if (sanitizedQuery) {
        info.query = sanitizedQuery;
      }
    }

    if (season !== undefined) {
      const parsedSeason = Number(season);
      if (!Number.isNaN(parsedSeason)) {
        info.season = parsedSeason;
      }
    }

    if (episode !== undefined) {
      const parsedEpisode = Number(episode);
      if (!Number.isNaN(parsedEpisode)) {
        info.episode = parsedEpisode;
      }
    }

    return info;
  }

  buildTextQuery(
    type: string,
    parsed: ParsedIdInfo,
    targetTitle?: string,
    releaseYear?: number,
    episodeTitle?: string,
  ): string | undefined {
    if (!targetTitle && parsed.query) {
      return parsed.query;
    }

    if (!targetTitle) {
      return undefined;
    }

    if (type.toLowerCase() === 'movie') {
      if (releaseYear) {
        return `${targetTitle} ${releaseYear}`;
      }
      return targetTitle;
    }

    if (parsed.season !== undefined) {
      const seasonPart = `temporada ${parsed.season}`;
      if (parsed.episode !== undefined) {
        const episodePart = `episodio ${parsed.episode}`;
        return `${targetTitle} ${seasonPart} ${episodePart}`;
      }
      if (releaseYear) {
        return `${targetTitle} ${seasonPart} ${releaseYear}`;
      }
      return `${targetTitle} ${seasonPart}`;
    }

    if (episodeTitle) {
      return `${targetTitle} ${episodeTitle}`;
    }

    return targetTitle;
  }

  buildTextQueryCandidates(
    type: string,
    parsed: ParsedIdInfo,
    targetTitles: string[],
    releaseYear?: number,
    episodeTitle?: string,
  ): string[] {
    const out: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned) {
        return;
      }
      if (!out.includes(cleaned)) {
        out.push(cleaned);
      }
    };

    if (parsed.query) {
      add(parsed.query);
    }

    const seenTitles = Array.from(new Set(targetTitles.map((t) => this.sanitizeQuery(t)).filter(Boolean) as string[]));
    const limitedTitles = seenTitles.slice(0, 6);

    // Extracao de todas as variantes de titulos
    const allTitles: string[] = [];
    for (const baseTitle of limitedTitles) {
      allTitles.push(...this.buildLocaleTitleVariants(baseTitle).slice(0, 5));
    }
    const uniqueTitles = [...new Set(allTitles)];

    if (type.toLowerCase() === 'movie') {
      uniqueTitles.forEach(title => add(title));
      if (releaseYear) {
        uniqueTitles.forEach(title => add(`${title} ${releaseYear}`));
      }
    } else {
      // SERIES - Ordem otimizada por estilo para alternar entre idiomas!
      const s = parsed.season;
      const e = parsed.episode;
      const sPad = s !== undefined ? String(s).padStart(2, '0') : undefined;
      const ePad = e !== undefined ? String(e).padStart(2, '0') : undefined;

      // Estilo 1: SxxEyy (Ex: Invencivel S02E03, Invincible S02E03)
      if (sPad !== undefined && ePad !== undefined) {
        uniqueTitles.forEach(title => add(`${title} S${sPad}E${ePad}`));
      }

      // Estilo 2: Sxx (Packs de Temporada)
      if (sPad !== undefined) {
        uniqueTitles.forEach(title => add(`${title} S${sPad}`));
      }

      // Estilo 3: temporada x
      if (s !== undefined) {
        uniqueTitles.forEach(title => add(`${title} temporada ${s}`));
      }

      // Estilo 4: temporada x episodio y
      if (s !== undefined && e !== undefined) {
        uniqueTitles.forEach(title => add(`${title} temporada ${s} episodio ${e}`));
      }

      // Estilo 5: Titulo + Nome do Episodio
      if (episodeTitle) {
        uniqueTitles.forEach(title => add(`${title} ${episodeTitle}`));
      }

      // Estilo 6: Titulo Puro (Ex: Invencivel, Invincible) - Fallback Universal
      uniqueTitles.forEach(title => add(title));

      // Estilo 7: Titulo + Ano
      if (releaseYear) {
        uniqueTitles.forEach(title => add(`${title} ${releaseYear}`));
      }
    }

    return out.slice(0, MAX_TEXT_QUERIES);
  }

  buildLocaleTitleVariants(title: string): string[] {
    const out: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned) {
        return;
      }
      if (!out.includes(cleaned)) {
        out.push(cleaned);
      }
    };

    const base = this.sanitizeQuery(title);
    if (!base) {
      return out;
    }

    const strippedArticle = base
      .replace(/^(the|a|an|o|os|as)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const remainingWords = strippedArticle.split(/\s+/).length;
    if (strippedArticle && strippedArticle !== base && remainingWords >= 2) {
      add(strippedArticle);
    }

    add(base);
    add(base.replace(/[:|]/g, ' '));

    const enToPt: Array<[RegExp, string]> = [
      [/\bpart\s+two\b/gi, 'parte dois'],
      [/\bpart\s+three\b/gi, 'parte tres'],
      [/\bpart\s+one\b/gi, 'parte um'],
      [/\bpart\s+([0-9]+)\b/gi, 'parte $1'],
      [/\bchapter\b/gi, 'capitulo'],
      [/\bthe\b/gi, ''],
    ];

    const ptToEn: Array<[RegExp, string]> = [
      [/\bparte\s+dois\b/gi, 'part two'],
      [/\bparte\s+tres\b/gi, 'part three'],
      [/\bparte\s+um\b/gi, 'part one'],
      [/\bparte\s+([0-9]+)\b/gi, 'part $1'],
      [/\bcapitulo\b/gi, 'chapter'],
    ];

    let ptVariant = base;
    for (const [regex, replacement] of enToPt) {
      ptVariant = ptVariant.replace(regex, replacement);
    }
    add(ptVariant);

    let enVariant = base;
    for (const [regex, replacement] of ptToEn) {
      enVariant = enVariant.replace(regex, replacement);
    }
    add(enVariant);

    return out;
  }

  collectDynamicQueryCandidates(
    type: string,
    parsed: ParsedIdInfo,
    torrents: TorrentLike[],
    releaseYear?: number,
    episodeTitle?: string,
  ): string[] {
    const out: string[] = [];
    const add = (value?: string) => {
      if (!value) {
        return;
      }
      const cleaned = this.sanitizeQuery(value);
      if (!cleaned || cleaned.length < 3 || cleaned.length > 140) {
        return;
      }
      if (!out.includes(cleaned)) {
        out.push(cleaned);
      }
    };

    const topTorrents = torrents.slice(0, 40);
    const titles: string[] = [];

    for (const torrent of topTorrents) {
      const collected = this.collectTorrentTitles(torrent);
      for (const title of collected) {
        if (/(1080p|720p|2160p|4k|x264|h264|x265|hevc|bluray|web-dl|webrip|hdtv|camrip|dublado|legendado|dual\s*audio|remux)/i.test(title)) {
          continue;
        }

        if (!titles.includes(title)) {
          titles.push(title);
        }
      }
      if (titles.length >= 18) {
        break;
      }
    }

    for (const rawTitle of titles.slice(0, 12)) {
      const localized = this.buildLocaleTitleVariants(rawTitle).slice(0, 4);
      for (const title of localized) {
        add(title);
        if (type.toLowerCase() === 'movie') {
          if (releaseYear) {
            add(`${title} ${releaseYear}`);
          }
          continue;
        }

        if (parsed.season !== undefined) {
          const season = parsed.season;
          const seasonPadded = String(season).padStart(2, '0');
          add(`${title} temporada ${season}`);
          add(`${title} season ${season}`);
          add(`${title} S${seasonPadded}`);

          if (parsed.episode !== undefined) {
            const episode = parsed.episode;
            const episodePadded = String(episode).padStart(2, '0');
            add(`${title} temporada ${season} episodio ${episode}`);
            add(`${title} season ${season} episode ${episode}`);
            add(`${title} S${seasonPadded}E${episodePadded}`);
            add(`${title} ${season}x${episodePadded}`);
          }
        }

        if (episodeTitle) {
          add(`${title} ${episodeTitle}`);
        }
      }
    }

    return out.slice(0, MAX_DYNAMIC_QUERIES);
  }

  isRelevantTorrent(torrent: TorrentLike, context: MatchContext): boolean {
    const { parsed, type, targetTitles, releaseYear } = context;
    const normalizedType = type.toLowerCase();
    const imdb = this.extractImdb(torrent);

    if (parsed.imdbId && !imdb && targetTitles.length === 0) {
      return false;
    }

    if (!parsed.imdbId || !imdb) {
      const torrentTitles = this.collectTorrentTitles(torrent);
      if (targetTitles.length > 0 && torrentTitles.length > 0) {
        const normalizedTargets = targetTitles
          .map((title) => this.normalizeForComparison(title))
          .filter((title) => title.length >= 3);
        const normalizedAlphabeticTargets = normalizedTargets.filter((title) => /[a-z]/.test(title));
        const effectiveTargets =
          normalizedAlphabeticTargets.length > 0 ? normalizedAlphabeticTargets : normalizedTargets;

        if (effectiveTargets.length === 0) {
          return false;
        }

        const normalizedTorrentTitles = torrentTitles.map((title) => this.normalizeForComparison(title));

        const matchesTitle = normalizedTorrentTitles.some((torrentTitle) =>
          effectiveTargets.some((targetTitle) =>
            torrentTitle.includes(targetTitle) || targetTitle.includes(torrentTitle),
          ),
        );

        if (!matchesTitle) {
          return false;
        }
      }
    } else if (imdb.toLowerCase() !== parsed.imdbId.toLowerCase()) {
      return false;
    }

    if (normalizedType === 'movie') {
      if (this.hasEpisodePattern(torrent)) {
        return false;
      }
      if (releaseYear !== undefined) {
        const torrentYear = this.extractYear(torrent);
        if (torrentYear !== undefined && Math.abs(torrentYear - releaseYear) > 1) {
          return false;
        }
      }
    }

    if (normalizedType !== 'movie' && parsed.season !== undefined) {
      const texts = this.collectSearchableTexts(torrent);

      if (this.isCompleteSeriesPack(texts)) {
        // falls through
      } else {
        const range = this.extractSeasonRangeFromTexts(texts);
        if (range) {
          if (parsed.season < range.start || parsed.season > range.end) {
            return false;
          }
        } else {
          const torrentSeason = this.extractSeasonFromTorrent(torrent);
          if (torrentSeason !== undefined && torrentSeason !== parsed.season) {
            return false;
          }

          if (torrentSeason === undefined) {
            const files = this.extractFilesFromTorrent(torrent);
            if (files.length > 0) {
              const fileSeasonsSet = new Set<number>();
              for (const file of files) {
                const fs = this.extractSeasonFromTorrent({ title: file.path });
                if (fs !== undefined) fileSeasonsSet.add(fs);
              }
              if (fileSeasonsSet.size > 0 && !fileSeasonsSet.has(parsed.season)) {
                return false;
              }
            }
          }
        }
      }

      if (parsed.episode !== undefined) {
        // Faixa ou lista no nome do release ("S02E01-E05", "Episódios 06 ao 13")
        // decide sozinha; sem ela, vale o primeiro episódio achado nos textos.
        const titleEpisodes = this.extractEpisodeSetFromTitles(torrent);
        if (titleEpisodes) {
          return titleEpisodes.has(parsed.episode);
        }
        const torrentEpisode = this.extractEpisodeFromTorrent(torrent);
        if (torrentEpisode !== undefined && torrentEpisode !== parsed.episode) {
          return false;
        }
        const episodeList = this.extractEpisodeList(torrent);
        if (episodeList && episodeList.length > 0 && !episodeList.includes(parsed.episode)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Episódios que o nome do release cobre: "S02E01-E05", "S02E01-05", "S02E01 ao E05",
   * "S02E01E02E03", "Episódios 06 ao 13", "Episódio 03 e 04", ou um só ("S02E03", "2x03").
   * Lê o texto cru, antes de "-" virar espaço. Sem episódio no nome (pack de temporada),
   * devolve undefined.
   */
  extractEpisodeSetFromTitles(torrent: TorrentLike): Set<number> | undefined {
    const record = torrent as Record<string, unknown>;
    const titles = [record.title, record.original_title, record.name, record.filename, record.release]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const episodes = new Set<number>();
    const addRange = (start: number, end: number) => {
      if (start > 0 && end >= start && end - start <= 60) {
        for (let i = start; i <= end; i++) episodes.add(i);
      }
    };

    for (const raw of titles) {
      const text = raw.replace(/[._]/g, ' ');
      for (const m of text.matchAll(/S\d{1,2}\s?E(\d{1,3})\s*(?:-|a|ao|à|até)\s*E?(\d{1,3})\b/gi)) {
        addRange(Number(m[1]), Number(m[2]));
      }
      for (const m of text.matchAll(/S\d{1,2}((?:E\d{1,3}){2,})/gi)) {
        for (const ep of m[1]?.match(/\d{1,3}/g) ?? []) episodes.add(Number(ep));
      }
      const spaced = text.replace(/-/g, ' - ');
      for (const m of spaced.matchAll(/\bep(?:is[oó]dios?|s?)\s*(\d{1,3})\s*(-|a|ao|à|até|e)\s*(\d{1,3})\b/gi)) {
        if (m[2]?.toLowerCase() === 'e') {
          episodes.add(Number(m[1]));
          episodes.add(Number(m[3]));
        } else {
          addRange(Number(m[1]), Number(m[3]));
        }
      }
    }
    if (episodes.size > 0) return episodes;

    for (const raw of titles) {
      const text = raw.replace(/[._]/g, ' ');
      const single = /S\d{1,2}\s?E(\d{1,3})\b|\b\d{1,2}x(\d{1,3})\b|\bep(?:is[oó]dio|\.)?\s*(\d{1,3})\b/i.exec(text);
      const value = single ? Number(single[1] ?? single[2] ?? single[3]) : NaN;
      if (value > 0) return new Set([value]);
    }
    return undefined;
  }

  /**
   * Para filmes: o torrent parece de série? Só olha campos estruturados e os títulos
   * do release; descrição, detalhes e slug citam "temporada", "coleção" e
   * "episódio" em sinopses de filme.
   */
  hasEpisodePattern(torrent: TorrentLike): boolean {
    if (this.extractSeason(torrent) !== undefined || this.extractEpisode(torrent) !== undefined) {
      return true;
    }

    const record = torrent as Record<string, unknown>;
    return [record.title, record.original_title]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => this.normalizeEpisodeMetadata(value))
      .some((value) => value !== undefined && STRONG_EPISODE_REGEX.test(value));
  }

  normalizeEpisodeMetadata(value: string): string | undefined {
    let normalized = value;
    try {
      normalized = decodeURIComponent(value);
    } catch {
      normalized = value;
    }

    normalized = normalized.replace(/https?:\/\/[^/]+/gi, ' ');
    normalized = normalized.replace(/[/_.\-+]/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return undefined;
    }

    return normalized.toLowerCase();
  }

  extractImdb(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.imdb),
      this.toString(record.imdbId),
      this.toString(record.imdb_id),
      this.toString(record['Imdb']),
      this.toString(record['IMDB']),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (/^tt\d+$/.test(candidate)) {
        return candidate;
      }
      const match = candidate.match(/tt\d+/);
      if (match) {
        return match[0];
      }
    }

    return undefined;
  }

  collectTorrentTitles(torrent: TorrentLike): string[] {
    const record = torrent as Record<string, unknown>;
    const titles = new Set<string>();

    const add = (value: unknown) => {
      if (typeof value === 'string') {
        const sanitized = this.sanitizeQuery(value);
        if (sanitized) {
          titles.add(sanitized);
        }
      }
    };

    add(record.title);
    add(record.original_title);
    add(record.name);
    add(record.filename);
    add(record.release);
    add(record.file);
    add(record.slug);
    add(record.displayName);

    const extra = record.titles;
    if (Array.isArray(extra)) {
      extra.forEach(add);
    }

    return Array.from(titles);
  }

  extractYear(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate = record.year ?? record.releaseYear ?? record.release_year ?? record.date;

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string') {
      const match = candidate.match(/\d{4}/);
      if (match) {
        return Number(match[0]);
      }
    }

    const texts = this.collectSearchableTexts(torrent);
    for (const text of texts) {
      if (!text) continue;
      const yearMatch = text.match(/[([.\s]((?:19[5-9]\d|20[0-9]\d))[)\].\s]/)
        ?? text.match(/\b((?:19[5-9]\d|20[0-9]\d))\b/);
      if (yearMatch?.[1]) {
        const y = Number(yearMatch[1]);
        if (y >= 1950 && y <= 2099) return y;
      }
    }

    return undefined;
  }

  extractSeason(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.season ??
      record.seasonNumber ??
      record.season_number ??
      record.seriesSeason ??
      record['Season'];

    return this.toNumber(candidate);
  }

  extractEpisode(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.episode ??
      record.episodeNumber ??
      record.episode_number ??
      record.seriesEpisode ??
      record['Episode'];

    return this.toNumber(candidate);
  }

  collectSearchableTexts(torrent: TorrentLike): string[] {
    const record = torrent as Record<string, unknown>;
    const texts: string[] = [];
    const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) texts.push(v.trim()); };
    add(record.title);
    add(record.original_title);
    add(record.name);
    add(record.filename);
    add(record.release);
    add(record.file);
    add(record.slug);
    add(record.displayName);
    add(record.description);
    add(record.summary);
    add(record.details);
    add(record.category);
    add(record.subcategory);
    const tags = record.tags ?? record.categories;
    if (Array.isArray(tags)) tags.forEach(add);
    return texts;
  }

  static readonly SEASON_PATTERNS: { regex: RegExp; group: number }[] = [
    { regex: /\bS(\d{1,3})(?:E\d{1,3})?\b/i, group: 1 },
    { regex: /\b(\d{1,2})[x×]\d{1,3}\b/i, group: 1 },
    { regex: /(\d{1,3})[ªºᵃᵒaAoO]\s*temporada/i, group: 1 },
    { regex: /\b(?:temporada|season)\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\btemp\.?\s*(\d{1,3})\b/i, group: 1 },
    { regex: /(\d{1,3})[ªºᵃᵒaAoO]\s*temp\b/i, group: 1 },
    { regex: /(?:^|[\s._\-[(])T(\d{1,2})(?:[\s._\-\])]|$)/i, group: 1 },
    { regex: /\bpack\s+(?:temporada|season|temp\.?)\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\bda\s+(\d{1,3})\s*temporada\b/i, group: 1 },
  ];

  static readonly SEASON_RANGE_PATTERNS: { regex: RegExp; startGroup: number; endGroup: number }[] = [
    { regex: /(\d{1,3})[ªºᵃᵒaAoO]?\s*(?:a|à|até|ao|~|-)\s*(\d{1,3})[ªºᵃᵒaAoO]?\s*temporada/i, startGroup: 1, endGroup: 2 },
    { regex: /temporadas?\s*(\d{1,3})\s*(?:a|à|até|ao|~|-|e)\s*(\d{1,3})/i, startGroup: 1, endGroup: 2 },
    { regex: /seasons?\s*(\d{1,3})\s*(?:to|through|thru|~|-)\s*(\d{1,3})/i, startGroup: 1, endGroup: 2 },
    { regex: /\bS(\d{1,3})\s*[-~.]\s*S(\d{1,3})\b/i, startGroup: 1, endGroup: 2 },
    { regex: /\bT(\d{1,2})\s*[-~.]\s*T(\d{1,2})\b/i, startGroup: 1, endGroup: 2 },
    { regex: /\btemp\.?\s*(\d{1,3})\s*(?:a|à|até|ao|~|-)\s*(\d{1,3})/i, startGroup: 1, endGroup: 2 },
  ];

  static readonly COMPLETE_SERIES_PATTERNS: RegExp[] = [
    /\b(?:s[eé]rie|series)\s+completa\b/i,
    /\bcomplete\s+(?:s[eé]rie|series)\b/i,
    /\btodas?\s+(?:as\s+)?temporadas?\b/i,
    /\ball\s+seasons?\b/i,
    /\bcomplete\s+(?:collection|box\s*set|pack)\b/i,
    /\bcole[çc][ãa]o\s+completa\b/i,
    /\bpack\s+completo\b/i,
    /\bintegral\b/i,
    /\bthe\s+complete\s+series\b/i,
    /\bdiscografia\s+completa\b/i,
  ];

  static readonly EPISODE_PATTERNS: { regex: RegExp; group: number }[] = [
    { regex: /\bS\d{1,3}E(\d{1,3})\b/i, group: 1 },
    { regex: /\b\d{1,2}[x×](\d{1,3})\b/i, group: 1 },
    { regex: /\bep\.?\s*(\d{1,3})\b/i, group: 1 },
    { regex: /(?<!S\d{0,3})\bE(\d{1,3})\b/i, group: 1 },
    { regex: /\b(?:epis[oó]dio|episodio|episode)\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\b(?:cap[ií]tulo|capitulo|cap)\.?\s*(\d{1,3})\b/i, group: 1 },
    { regex: /\bfolge\s*(\d{1,3})\b/i, group: 1 },
    { regex: /#(\d{1,3})\b/, group: 1 },
    { regex: /(?:^|[/\\])0*(\d{1,3})\s*[-._\s]+[A-Za-z]/, group: 1 },
    { regex: /(?:^|[/\\])0*(\d{1,3})\.(mkv|mp4|avi|m4v|ts)$/i, group: 1 },
    { regex: /(?:^|[/\\])\d(\d{2})\s*[-._\s]+[A-Za-z]/, group: 1 },
  ];

  extractSeasonFromTorrent(torrent: TorrentLike): number | undefined {
    const structured = this.extractSeason(torrent);
    if (structured !== undefined) return structured;

    const texts = this.collectSearchableTexts(torrent);
    for (const text of texts) {
      if (!text) continue;
      for (const { regex, group } of TorrentParser.SEASON_PATTERNS) {
        const m = text.match(regex);
        if (m?.[group]) {
          const season = parseInt(m[group], 10);
          if (!isNaN(season) && season > 0 && season < 200) return season;
        }
      }
    }
    return undefined;
  }

  extractSeasonRangeFromTexts(texts: string[]): { start: number; end: number } | undefined {
    for (const text of texts) {
      if (!text) continue;
      for (const { regex, startGroup, endGroup } of TorrentParser.SEASON_RANGE_PATTERNS) {
        const m = text.match(regex);
        if (m?.[startGroup] && m?.[endGroup]) {
          const start = parseInt(m[startGroup], 10);
          const end = parseInt(m[endGroup], 10);
          if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
            return { start, end };
          }
        }
      }
    }
    return undefined;
  }

  isCompleteSeriesPack(texts: string[]): boolean {
    for (const text of texts) {
      if (!text) continue;
      for (const pattern of TorrentParser.COMPLETE_SERIES_PATTERNS) {
        if (pattern.test(text)) return true;
      }
    }
    return false;
  }

  extractEpisodeFromTorrent(torrent: TorrentLike): number | undefined {
    const structured = this.extractEpisode(torrent);
    if (structured !== undefined) return structured;

    const texts = this.collectSearchableTexts(torrent);
    for (const text of texts) {
      if (!text) continue;
      for (const { regex, group } of TorrentParser.EPISODE_PATTERNS) {
        const m = text.match(regex);
        if (m?.[group]) {
          const episode = parseInt(m[group], 10);
          if (!isNaN(episode) && episode > 0 && episode < 2000) return episode;
        }
      }
    }
    return undefined;
  }

  extractEpisodeList(torrent: TorrentLike): number[] | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      record.episodes,
      record.episodeList,
      record.episode_list,
      record.episodeNumbers,
      record.episode_numbers,
      record.filesEpisodes,
      record.parts,
    ];

    const numbers = new Set<number>();

    const addValue = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        numbers.add(Math.floor(value));
        return;
      }

      if (typeof value === 'string') {
        const matches = value.match(/\d+/g);
        if (matches) {
          matches.forEach((match) => {
            const parsed = Number(match);
            if (!Number.isNaN(parsed)) {
              numbers.add(parsed);
            }
          });
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(addValue);
        return;
      }

      if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
          addValue(item);
        }
      }
    };

    candidates.forEach(addValue);

    if (numbers.size === 0) {
      const texts = this.collectSearchableTexts(torrent);
      for (const text of texts) {
        if (!text) continue;
        const rangeMatch = text.match(/\bE(?:P)?\.?\s*(\d{1,3})\s*[-~]\s*E(?:P)?\.?\s*(\d{1,3})\b/i);
        if (rangeMatch?.[1] && rangeMatch?.[2]) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start && end - start < 100) {
            for (let i = start; i <= end; i++) numbers.add(i);
            break;
          }
        }
        const ptRangeMatch = text.match(/\b(?:epis[oó]dio|episodio|cap[ií]tulo|capitulo)\s*(\d{1,3})\s*(?:a|ao|até|~|-)\s*(\d{1,3})\b/i);
        if (ptRangeMatch?.[1] && ptRangeMatch?.[2]) {
          const start = parseInt(ptRangeMatch[1], 10);
          const end = parseInt(ptRangeMatch[2], 10);
          if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start && end - start < 100) {
            for (let i = start; i <= end; i++) numbers.add(i);
            break;
          }
        }
      }
    }

    if (numbers.size === 0) {
      return undefined;
    }

    return Array.from(numbers).sort((a, b) => a - b);
  }

  normalizeForComparison(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '')
      .toLowerCase();
  }

  collectMetaTitles(meta?: CinemetaMeta): string[] {
    if (!meta) {
      return [];
    }

    const titles = new Set<string>();
    const addIfString = (value?: unknown) => {
      if (typeof value === 'string') {
        const sanitized = this.sanitizeQuery(value);
        if (sanitized) {
          titles.add(sanitized);
        }
      }
    };

    const explore = (value: unknown, depth = 0) => {
      if (depth > 3 || !value) {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => explore(item, depth + 1));
        return;
      }

      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const [key, val] of Object.entries(record)) {
          if (/title|name/i.test(key)) {
            if (typeof val === 'string') {
              addIfString(val);
            } else {
              explore(val, depth + 1);
            }
          }
        }
      }
    };

    addIfString(meta.name);
    addIfString(meta.title);
    addIfString(meta.originalTitle);

    const alternativeKeys = ['aliases', 'alternativeTitles', 'alternative_titles', 'aka'];
    for (const key of alternativeKeys) {
      const value = (meta as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        value.forEach(addIfString);
      }
    }

    explore(meta.translations);
    explore(meta.infos);

    return Array.from(titles);
  }

  /** Runtime do Cinemeta ("152 min", "2h 32min", "1h") em segundos. */
  extractRuntimeSeconds(meta?: CinemetaMeta): number | undefined {
    const runtime = meta?.runtime;
    if (typeof runtime === 'number' && Number.isFinite(runtime) && runtime > 0) {
      return Math.round(runtime * 60);
    }
    if (typeof runtime !== 'string') {
      return undefined;
    }
    const hours = runtime.match(/(\d+)\s*h/i);
    const minutes = runtime.match(/(\d+)\s*m/i);
    const bare = !hours && !minutes ? runtime.match(/^\s*(\d+)\s*$/) : null;
    const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0) + (bare ? Number(bare[1]) : 0);
    return total > 0 ? total * 60 : undefined;
  }

  extractReleaseYear(meta?: CinemetaMeta): number | undefined {
    if (!meta) {
      return undefined;
    }

    const directYear = (meta.year ?? (meta as Record<string, unknown>).releaseYear ?? (meta as Record<string, unknown>).released) as unknown;
    if (typeof directYear === 'number' && Number.isFinite(directYear)) {
      return directYear;
    }

    if (typeof directYear === 'string') {
      const match = directYear.match(/\d{4}/);
      if (match) {
        return Number(match[0]);
      }
    }

    if (typeof meta.releaseInfo === 'string') {
      const match = meta.releaseInfo.match(/\d{4}/);
      if (match) {
        return Number(match[0]);
      }
    }

    return undefined;
  }

  findEpisodeTitle(meta: CinemetaMeta | undefined, season: number, episode: number): string | undefined {
    if (!meta || !Array.isArray(meta.videos)) {
      return undefined;
    }

    const match = meta.videos.find((video) => {
      const videoSeason = typeof video.season === 'number' ? video.season : Number(video.season);
      const videoEpisode = typeof video.episode === 'number' ? video.episode : Number(video.episode);
      return videoSeason === season && videoEpisode === episode;
    });

    if (!match) {
      return undefined;
    }

    const candidates = [match.title, match.name];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const sanitized = this.sanitizeQuery(candidate);
      if (sanitized) {
        return sanitized;
      }
    }

    return undefined;
  }

  /** Nome do release como publicado: dn do magnet, ou o título sem o sufixo de áudio do torrent-indexer. */
  extractReleaseName(torrent: TorrentLike, magnet: string): string | undefined {
    const rawTitle = this.extractTitle(torrent)?.trim();
    const title = rawTitle ? this.stripAudioSuffix(rawTitle) : undefined;
    const fromMagnet = this.extractMagnetDisplayName(magnet);
    if (fromMagnet) {
      return this.stripSitePrefix(fromMagnet, title) ?? title ?? fromMagnet;
    }
    return title;
  }

  // Sites que carimbam o próprio domínio no início do dn: "BAIXARAPIDO.COM-.EPISODIO-01-E-02.WEB-DL...-.Show.S01E01-02.1080p".
  static readonly SITE_PREFIX =
    /^[\s[({]*(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|biz|tv|me|cc|to|io|ru|xyz|site|online|top|vip|club|lol|link)(?:\.br)?(?![a-z0-9])/i;

  /**
   * Corta o carimbo de site do dn, mantendo o nome do release que vem depois dele.
   * O release começa onde aparece o início do título; sem esse ponto, devolve undefined.
   */
  stripSitePrefix(displayName: string, title: string | undefined): string | undefined {
    const prefix = displayName.match(TorrentParser.SITE_PREFIX);
    if (!prefix) {
      return displayName;
    }
    const tokens = (title ?? '').split(/[\s._-]+/).filter(Boolean);
    const anchorTokens = (tokens[0]?.length ?? 0) >= 3 ? tokens.slice(0, 1) : tokens.slice(0, 2);
    if (anchorTokens.length === 0) {
      return undefined;
    }
    const escaped = anchorTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const anchor = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escaped.join('[\\s._-]+')})(?![\\p{L}\\p{N}])`, 'iu');
    const rest = displayName.slice(prefix[0].length);
    const match = anchor.exec(rest);
    if (!match || match.index === undefined) {
      return undefined;
    }
    const start = match.index + match[0].length - (match[1] ?? '').length;
    return rest.slice(start).trim() || undefined;
  }

  extractMagnetDisplayName(magnet: string): string | undefined {
    const query = magnet.split('?')[1];
    if (!query) {
      return undefined;
    }
    try {
      return new URLSearchParams(query).get('dn')?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // Códigos que o torrent-indexer anexa ao título em appendAudioISO639_2Code: "Nome (brazilian, eng)".
  static readonly AUDIO_SUFFIX_CODES = new Set([
    'brazilian', 'eng', 'spa', 'fra', 'deu', 'ita', 'jpn', 'kor', 'chi', 'yue', 'rus', 'swe', 'srb', 'ukr',
    'pol', 'tha', 'tur', 'hin', 'hun', 'fas', 'msa', 'nld', 'fin', 'dan', 'nor', 'isl', 'ell', 'ara', 'heb',
    'vie', 'ind', 'fil', 'ben', 'tam', 'tel', 'guj', 'mar',
  ]);

  stripAudioSuffix(title: string): string {
    // Às vezes o sufixo vem repetido: "Nome (brazilian) (brazilian)".
    let stripped = title;
    for (;;) {
      const match = stripped.match(/\s*\(([^()]*)\)\s*$/);
      if (!match || match.index === undefined) {
        return stripped;
      }
      const codes = (match[1] ?? '').split(',').map((code) => code.trim()).filter(Boolean);
      const isAudioSuffix = codes.length > 0 && codes.every((code) => TorrentParser.AUDIO_SUFFIX_CODES.has(code));
      if (!isAudioSuffix) {
        return stripped;
      }
      stripped = stripped.slice(0, match.index).trim();
    }
  }

  /** Data de publicação em ISO 8601; ignora datas zero do Go (0001-01-01) e valores inválidos. */
  extractPublishDate(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate = record.date ?? record.publishDate ?? record.publish_date ?? record.pubDate;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      return undefined;
    }
    const time = new Date(candidate).getTime();
    if (!Number.isFinite(time) || time <= 0) {
      return undefined;
    }
    return new Date(time).toISOString();
  }

  /**
   * Build a proper folder/file path for AIOStreams display.
   * When a file was selected from a pack, ensures the path includes a folder prefix
   * so AIOStreams can show: 📁 Folder Name / 📄 filename.mkv
   */
  buildStreamFileName(
    selectedFilePath: string | undefined,
    rawTorrentTitle: string,
    displayTitle: string,
    torrent: TorrentLike
  ): string {
    const fallback = displayTitle || this.extractFileName(torrent) || rawTorrentTitle;

    if (!selectedFilePath) {
      // No file selected from a pack — return clean title (likely a single-file torrent)
      return fallback;
    }

    // If the path already has a folder prefix (contains / or \), use it as-is
    if (/[/\\]/.test(selectedFilePath)) {
      return selectedFilePath;
    }

    // The file path is just a bare filename (e.g. "2 - Sick.mp4").
    // Prepend the torrent title as a folder name so AIOStreams shows:
    //   📁 The Walking Dead 3ª Temporada (2012)
    //   📄 2 - Sick.mp4
    const folderName = this.cleanIndexerTitle(rawTorrentTitle)
      .replace(/\.(mkv|mp4|avi|m4v|ts|m2ts|iso)$/i, '') // remove extension if present
      .replace(/[<>:"|?*]/g, '') // remove invalid path chars
      .trim();

    if (folderName) {
      return `${folderName}/${selectedFilePath}`;
    }

    return selectedFilePath;
  }

  /**
   * Detect whether a torrent looks like a full-season pack without individual file listings.
   * This is used to decide whether to build a synthetic episode fileName for display.
   */
  looksLikeSeasonPack(torrent: TorrentLike, context: MatchContext): boolean {
    // If the API already gave us files, selectBestTorrentFile handled it
    const filesRaw = (torrent as Record<string, unknown>).files;
    if (Array.isArray(filesRaw) && filesRaw.length > 0) {
      return false;
    }

    const texts = this.collectSearchableTexts(torrent);
    const combined = texts.join(' ');

    // Check if this looks like a complete series or multi-season pack
    if (this.isCompleteSeriesPack(texts)) {
      return true;
    }

    // Check for season ranges
    const range = this.extractSeasonRangeFromTexts(texts);
    if (range && context.parsed.season !== undefined) {
      return context.parsed.season >= range.start && context.parsed.season <= range.end;
    }

    // Check if title mentions a season but NOT a specific single episode
    const hasSeason = /\b(temporada|season|S\d{1,2}(?!E\d)|T\d{1,2}|\d{1,2}[ªºa]\s*temp)/i.test(combined);
    const hasSingleEp = /\bS\d{1,3}E\d{1,3}\b/i.test(combined) ||
      /\b\d{1,2}[x×]\d{1,3}\b/i.test(combined) ||
      /\bE(?:P)?\.?\s*\d{1,3}\b/i.test(combined);

    // It's a pack if it mentions a season but not a specific episode
    return hasSeason && !hasSingleEp;
  }

  buildDisplayTitle(torrent: TorrentLike, fallbackTitle: string): string {
    let title = fallbackTitle;

    const extracted = this.extractTitle(torrent);
    if (extracted && extracted.trim()) {
      title = extracted.trim();
    }

    const year = this.extractYear(torrent);
    if (year !== undefined && !new RegExp(`\\b${year}\\b`).test(title)) {
      title = `${title} (${year})`;
    }

    const season = this.extractSeasonFromTorrent(torrent);
    if (season !== undefined) {
      const seasonToken = `S${String(season).padStart(2, '0')}`;
      const episode = this.extractEpisodeFromTorrent(torrent);
      const episodeToken = episode !== undefined ? `E${String(episode).padStart(2, '0')}` : undefined;
      const code = episodeToken ? `${seasonToken}${episodeToken}` : seasonToken;

      if (!new RegExp(seasonToken, 'i').test(title) && (!episodeToken || !new RegExp(episodeToken, 'i').test(title))) {
        title = `${title} ${code}`;
      }
    }

    return title;
  }

  normalizeQuality(quality: unknown): string | undefined {
    if (typeof quality !== 'string') {
      return undefined;
    }

    const trimmed = quality.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/\b(4k|UHD|2160p)\b/i.test(trimmed)) return '4K';
    if (/\b(FHD|FULLHD)\b/i.test(trimmed)) return '1080p';
    if (/\bSD\b/i.test(trimmed)) return '480p';

    const match = trimmed.match(/(\d{3,4}p)/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }

    return trimmed.replace(/\s+/g, ' ');
  }

  formatAudioLine(torrent: TorrentLike): string | undefined {
    const languages = this.extractAudioLanguages(torrent);
    if (languages.length === 0) {
      return undefined;
    }

    const decorated = languages.map((language) => this.mapLanguageToDisplay(language));


    return `${decorated.join(' / ')}`;
  }

  extractAudioLanguages(torrent: TorrentLike): string[] {
    const record = torrent as Record<string, unknown>;

    // audio[] do torrent-indexer já vem resolvido; sozinho ele basta.
    const fromAudio = languagesFromAudioValues([
      record.audio,
      record.audios,
      record.audio_tracks,
      record.audioTracks,
      record.audio_languages,
      record.audioLanguages,
      record.languages,
      record.language,
      record.lang,
    ]);
    // Nome do release só (sem original_title): original_title é o título da página ("... Dual Áudio") e vale
    // para todos os torrents dela, inclusive releases scene só em inglês; sinopse, slug e categoria idem.
    const releaseText = [record.title, record.name, record.filename, record.release, record.file]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(stripAudioSuffix)
      .join(' ');

    // audio[] vence, mas é conferido com o nome: a fonte às vezes marca Português num release legendado.
    if (fromAudio.length > 0) {
      return reconcileAudioWithRelease(fromAudio, releaseText);
    }

    // Fallback só pelo nome do release.
    return detectReleaseLanguages(releaseText);
  }

  extractFilesFromTorrent(torrent: TorrentLike): IndexedTorrentFile[] {
    const filesRaw = (torrent as Record<string, unknown>).files;
    if (!Array.isArray(filesRaw)) {
      return [];
    }

    const files: IndexedTorrentFile[] = [];
    for (let i = 0; i < filesRaw.length; i++) {
      const entry = filesRaw[i];
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const pathCandidate = this.toString(record.path) || this.toString(record.name) || this.toString(record.file);
      if (!pathCandidate || !pathCandidate.trim()) continue;

      // size_bytes (número exato do torrent-indexer) antes de size, que vem formatado ("1.2 GB")
      const sizeRaw = record.size_bytes ?? record.sizeBytes ?? record.size ?? record.bytes;
      const size = this.toBytes(sizeRaw);
      files.push({ path: pathCandidate.trim(), size, originalIndex: i });
    }

    return files;
  }

  toBytes(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const numeric = Number(trimmed.replace(/[^0-9.]/g, ''));
    if (Number.isNaN(numeric)) {
      return undefined;
    }

    if (/\b(tb|terabyte)/i.test(trimmed)) return Math.round(numeric * 1024 * 1024 * 1024 * 1024);
    if (/\b(gb|gigabyte)/i.test(trimmed)) return Math.round(numeric * 1024 * 1024 * 1024);
    if (/\b(mb|megabyte)/i.test(trimmed)) return Math.round(numeric * 1024 * 1024);
    if (/\b(kb|kilobyte)/i.test(trimmed)) return Math.round(numeric * 1024);
    return Math.round(numeric);
  }

  isVideoPath(path: string): boolean {
    return /\.(mkv|mp4|avi|m4v|ts|m2ts|mov|wmv|flv|webm|mpg|mpeg|iso)$/i.test(path);
  }

  mapLanguageToDisplay(language: string): string {
    const key = this.normalizeLanguageKey(language);
    return LANGUAGE_FLAG_MAP[key] ?? language;
  }

  normalizeLanguageKey(language: string): string {
    return language
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  extractDetailUrl(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.details),
      this.toString(record.detail_url),
      this.toString(record.detailUrl),
      this.toString(record.page),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const normalized = this.normalizeToUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

  extractFileName(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.filename),
      this.toString(record.file),
      this.toString(record.path),
      this.toString(record.name),
      this.toString(record.title)
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }

      return trimmed;
    }

    return undefined;
  }

  static readonly SITE_LABEL_MAP: Record<string, string> = {
    'comando.la': 'Comando',
    'comando.to': 'Comando',
    'comandofilmes.net': 'Comando',
    'comandotorrents.com': 'Comando',
    'bludv.xyz': 'BluDV',
    'bludv1.xyz': 'BluDV',
    'bludv.org': 'BluDV',
    'bludv.net': 'BluDV',
    'bludv-v1.xyz': 'BluDV',
    'bludv.tv': 'BluDV',
    'bludv.in': 'BluDV',
    'redetorrent.com': 'Rede Torrent',
    'vacatorrent.com': 'Vaca Torrent',
    'vacatorrentmov.com': 'Vaca Torrent',
    'lapumia.org': 'LAPUMiA',
    'ondebaixa.com': 'Onde Baixa',
    'torrentdosfilmes.se': 'Torrent dos Filmes',
    'torrentdosfilmes.net': 'Torrent dos Filmes',
    'torrentdosfilmes.com': 'Torrent dos Filmes',
    'torrentdosfilmes.tv': 'Torrent dos Filmes',
    'torrentdosfilmes.site': 'Torrent dos Filmes',
    'thepiratefilmes.com': 'The Pirate Filmes',
    'starckfilmes.com': 'Starck Filmes',
    'torrentmovies.co': 'Torrent Movies',
    'sitedetorrents.com': 'Site de Torrents',
    'ytsbr.com': 'YTSBR',
    'limaotorrent.org': 'Limão Torrent',
    'baixarfilmetorrent.net': 'Baixar Filme',
    'thepiratebay.org': 'TPB',
    'rarbg.to': 'RARBG',
    '1337x.to': '1337x',
    'nyaa.si': 'Nyaa',
    'yts.mx': 'YTS',
  };

  extractSourceDomain(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidates = [
      this.toString(record.details),
      this.toString(record.detail_url),
      this.toString(record.detailUrl),
      this.toString(record.page),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const hostname = this.parseHostname(candidate);
      if (hostname) {
        // Normalize known site hostnames with versioned subdomains
        const baseHost = hostname.replace(/^(www\.)?/, '').replace(/-v\d+/, '').replace(/\d+\./, '.');
        const mapped = TorrentParser.SITE_LABEL_MAP[hostname]
          ?? TorrentParser.SITE_LABEL_MAP[baseHost];
          
        if (mapped) return mapped;
        
        const domainParts = baseHost.split('.');
        const mainPart = domainParts[0];
        if (mainPart && mainPart.length > 2) {
          return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
        }
        
        return hostname;
      }
    }

    return undefined;
  }

  normalizeToUrl(raw: string): string | undefined {
    let candidate = raw.trim();
    if (!candidate) {
      return undefined;
    }

    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    try {
      const url = new URL(candidate);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  parseHostname(raw: string): string | undefined {
    let candidate = raw.trim();
    if (!candidate) {
      return undefined;
    }

    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    try {
      const url = new URL(candidate);
      const hostname = url.hostname.replace(/^www\./i, '');
      if (hostname) {
        return hostname.toLowerCase();
      }
    } catch {
      // Ignore invalid URLs
    }

    return undefined;
  }

  extractIndexerName(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.indexer ||
      record.indexerName ||
      record.indexer_name ||
      record.source ||
      record.provider ||
      record.origin ||
      record.site;

    if (typeof candidate === 'string' && candidate.trim()) {
      const val = candidate.trim();
      
      // Se parecer uma URL ou domínio, tenta tratar como tal primeiro
      if (val.includes('.') || val.includes('/') || val.includes(':')) {
        const hostname = this.parseHostname(val);
        if (hostname) {
          const baseHost = hostname.replace(/^(www\.)?/, '').replace(/-v\d+/, '').replace(/\d+\./, '.');
          const mapped = TorrentParser.SITE_LABEL_MAP[hostname]
            ?? TorrentParser.SITE_LABEL_MAP[baseHost];
            
          if (mapped) return mapped;
          
          const mainPart = baseHost.split('.')[0];
          if (mainPart && mainPart.length > 2) {
            return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
          }
        }
      }

      const sanitized = this.sanitizeQuery(val) ?? val;
      return this.titleize(sanitized);
    }

    return undefined;
  }

  formatSize(size: number): string {
    if (!Number.isFinite(size) || size <= 0) {
      return 'Unknown size';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = size;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    if (unitIndex === 0) {
      return `${Math.round(value)} ${units[unitIndex]}`;
    }

    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  extractMagnet(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const magnet =
      this.toString(record.magnet_link) ||
      this.toString(record.magnet) ||
      this.toString(record.url) ||
      this.toString(record.link);

    if (magnet && magnet.startsWith('magnet:')) {
      return magnet;
    }

    return undefined;
  }

  extractTitle(torrent: TorrentLike): string | undefined {
    const record = torrent as Record<string, unknown>;
    const title =
      this.toString(record.title) ||
      this.toString(record.original_title) ||
      this.toString(record.name) ||
      this.toString(record.filename) ||
      this.toString(record.release) ||
      this.toString(record.file) ||
      this.toString(record.slug) ||
      this.toString(record.displayName);

    if (title && title.trim()) {
      return title.trim();
    }

    return undefined;
  }

  extractInfoHash(magnet: string): string | undefined {
    const match = magnet.match(/btih:([^&]+)/i);
    return match?.[1];
  }

  /**
   * Clean dirty titles from Brazilian indexer sites.
   * Removes site slug prefixes, double dots, duplicate extensions, etc.
   */
  cleanIndexerTitle(title: string): string {
    let cleaned = title;

    // Remove [EVITE.COPIAS...] and similar bracketed spam prefixes
    cleaned = cleaned.replace(/^\[(?:EVITE|BAIXE|DOWNLOAD|WWW)[^\]]*\]\s*/gi, '');

    // Remove "EVITE.COPIAS.BAIXE.NO." prefix without brackets
    cleaned = cleaned.replace(/^EVITE\.COPIAS\.[^.]*\./i, '');

    // Remove known site prefixes that get concatenated into titles
    cleaned = cleaned.replace(/^(SITEDETORRENTS\.COM\.?|WWW\.BLUDV\.(COM|TV|IN)\.?|BLUDV\.(COM|TV|IN)\.?|WWW\.THEPIRATEFILMES\.COM\.?|THEPIRATEFILMES\.COM\.?|YTSBR\.COM\.?|WWW\.COMANDOTORRENTS\.COM\.?|COMANDOTORRENTS\.COM\.?)/gi, '');

    // Remove leading dots/dashes/underscores/spaces
    cleaned = cleaned.replace(/^[.\-_\s]+/, '');

    // Brazilian indexer slug pattern: metadata-prefix separated by ".." from the actual title
    const doubleDotIdx = cleaned.indexOf('..');
    if (doubleDotIdx > 0) {
      const afterDoubleDot = cleaned.slice(doubleDotIdx).replace(/^\.+/, '');
      if (afterDoubleDot && /^[A-Za-z]/.test(afterDoubleDot)) {
        cleaned = afterDoubleDot;
      }
    }

    // Remove duplicate extensions like .MKV.MKV., .MP4.MP4.
    cleaned = cleaned.replace(/\.(MKV|MP4|AVI|M4V|TS)\.\1\./gi, '.$1.');

    // Remove trailing file extension for display
    cleaned = cleaned.replace(/\.(mkv|mp4|avi|m4v|ts|m2ts|iso)$/i, '');

    // Remove orphaned parenthetical language tags from the indexer
    cleaned = cleaned.replace(/\s*\((brazilian|eng|portuguese|portugues|english|spanish|espanhol|dublado|legendado|nacional)(?:\s*,\s*(brazilian|eng|portuguese|portugues|english|spanish|espanhol|dublado|legendado|nacional))*\)\s*$/i, '');

    // Clean up ugly slug patterns: .-LEGENDADO-., .-DUBLADO-.
    cleaned = cleaned.replace(/\.-([A-Z]+)-\./g, ' $1 ');

    // Remove trailing site domain junk like "-comando.la" or "-WWW.COMANDOTORRENTS.COM"
    cleaned = cleaned.replace(/[-.](?:www\.)?(?:comando(?:torrents|filmes)?\.(?:la|com|net)|bludv\.[a-z]+|thepiratefilmes\.com|sitedetorrents\.com)$/i, '');

    // Collapse multiple dots/spaces
    cleaned = cleaned.replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();

    // Remove leading dots/dashes/underscores after all cleaning
    cleaned = cleaned.replace(/^[.\-_\s]+/, '');

    return cleaned || title;
  }

  /**
   * Parse size strings like "4.06 GB", "19.72 GB", "711 MB" into bytes.
   */
  parseSizeString(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const numOnly = parseFloat(trimmed);
    if (!isNaN(numOnly) && !/[a-zA-Z]/.test(trimmed)) {
      return Math.round(numOnly);
    }

    const match = trimmed.match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B)/i);
    if (!match || !match[1] || !match[2]) return undefined;

    // Sites BR escrevem "1,5 GB".
    const num = parseFloat(match[1].replace(',', '.'));
    if (isNaN(num)) return undefined;

    const unit = match[2].toUpperCase();
    switch (unit) {
      case 'TB': return Math.round(num * 1024 * 1024 * 1024 * 1024);
      case 'GB': return Math.round(num * 1024 * 1024 * 1024);
      case 'MB': return Math.round(num * 1024 * 1024);
      case 'KB': return Math.round(num * 1024);
      default: return Math.round(num);
    }
  }

  extractSeeders(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.seeders ??
      record.seed ??
      record.seeds ??
      record.seedCount ??
      record.seed_count ??
      record.peers ??
      record.peer ??
      record.peerCount;

    return this.toNumber(candidate);
  }

  extractSize(torrent: TorrentLike): number | undefined {
    const record = torrent as Record<string, unknown>;
    const candidate =
      record.size ??
      record.sizeBytes ??
      record.size_bytes ??
      record.bytes ??
      record.filesize ??
      record.length ??
      record.totalSize;

    if (typeof candidate === 'number') {
      return candidate;
    }

    return this.parseSizeString(candidate);
  }

  inferQualityFromTitle(title: string): string | undefined {
    const match = title.match(/(4k|UHD|2160p|1440p|FHD|FULLHD|1080p|HD|720p|480p|360p)/i);
    if (match?.[1]) {
      const q = match[1].toLowerCase();
      if (q === '4k' || q === 'uhd') return '4K';
      if (q === 'fhd' || q === 'fullhd') return '1080p';
      if (q === 'hd') return '720p';
      return q;
    }

    // Fallback: infer from source tag when no explicit resolution
    if (/\b(blu[\s.-]?ray|bdrip|bdremux|remux)\b/i.test(title)) return '1080p';
    if (/\b(web[\s.-]?dl|webrip)\b/i.test(title)) return '720p';
    if (/\b(hdtv|hdrip)\b/i.test(title)) return '720p';
    if (/\b(dvdrip|dvdscr)\b/i.test(title)) return '480p';
    if (/\b(cam|hdcam|telesync|telecine)\b/i.test(title)) return 'CAM';

    return undefined;
  }

  normalizeTorrentPayload(payload: unknown): TorrentLike[] {
    let items: TorrentLike[] = [];
    if (!payload) {
      return items;
    }

    if (Array.isArray(payload)) {
      items = payload as TorrentLike[];
    } else if (typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const possibleKeys = ['results', 'data', 'items', 'torrents', 'entries'];
      for (const key of possibleKeys) {
        const value = record[key];
        if (Array.isArray(value)) {
          items = value as TorrentLike[];
          break;
        }
      }
      if (items.length === 0 && record.torrent) {
        items = [record.torrent as TorrentLike];
      }
    }

    // ── Bypass Adware / Decodificador Base64 (BLUDV) ──
    for (const item of items) {
      if (!item) continue;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === 'string' ? rec.url : (typeof rec.link === 'string' ? rec.link : undefined);
      const magnet = rec.magnet;

      if (url && !magnet && url.includes('get.php?id=')) {
        if (/systemads\.org|superadsgo\.xyz|superadsgo1\.xyz|systemads\.xyz|seuvideo\.xyz/.test(url)) {
          try {
            const urlObj = new URL(url);
            const idVal = urlObj.searchParams.get('id');
            if (idVal) {
              const reversedId = idVal.split('').reverse().join('');
              const decoded = Buffer.from(reversedId, 'base64').toString('utf-8');
              if (decoded.startsWith('magnet:')) {
                rec.magnet = decoded;
              } else if (decoded.startsWith('http')) {
                rec.url = decoded;
              }
            }
          } catch (e) {
            // Ignorar erro de parse e seguir com o link original
          }
        }
      }
    }

    return items;
  }

  sanitizeQuery(raw: string | undefined): string | undefined {
    if (!raw) {
      return undefined;
    }

    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }

    // Strip out parenthesis metadata like (eng) or (brazilian, eng)
    const withoutParenthesis = decoded.replace(/\s*\([^)]*\)/g, '');
    const cleaned = withoutParenthesis.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return undefined;
    }

    return cleaned;
  }

  titleize(value: string): string {
    return value
      .split(' ')
      .filter((part) => part.trim().length > 0)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ');
  }

  toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.replace(/[^0-9.-]/g, ''));
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  toString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return undefined;
  }
}
