import assert from 'node:assert/strict';
import test from 'node:test';
import { apiHeaders } from '../lib/api-headers';
import { apiUrl } from '../lib/api-url';
import { GET as regions } from '../app/api/regions/route';
import { GET as vehicles } from '../app/api/vehicles/route';

const origin = 'https://garykwon.github.io';
test('hosted app retains same-origin URLs', () => {
  assert.equal(apiUrl('/api/regions'), '/api/regions');
});
test('Pages uses the live API origin without changing query parameters', () => {
  assert.equal(apiUrl('/api/vehicles?region=1100&type=passenger', 'https://example.com/'), 'https://example.com/api/vehicles?region=1100&type=passenger');
});
test('CORS allows only the exact Pages origin and never enables credentials', () => {
  for (const value of [null, origin, 'https://garykwon.github.io.evil.example', 'http://garykwon.github.io', 'https://other.github.io']) {
    const request = new Request('https://example.com/api/regions', value ? { headers: { Origin: value } } : {});
    const headers = apiHeaders(request);
    assert.equal(headers['Access-Control-Allow-Origin'], value === origin ? origin : undefined);
    assert.equal(headers['Access-Control-Allow-Credentials'], undefined);
    assert.match(headers['Cache-Control'], /no-store/);
    assert.equal(headers.Vary, 'Origin');
  }
});
test('region response exposes JSON to Pages with no browser cache', async () => {
  const response = await regions(new Request('https://example.com/api/regions', { headers: { Origin: origin } }));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(response.headers.get('Cache-Control')!, /no-store/);
  assert.ok((await response.json() as {regions: unknown[]}).regions.length > 160);
});
test('invalid vehicle requests preserve CORS and remain errors', async () => {
  const response = await vehicles(new Request('https://example.com/api/vehicles?region=invalid', { headers: { Origin: origin } }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
});
