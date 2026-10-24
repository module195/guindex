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
    .replace(/[̀-ͯ]/g, '')
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
