// Remove credenciais (api_key=, tokens, Bearer) de textos que vão para log.
// A chave v3 do TMDB só pode ir na query string, então qualquer mensagem de
// erro que contenha a URL a carregaria junto.
const QUERY_SECRET = /([?&\s](?:api_key|apikey|access_token|token)=)[^&\s"']+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;

export function redactSecrets(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(QUERY_SECRET, '$1[redacted]').replace(BEARER, '$1[redacted]');
}
