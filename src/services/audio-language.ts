/**
 * Idioma de áudio de releases BR.
 *
 * A fonte confiável é o audio[] estruturado do torrent-indexer. Texto livre só
 * entra como fallback e só com marcadores fortes: nomes em inglês, códigos de
 * 3 letras e as marcas BR (PT-BR, DUBLADO, NACIONAL). Códigos de 2 letras e
 * adjetivos em português ficam de fora porque aparecem em títulos: "Tropa de
 * Elite" virava alemão, "Já Era" japonês, "Casamento Grego" grego.
 */

export function normalizeLanguageText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function tokenize(value: string): string {
  return normalizeLanguageText(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

// Valor exato de um campo estruturado (já tokenizado) → nome canônico.
// Cobre os nomes que o torrent-indexer emite em schema/audio.go.
const AUDIO_VALUE_NAMES: Record<string, string> = {
  portugues: 'Portuguese',
  portuguese: 'Portuguese',
  'pt br': 'Portuguese',
  ptbr: 'Portuguese',
  brazilian: 'Portuguese',
  'brazilian portuguese': 'Portuguese',
  dublado: 'Portuguese',
  dublada: 'Portuguese',
  dub: 'Portuguese',
  nacional: 'Portuguese',
  'audio nacional': 'Portuguese',
  ingles: 'English',
  english: 'English',
  eng: 'English',
  espanhol: 'Spanish',
  espanol: 'Spanish',
  spanish: 'Spanish',
  castellano: 'Spanish',
  latino: 'Spanish',
  spa: 'Spanish',
  frances: 'French',
  french: 'French',
  fre: 'French',
  alemao: 'German',
  german: 'German',
  ger: 'German',
  italiano: 'Italian',
  italian: 'Italian',
  ita: 'Italian',
  japones: 'Japanese',
  japanese: 'Japanese',
  jpn: 'Japanese',
  coreano: 'Korean',
  korean: 'Korean',
  kor: 'Korean',
  mandarim: 'Chinese',
  mandarin: 'Chinese',
  chines: 'Chinese',
  chinese: 'Chinese',
  cantones: 'Cantonese',
  cantonese: 'Cantonese',
  russo: 'Russian',
  russian: 'Russian',
  rus: 'Russian',
  sueco: 'Swedish',
  swedish: 'Swedish',
  servio: 'Serbian',
  serbian: 'Serbian',
  ucraniano: 'Ukrainian',
  ukrainian: 'Ukrainian',
  polaco: 'Polish',
  polones: 'Polish',
  polish: 'Polish',
  tailandes: 'Thai',
  thai: 'Thai',
  turco: 'Turkish',
  turkish: 'Turkish',
  hindi: 'Hindi',
  hungaro: 'Hungarian',
  hungarian: 'Hungarian',
  persa: 'Persian',
  farsi: 'Persian',
  iraniano: 'Persian',
  persian: 'Persian',
  malaio: 'Malay',
  malay: 'Malay',
  holandes: 'Dutch',
  dutch: 'Dutch',
  finlandes: 'Finnish',
  finnish: 'Finnish',
  dinamarques: 'Danish',
  danish: 'Danish',
  noruegues: 'Norwegian',
  norwegian: 'Norwegian',
  islandes: 'Icelandic',
  icelandic: 'Icelandic',
  grego: 'Greek',
  greek: 'Greek',
  arabe: 'Arabic',
  arabic: 'Arabic',
  hebraico: 'Hebrew',
  hebrew: 'Hebrew',
  vietnamita: 'Vietnamese',
  vietnamese: 'Vietnamese',
  indonesio: 'Indonesian',
  indonesian: 'Indonesian',
  filipino: 'Filipino',
  bengali: 'Bengali',
  tamil: 'Tamil',
  telugu: 'Telugu',
  gujarati: 'Gujarati',
  marathi: 'Marathi',
};

// Marcadores aceitos em texto livre (nome de release já tokenizado).
const RELEASE_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(pt ?br|brazilian|portuguese|portugues|dublado|dublada|nacional)\b/, 'Portuguese'],
  [/\b(english|eng)\b/, 'English'],
  [/\b(spanish|castellano|latino|spa)\b/, 'Spanish'],
  [/\b(french|fre)\b/, 'French'],
  [/\b(italian|ita)\b/, 'Italian'],
  [/\b(german|ger)\b/, 'German'],
  [/\b(japanese|jpn)\b/, 'Japanese'],
  [/\b(korean|kor)\b/, 'Korean'],
  [/\b(chinese|mandarin)\b/, 'Chinese'],
  [/\b(russian|rus)\b/, 'Russian'],
  [/\bhindi\b/, 'Hindi'],
];

const DUAL_AUDIO_MARKER = /\b(dual|multi) ?audio\b/;

/** Idiomas de um nome de release usando só marcadores fortes. */
export function detectReleaseLanguages(releaseName: string): string[] {
  const text = tokenize(releaseName);
  if (!text) {
    return [];
  }

  const found = new Set<string>();
  for (const [pattern, language] of RELEASE_MARKERS) {
    if (pattern.test(text)) {
      found.add(language);
    }
  }

  // Em indexadores BR, "Dual Áudio" é quase sempre PT + EN.
  if (DUAL_AUDIO_MARKER.test(text)) {
    found.add('Portuguese');
    found.add('English');
  }

  return Array.from(found);
}

// Marcas de áudio em português e de legenda, para conferir o audio[] contra o nome do release.
const PT_AUDIO_MARKER = /\b(pt ?br|brazilian|portuguese|portugues|dublado|dublada|dub|nacional|(dual|multi)( ?audio)?)\b/;
const SUBTITLE_MARKER = /\b(legendado|legendada|leg|subbed)\b/;
const NATIONAL_MARKER = /\bnacional\b/;
// Sufixo de áudio que o torrent-indexer anexa ao título: "... (brazilian, eng)".
const AUDIO_SUFFIX = /\s*\([a-z0-9 ,-]+\)\s*$/i;

/** Tira o sufixo de áudio "(brazilian, eng)" do fim de um título do torrent-indexer. */
export function stripAudioSuffix(title: string): string {
  return title.replace(AUDIO_SUFFIX, '');
}

/**
 * Confere idiomas vindos do audio[] com o nome do release. O audio[] das fontes
 * às vezes repete o idioma da página inteira: um release "LEGENDADO" ou "ENG"
 * aparecia como Português. Sem marca de áudio PT no nome, legenda ou outro
 * idioma nomeado tiram Português; NACIONAL fica só com Português.
 */
export function reconcileAudioWithRelease(languages: string[], releaseName: string): string[] {
  const text = tokenize(stripAudioSuffix(releaseName));
  if (!text || languages.length === 0) {
    return languages;
  }

  const named = detectReleaseLanguages(text).filter((language) => language !== 'Portuguese');
  if (NATIONAL_MARKER.test(text) && named.length === 0) {
    return ['Portuguese'];
  }
  if (PT_AUDIO_MARKER.test(text) || !languages.includes('Portuguese')) {
    return languages;
  }
  if (!SUBTITLE_MARKER.test(text) && named.length === 0) {
    return languages;
  }

  const withoutPt = languages.filter((language) => language !== 'Portuguese');
  if (withoutPt.length > 0) {
    return withoutPt;
  }
  return named.length > 0 ? named : ['English'];
}

/** Idiomas de campos estruturados como o audio[] do torrent-indexer; valores desconhecidos são ignorados. */
export function languagesFromAudioValues(values: unknown): string[] {
  const found = new Set<string>();

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'string') {
      return;
    }

    const exact = AUDIO_VALUE_NAMES[tokenize(value)];
    if (exact) {
      found.add(exact);
      return;
    }
    detectReleaseLanguages(value).forEach((language) => found.add(language));
  };

  visit(values);
  return Array.from(found);
}

// Marcas de português que o parser do AIOStreams (FileParser) reconhece num nome de arquivo.
// NACIONAL e LEGENDADO não estão aqui: ele ignora o primeiro e lê o segundo como áudio em português.
const AIOSTREAMS_PT_MARKER = /\b(pt ?br|brazilian|portuguese|portugues|dublado|dublada|dual|multi|por)\b/;
const AIOSTREAMS_SUBS_MARKER = /\b((pt ?br|portuguese|portugues|por) ?subs?|subs? ?(pt ?br|portuguese|portugues|por))\b/;
const VIDEO_EXTENSION = /\.(mkv|mp4|avi|m4v|ts|m2ts|iso)$/i;

/**
 * Marca de idioma para anexar ao behaviorHints.filename, que é onde o AIOStreams
 * lê idioma e legenda de um addon custom:
 * - áudio em português sem marca que ele entenda (NACIONAL, ou só o audio[]): "PT-BR";
 * - sem áudio em português e com LEGENDADO no release ou na página: "Subs.PT-BR",
 *   que ele lê como Portuguese (Brazil) com legenda ({stream.subbed}); "PT-BR.Subs"
 *   daria só Portuguese genérico.
 * O PT-BR também faz o parser somar Portuguese genérico (🇵🇹) ao Portuguese (Brazil).
 */
export function filenameLanguageTag(fileName: string, languages: string[], hints: string[] = []): string | undefined {
  const name = tokenize(fileName);
  if (languages.includes('Portuguese')) {
    return AIOSTREAMS_PT_MARKER.test(name) ? undefined : 'PT-BR';
  }
  if (AIOSTREAMS_SUBS_MARKER.test(name)) {
    return undefined;
  }
  const subtitled = [fileName, ...hints].some((text) => SUBTITLE_MARKER.test(tokenize(stripAudioSuffix(text))));
  return subtitled ? 'Subs.PT-BR' : undefined;
}

/** Anexa a marca ao nome, antes da extensão, no separador que o nome já usa. */
export function appendFilenameTag(fileName: string, tag: string | undefined): string {
  if (!tag) {
    return fileName;
  }
  const extension = fileName.match(VIDEO_EXTENSION)?.[0] ?? '';
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  const separator = /\s/.test(base) ? ' ' : '.';
  return `${base}${separator}${tag}${extension}`;
}
