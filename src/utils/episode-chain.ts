/**
 * Episódios citados num nome de release ou arquivo no formato SxxEyy, inclusive
 * em cadeia: "S06E01-02-03", "S01E05-06-07-08", "S02E01-E05", "S02E01 ao 05",
 * "S01E01E02E03", "S03E04 e 05". Dois números ligados por traço, "a", "ao", "à"
 * ou "até" são uma faixa; três ou mais, ou ligados por "e", são uma lista.
 *
 * Lê o texto com "." e "_" trocados por espaço. Devolve conjunto vazio quando
 * não há SxxEyy no texto.
 */

/** Faixa maior que isso é lixo do nome (ano, resolução), não episódios. */
const MAX_RANGE = 60;

// "a", "ao", "e"... só valem como palavra solta ("S02E01 ao 05"), para não ler
// "S01E02A" ou um título colado como faixa.
const CHAIN_REGEX = /S\d{1,3}\s?E(\d{1,3})((?:\s*-\s*E?\d{1,3}\b|\s+(?:a|ao|à|até|e)\s+E?\d{1,3}\b)*)/gi;
const LINK_REGEX = /\s*(-|a|ao|à|até|e)\s*E?(\d{1,3})/gi;

export function episodesInName(value: string): Set<number> {
  const episodes = new Set<number>();
  const text = value.replace(/[._]/g, ' ');

  for (const match of text.matchAll(CHAIN_REGEX)) {
    const first = Number(match[1]);
    const links = [...(match[2] ?? '').matchAll(LINK_REGEX)].map((m) => ({
      word: (m[1] ?? '').toLowerCase(),
      value: Number(m[2]),
    }));

    if (links.length === 1 && links[0] && links[0].word !== 'e') {
      const end = links[0].value;
      if (first > 0 && end >= first && end - first <= MAX_RANGE) {
        for (let i = first; i <= end; i++) episodes.add(i);
        continue;
      }
    }

    if (first > 0) episodes.add(first);
    for (const link of links) {
      if (link.value > 0) episodes.add(link.value);
    }
  }

  // "S01E01E02E03": episódios colados, sem separador
  for (const match of text.matchAll(/S\d{1,3}((?:E\d{1,3}){2,})/gi)) {
    for (const ep of match[1]?.match(/\d{1,3}/g) ?? []) episodes.add(Number(ep));
  }

  return episodes;
}
