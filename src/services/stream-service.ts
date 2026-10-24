/**
 * Stream Service
 */

import type { DebridProvider } from '../models/debrid-model.js';
import type { SourceStream, StreamContext } from '../models/source-model.js';
import type { StremioStream, StremioStreamBehaviorHints } from '../models/stream-model.js';
import { detectReleaseLanguages } from './audio-language.js';

const LANGUAGE_DISPLAY_ALIASES: Record<string, string> = {
  portuguese: 'Portuguese',
  portugues: 'Portuguese',
  'pt-br': 'Portuguese',
  'pt br': 'Portuguese',
  ptbr: 'Portuguese',
  brazilian: 'Portuguese',
  'brazilian portuguese': 'Portuguese',
  dublado: 'Portuguese',
  dublada: 'Portuguese',
  english: 'English',
  ingles: 'English',
  eng: 'English',
  en: 'English',
  spanish: 'Spanish',
  espanhol: 'Spanish',
  espanol: 'Spanish',
  spa: 'Spanish',
  es: 'Spanish',
  castellano: 'Spanish',
  latino: 'Spanish',
  french: 'French',
  frances: 'French',
  fre: 'French',
  fra: 'French',
  fr: 'French',
  italian: 'Italian',
  italiano: 'Italian',
  ita: 'Italian',
  it: 'Italian',
  german: 'German',
  alemao: 'German',
  ger: 'German',
  deu: 'German',
  de: 'German',
  japanese: 'Japanese',
  japones: 'Japanese',
  jpn: 'Japanese',
  ja: 'Japanese',
  korean: 'Korean',
  coreano: 'Korean',
  kor: 'Korean',
  ko: 'Korean',
  chinese: 'Chinese',
  chines: 'Chinese',
  mandarin: 'Chinese',
  mandarim: 'Chinese',
  chi: 'Chinese',
  zho: 'Chinese',
  zh: 'Chinese',
  russian: 'Russian',
  russo: 'Russian',
  rus: 'Russian',
  ru: 'Russian',
  hindi: 'Hindi',
  hin: 'Hindi',
  hi: 'Hindi',
  arabic: 'Arabic',
  arabe: 'Arabic',
  turkish: 'Turkish',
  turco: 'Turkish',
  tur: 'Turkish',
  tr: 'Turkish',
  polish: 'Polish',
  polones: 'Polish',
  pol: 'Polish',
  pl: 'Polish',
  dutch: 'Dutch',
  holandes: 'Dutch',
  nld: 'Dutch',
  nl: 'Dutch',
  swedish: 'Swedish',
  sueco: 'Swedish',
  swe: 'Swedish',
  sv: 'Swedish',
  norwegian: 'Norwegian',
  noruegues: 'Norwegian',
  nor: 'Norwegian',
  no: 'Norwegian',
  danish: 'Danish',
  dinamarques: 'Danish',
  dan: 'Danish',
  da: 'Danish',
  finnish: 'Finnish',
  finlandes: 'Finnish',
  fin: 'Finnish',
  fi: 'Finnish',
  czech: 'Czech',
  tcheco: 'Czech',
  ces: 'Czech',
  cs: 'Czech',
  hungarian: 'Hungarian',
  hungaro: 'Hungarian',
  hun: 'Hungarian',
  hu: 'Hungarian',
  ukrainian: 'Ukrainian',
  ucraniano: 'Ukrainian',
  ukr: 'Ukrainian',
  uk: 'Ukrainian'
};

interface StreamMetadataOptions {
  fallbackMagnet?: string;
  forceNotWebReady?: boolean;
  realDebridReady?: boolean;
  torboxReady?: boolean;
  debridProvider?: DebridProvider;
  /** true quando a URL resolve via debrid (há token); padrão: qualquer URL que não seja magnet */
  viaDebrid?: boolean;
}

export class StreamService {
  static createStreamMetadata(
    sourceStream: SourceStream,
    url: string,
    options?: StreamMetadataOptions
  ): StremioStream {
    const displayFileName = StreamService.pickDisplayFileName(sourceStream);
    const fallbackTitle = displayFileName || sourceStream.title || 'Unknown file';
    const displayTitle = displayFileName || sourceStream.title || fallbackTitle;
    const normalizedLanguages = StreamService.detectLanguages(sourceStream);
    const debridProvider = options?.debridProvider ?? 'realdebrid';
    const rdReady = options?.realDebridReady ?? sourceStream.cached ?? false;
    const tbReady = options?.torboxReady ?? sourceStream.cached ?? false;
    const isReady = debridProvider === 'torbox' ? tbReady : rdReady;
    const providerLabel = debridProvider === 'torbox' ? 'TB' : 'RD';
    const readyLabel =
      debridProvider === 'torbox'
        ? isReady
          ? `${providerLabel}+`
          : `${providerLabel}⏳`
        : isReady
          ? `${providerLabel}+`
          : providerLabel;
    let formattedTitle = displayTitle;
    if (formattedTitle.includes('/')) {
      const parts = formattedTitle.split('/');
      const fileName = parts.pop();
      const folderPath = parts.join('/');
      formattedTitle = `📂 ${folderPath}\n📄 ${fileName}`;
    }

    const langFlags = StreamService.buildLanguageTag(normalizedLanguages);
    const flagString = langFlags ? ` ${langFlags}` : '';
    const baseName = sourceStream.name || `[GuIndex] ${displayTitle}`;
    const providerName = 'GuIndex';
    // Sem token a URL é o magnet (P2P): o rótulo [RD]/[TB] faria o parser do AIOStreams
    // tratar o stream como debrid.
    const viaDebrid = options?.viaDebrid ?? !url.startsWith('magnet:');
    const labelPrefix = viaDebrid ? `[${readyLabel}]` : '';
    
    let displayName = '';
    if (debridProvider === 'torbox') {
      displayName = `${labelPrefix}${flagString} ${StreamService.buildTorboxName(sourceStream, displayTitle)}`.trim();
    } else {
      const qualityStr = sourceStream.quality || 'Unknown';
      displayName = `${labelPrefix ? `${labelPrefix} ` : ''}${providerName}${flagString}\n${qualityStr}`;
    }

    // Build rich description
    const richInfo: string[] = [];
    if (sourceStream.contextString) {
      richInfo.push(`📌 ${sourceStream.contextString}`);
    }
    const mediaInfo: string[] = [];
    if (sourceStream.videoQuality) mediaInfo.push(`📺 Vídeo: ${sourceStream.videoQuality}`);
    if (sourceStream.audioQuality) mediaInfo.push(`🎧 Áudio: ${sourceStream.audioQuality}`);
    if (mediaInfo.length > 0) richInfo.push(mediaInfo.join(' | '));
    
    if (sourceStream.genres && sourceStream.genres.length > 0) {
      richInfo.push(`🎭 ${sourceStream.genres.join(', ')}`);
    }
    if (sourceStream.subtitles && sourceStream.subtitles.length > 0) {
      richInfo.push(`🔤 Legendas: ${sourceStream.subtitles.join(', ')}`);
    }
    
    const extraInfo: string[] = [];
    if (sourceStream.duration) extraInfo.push(`⏱️ ${sourceStream.duration}`);
    if (sourceStream.classification) extraInfo.push(`🔞 ${sourceStream.classification}`);
    if (extraInfo.length > 0) richInfo.push(extraInfo.join(' | '));

    const metadata: StremioStream = {
      name: displayName,
      title: formattedTitle,
      url
    };

    if (richInfo.length > 0) {
      metadata.title = `${formattedTitle}\n\n${richInfo.join('\n')}`;
    }

    const infoHash = StreamService.extractInfoHash(sourceStream);
    // Também no link de resolve do debrid: o AIOStreams deduplica por hash:fileIdx e o
    // Reconfigure Service só atua em streams debrid com infoHash.
    if (infoHash) {
      metadata.infoHash = infoHash;
    }
    if (sourceStream.size != undefined) {
      metadata.size = sourceStream.size;
    }
    if (sourceStream.seeders != undefined) {
      metadata.seeders = sourceStream.seeders;
    }
    if (sourceStream.fileIdx != undefined && sourceStream.fileIdx >= 0) {
      metadata.fileIdx = sourceStream.fileIdx;
    }
    if (sourceStream.quality) {
      metadata.quality = sourceStream.quality;
    }
    if (normalizedLanguages.length > 0) {
      metadata.languages = normalizedLanguages;
    }

    const behaviorHints: StremioStreamBehaviorHints = {};
    const shouldForceNotWebReady = options?.forceNotWebReady ?? true;
    if (sourceStream.size != undefined) {
      behaviorHints.videoSize = sourceStream.size;
    }

    if (debridProvider === 'torbox') {
      behaviorHints.torboxReady = isReady;
      if (!isReady) {
        behaviorHints.notWebReady = true;
      }
    } else {
      if (shouldForceNotWebReady) {
        behaviorHints.notWebReady = true;
      }
      behaviorHints.realDebridReady = isReady;
    }

    // bingeGroup must be set for ALL providers so Stremio "next episode" works
    const bingeGroup = StreamService.buildBingeGroup(sourceStream, debridProvider);
    if (bingeGroup) {
      behaviorHints.bingeGroup = bingeGroup;
    }

    if (options?.fallbackMagnet && debridProvider !== 'torbox') {
      behaviorHints.fallbackMagnet = options.fallbackMagnet;
    }

    const sourceLabelMeta = StreamService.pickIndexer(sourceStream, behaviorHints, url);
    if (sourceLabelMeta) metadata.indexer = sourceLabelMeta;

    // O AIOStreams só lê estes campos de behaviorHints; no topo eles ficam invisíveis para seeders()/indexer()/age().
    if (sourceStream.seeders != undefined) {
      behaviorHints.seeders = sourceStream.seeders;
    }
    if (sourceLabelMeta) {
      behaviorHints.indexer = sourceLabelMeta;
    }
    if (sourceStream.publishDate) {
      behaviorHints.publishDate = sourceStream.publishDate;
    }
    if (sourceStream.folderName) {
      behaviorHints.folderName = sourceStream.folderName;
      metadata.folderName = sourceStream.folderName;
    }
    if (sourceStream.folderSize != undefined) {
      behaviorHints.folderSize = sourceStream.folderSize;
    }
    // Sem token a URL é o magnet (P2P): não há serviço de debrid para anunciar.
    if (viaDebrid) {
      behaviorHints.service = debridProvider;
      behaviorHints.cached = isReady;
    }

    // Nome cru: o parser do AIOStreams lê resolução/codec/idioma daqui, e o Stremio usa para legendas.
    const hintFileName = StreamService.pickHintFileName(sourceStream);
    if (hintFileName) {
      behaviorHints.filename = hintFileName;
      metadata.filename = hintFileName;
    }
    if (sourceLabelMeta) {
      metadata.releaseGroup = StreamService.sanitizeGroup(sourceLabelMeta);
    }

    metadata.behaviorHints = behaviorHints;
    return metadata;
  }

  private static readonly LANGUAGE_FLAG_MAP: Record<string, string> = {
    portugues: '🇧🇷', portuguese: '🇧🇷', 'brazilian portuguese': '🇧🇷',
    ingles: '🇺🇸', english: '🇺🇸',
    espanhol: '🇪🇸', spanish: '🇪🇸',
    frances: '🇫🇷', french: '🇫🇷',
    italiano: '🇮🇹', italian: '🇮🇹',
    alemao: '🇩🇪', german: '🇩🇪',
    japones: '🇯🇵', japanese: '🇯🇵',
    coreano: '🇰🇷', korean: '🇰🇷',
    chines: '🇨🇳', chinese: '🇨🇳', mandarim: '🇨🇳', mandarin: '🇨🇳',
    russo: '🇷🇺', russian: '🇷🇺',
    hindi: '🇮🇳'
  };

  private static buildLanguageTag(languages?: string[]): string | undefined {
    if (!languages || languages.length === 0) {
      return undefined;
    }

    const flags = languages
      .map((lang) => StreamService.LANGUAGE_FLAG_MAP[lang.toLowerCase()])
      .filter((flag): flag is string => Boolean(flag));

    if (flags.length === 0) {
      return undefined;
    }

    const unique = Array.from(new Set(flags));
    return unique.join(' ');
  }

  private static appendLanguageTag(value: string, tag: string): string {
    if (!value) {
      return value;
    }
    const marker = `[${tag}]`;
    if (value.includes(marker)) {
      return value;
    }
    return `${value} ${marker}`.trim();
  }

  private static normalizeLanguageKey(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private static normalizeLanguages(languages?: string[]): string[] {
    if (!Array.isArray(languages)) {
      return [];
    }

    const tagMap = new Map<string, string>();
    for (const language of languages) {
      if (typeof language !== 'string') {
        continue;
      }
      const trimmed = language.trim();
      if (!trimmed) {
        continue;
      }
      const key = StreamService.normalizeLanguageKey(trimmed);
      const canonical = LANGUAGE_DISPLAY_ALIASES[key] ?? trimmed;
      const canonicalKey = StreamService.normalizeLanguageKey(canonical);
      if (canonicalKey) {
        tagMap.set(canonicalKey, canonical);
      }
    }

    const ordered = Array.from(tagMap.values()).sort((a, b) => {
      const pa = StreamService.languagePriority(a);
      const pb = StreamService.languagePriority(b);
      if (pa !== pb) return pb - pa; // higher priority first
      return a.localeCompare(b);
    });

    return ordered;
  }

  private static languagePriority(value: string): number {
    const key = StreamService.normalizeLanguageKey(value);
    if (['portuguese', 'brazilian', 'pt-br', 'ptbr', 'pt'].includes(key)) return 100;
    if (['english', 'eng', 'en'].includes(key)) return 90;
    return 0;
  }

  private static detectLanguages(stream: SourceStream): string[] {
    // Idiomas que a fonte já resolveu (audio[] do torrent-indexer) valem sozinhos.
    const fromSource = StreamService.normalizeLanguages(stream.languages);
    if (fromSource.length > 0) {
      return fromSource;
    }

    // Fallback: só o nome do release. Sinopse, URL e contexto da busca geravam falsos positivos.
    const releaseName = `${stream.fileName ?? ''} ${StreamService.pickFirstLine(stream.title) ?? ''}`;
    return StreamService.normalizeLanguages(detectReleaseLanguages(releaseName));
  }

  private static buildLanguageCodes(languages: string[]): string[] {
    const hasPt = languages.some((l) => ['portuguese', 'brazilian', 'pt-br', 'ptbr', 'pt','dublado'].includes(StreamService.normalizeLanguageKey(l)));
    const hasEn = languages.some((l) => ['english', 'eng', 'en'].includes(StreamService.normalizeLanguageKey(l)));
    const hasEs = languages.some((l) => ['spanish', 'espanol', 'español', 'es'].includes(StreamService.normalizeLanguageKey(l)));
    const hasFr = languages.some((l) => ['french', 'frances', 'fr'].includes(StreamService.normalizeLanguageKey(l)));
    const hasIt = languages.some((l) => ['italian', 'italiano', 'it'].includes(StreamService.normalizeLanguageKey(l)));
    const hasDe = languages.some((l) => ['german', 'alemao', 'de'].includes(StreamService.normalizeLanguageKey(l)));
    const hasJa = languages.some((l) => ['japanese', 'japones', 'jp'].includes(StreamService.normalizeLanguageKey(l)));
    const hasKo = languages.some((l) => ['korean', 'coreano', 'kr', 'ko'].includes(StreamService.normalizeLanguageKey(l)));
    const hasZh = languages.some((l) => ['chinese', 'chines', 'zh', 'mandarin'].includes(StreamService.normalizeLanguageKey(l)));
    const hasRu = languages.some((l) => ['russian', 'russo', 'ru'].includes(StreamService.normalizeLanguageKey(l)));
    const hasHi = languages.some((l) => ['hindi', 'hi'].includes(StreamService.normalizeLanguageKey(l)));

    const codes: string[] = [];
    if (hasPt) codes.push('PT');
    if (hasEn) codes.push('EN');
    if (hasEs) codes.push('ES');
    if (hasFr) codes.push('FR');
    if (hasIt) codes.push('IT');
    if (hasDe) codes.push('DE');
    if (hasJa) codes.push('JA');
    if (hasKo) codes.push('KO');
    if (hasZh) codes.push('ZH');
    if (hasRu) codes.push('RU');
    if (hasHi) codes.push('HI');
    return codes;
  }

  private static extractInfoHash(stream: SourceStream): string | undefined {
    if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
      return stream.infoHash.trim().toLowerCase();
    }

    const magnet = stream.magnet || (stream.url?.startsWith('magnet:') ? stream.url : undefined);
    if (!magnet) return undefined;

    const match = magnet.match(/xt=urn:btih:([^&]+)/i);
    if (!match?.[1]) return undefined;
    return match[1].trim().toLowerCase();
  }

  private static sanitizeGroup(group?: string): string | undefined {
    if (!group) return undefined;
    const trimmed = group.trim().replace(/^www\./i, '');
    if (!trimmed) return undefined;
    const base = trimmed.split('.')[0] || trimmed;
    const cleaned = base.replace(/[^A-Za-z0-9_-]/g, '');
    return cleaned || undefined;
  }

  private static pickReleaseGroup(value?: string): string | undefined {
    if (!value) return undefined;
    const basename = value
      .replace(/[/\\]+/g, '/')
      .split('/')
      .pop() ?? value;
    const noExt = basename.replace(/\.[a-z0-9]{2,4}$/i, '');
    const parts = noExt.split('-');
    if (parts.length < 2) return undefined;
    const candidate = parts[parts.length - 1]?.trim();
    if (candidate && /^[A-Za-z0-9]{2,15}$/.test(candidate)) {
      return candidate;
    }
    return undefined;
  }

  private static pickIndexer(
    stream: SourceStream,
    behaviorHints: StremioStreamBehaviorHints | undefined,
    url: string
  ): string | undefined {
    if (stream.indexer && stream.indexer.trim()) {
      return stream.indexer.trim();
    }

    if (stream.source && stream.source.trim()) {
      return stream.source.trim();
    }

    if (behaviorHints?.bingeGroup) {
      const parts = behaviorHints.bingeGroup.split('|');
      if (parts[0]) return parts[0];
    }

    const host =
      StreamService.extractHost(stream.detailUrl) ||
      StreamService.extractHost(stream.url) ||
      StreamService.extractHost(url);
    if (host) return host;

    return undefined;
  }

  private static extractHost(raw?: string): string | undefined {
    if (!raw) return undefined;
    try {
      const u = new URL(raw);
      return u.hostname.replace(/^www\./i, '');
    } catch {
      return undefined;
    }
  }

  private static buildBingeGroup(stream: SourceStream, provider: DebridProvider): string | undefined {
    const hash = stream.infoHash?.trim();
    const source = stream.source?.trim();
    if (!hash || !source) {
      return undefined;
    }

    return `${source.toLowerCase()}|${provider}|${hash.toLowerCase()}`;
  }

  private static buildTorboxName(stream: SourceStream, fallbackTitle: string): string {
    const source = stream.source?.trim();
    const quality = stream.quality?.trim();
    if (source && quality) {
      return `${source} ${quality}`;
    }
    if (source) {
      return source;
    }
    if (quality) {
      return quality;
    }
    return fallbackTitle;
  }

  private static pickDisplayFileName(stream: SourceStream): string | undefined {
    const direct = stream.fileName?.trim();
    if (direct) {
      return direct;
    }
    return StreamService.pickFirstLine(stream.title);
  }

  /** Nome cru para behaviorHints.filename: com extensão, sem idioma/tamanho/indexador anexados. */
  private static pickHintFileName(stream: SourceStream): string | undefined {
    const raw = stream.rawFileName?.trim();
    if (raw) {
      return raw;
    }
    const display = StreamService.pickDisplayFileName(stream);
    return display ? display.replace(/^.*[\\/]/, '') || undefined : undefined;
  }

  private static pickFirstLine(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    const lines = value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines[0];
  }

  private static buildTorboxDescription(stream: SourceStream): string | undefined {
    const lines: string[] = [];
    const fileName = StreamService.pickDisplayFileName(stream);
    if (fileName) {
      lines.push(`File: ${fileName}`);
    }

    const titleLine = StreamService.pickFirstLine(stream.title);
    if (titleLine && titleLine != fileName) {
      lines.push(`Title: ${titleLine}`);
    }

    if (stream.quality) {
      lines.push(`Quality: ${stream.quality}`);
    }
    if (stream.releaseGroup) {
      lines.push(`Group: ${stream.releaseGroup}`);
    }
    if (stream.size != undefined) {
      lines.push(`Size: ${StreamService.formatBytes(stream.size)}`);
    }
    if (stream.seeders != undefined) {
      lines.push(`Seeders: ${Math.max(0, Math.floor(stream.seeders))}`);
    }
    if (Array.isArray(stream.languages) && stream.languages.length > 0) {
      lines.push(`Languages: ${stream.languages.join(', ')}`);
    }
    if (stream.source) {
      lines.push(`Source: ${stream.source}`);
    }

    const link = StreamService.sanitizeExternalUrl(stream.detailUrl ?? stream.url);
    if (link) {
      lines.push(`Link: ${link}`);
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private static formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  private static sanitizeExternalUrl(url?: string): string | undefined {
    if (!url) {
      return undefined;
    }

    const trimmed = url.trim();
    if (!trimmed) {
      return undefined;
    }

    if (!/^https?:\/\//i.test(trimmed)) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed);
      const path = parsed.pathname.toLowerCase();
      if (path.includes('/resolve') || path.includes('/playback')) {
        return undefined;
      }
      if (parsed.searchParams.has('magnet') || parsed.searchParams.has('linkType')) {
        return undefined;
      }

      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|apikey|api_key|rdtoken|tbtoken|torbox|realdebrid|debrid/i.test(key)) {
          parsed.searchParams.delete(key);
        }
      }

      parsed.username = '';
      parsed.password = '';
      parsed.protocol = 'https:';
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  static encodeStreamContext(context?: StreamContext): string | undefined {
    if (!context) {
      return undefined;
    }

    try {
      const json = JSON.stringify(context);
      if (!json) {
        return undefined;
      }

      const buffer = Buffer.from(json, 'utf-8');
      const base64 = buffer.toString('base64');
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch {
      return undefined;
    }
  }

  static decodeStreamContext(encoded?: string): StreamContext | undefined {
    if (!encoded) {
      return undefined;
    }

    try {
      let normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      while (normalized.length % 4 !== 0) {
        normalized += '=';
      }

      const buffer = Buffer.from(normalized, 'base64');
      const json = buffer.toString('utf-8');
      if (!json) {
        return undefined;
      }

      const context = JSON.parse(json) as StreamContext;
      return context;
    } catch {
      return undefined;
    }
  }

  static extractRealDebridToken(
    query: any,
    headers: any,
    extra?: { realdebridToken?: string; token?: string },
    params?: { token?: string }
  ): string | undefined {
    const token =
      query.realdebridToken ||
      query.rdToken ||
      query.token ||
      headers['x-rd-token'] ||
      extra?.realdebridToken ||
      extra?.token ||
      params?.token;

    // Validate token length using the typical Real-Debrid size to avoid accidental short inputs
    if (token && token.length > 20) {
      return token;
    }
    return undefined;
  }

  static extractTorboxToken(
    query: any,
    headers: any,
    extra?: { torboxToken?: string; token?: string },
    params?: { token?: string }
  ): string | undefined {
    const token =
      query.torboxToken ||
      query.tbToken ||
      query.token ||
      headers['x-tb-token'] ||
      headers['x-torbox-token'] ||
      extra?.torboxToken ||
      extra?.token ||
      params?.token;

    if (token && token.length > 10) {
      return token;
    }
    return undefined;
  }

  static extractDebridProvider(query: any, headers: any, extra?: { debridProvider?: string }): DebridProvider | undefined {
    const provider =
      query.debridProvider ||
      query.provider ||
      query.debrid ||
      headers['x-debrid-provider'] ||
      extra?.debridProvider;

    if (!provider || typeof provider !== 'string') {
      return undefined;
    }

    const normalized = provider.toLowerCase();
    if (normalized === 'torbox') {
      return 'torbox';
    }
    if (normalized === 'realdebrid' || normalized === 'real-debrid' || normalized === 'rd') {
      return 'realdebrid';
    }
    return undefined;
  }

  static resolveDebridSelection(params: {
    query: any;
    headers: any;
    extra?: { debridProvider?: string; realdebridToken?: string; torboxToken?: string; token?: string };
    routeParams?: { token?: string };
    env?: { realdebridToken?: string; torboxToken?: string };
  }): { provider?: DebridProvider; token?: string; realdebridToken?: string; torboxToken?: string } {
    const { query, headers, extra, routeParams, env } = params;
    const provider = this.extractDebridProvider(query, headers, extra);
    const realdebridToken =
      this.extractRealDebridToken(query, headers, extra, routeParams) || env?.realdebridToken;
    const torboxToken =
      this.extractTorboxToken(query, headers, extra, routeParams) || env?.torboxToken;

    if (provider === 'torbox') {
      return { provider, token: torboxToken, realdebridToken, torboxToken };
    }

    if (provider === 'realdebrid') {
      return { provider, token: realdebridToken, realdebridToken, torboxToken };
    }

    if (realdebridToken) {
      return { provider: 'realdebrid', token: realdebridToken, realdebridToken, torboxToken };
    }

    if (torboxToken) {
      return { provider: 'torbox', token: torboxToken, realdebridToken, torboxToken };
    }

    return { provider: provider, realdebridToken, torboxToken };
  }
}
