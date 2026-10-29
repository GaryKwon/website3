const PAGES_ORIGIN = 'https://garykwon.github.io';

export function apiHeaders(request?: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
  if (request?.headers.get('Origin') === PAGES_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = PAGES_ORIGIN;
  }
  return headers;
}
