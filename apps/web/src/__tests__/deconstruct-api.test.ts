import { describe, expect, it, vi } from 'vitest';
import { fetchDeconstruct, fetchPhrases, isWebImage, parseDeconstructResponse, parsePhraseResult } from '../deconstruct-api.ts';

const valid = { contents: [{ type: 'text', content: '가' }, { type: 'img', content: 'https://example.com/a.png' }], weights: [[0, 1, .8]] };

describe('deconstruct API contract', () => {
  it('accepts the agreed response shape', () => {
    expect(parseDeconstructResponse(valid)).toEqual(valid);
  });

  it.each([
    ['not an object', null],
    ['unknown content type', { contents: [{ type: 'video', content: 'x' }], weights: [] }],
    ['index out of range', { contents: [{ type: 'text', content: 'x' }], weights: [[0, 1, .5]] }],
    ['reversed pair', { ...valid, weights: [[1, 0, .5]] }],
    ['weight above one', { ...valid, weights: [[0, 1, 1.2]] }],
    ['malformed tuple', { ...valid, weights: [[0, 1]] }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseDeconstructResponse(body)).toThrow();
  });

  it('sends the page address encoded in the query string', async () => {
    const fetcher = vi.fn(async () => Response.json(valid));
    await fetchDeconstruct('/deconstruct', 'https://example.com/?a=1&b=가', ' 검색어 ', new AbortController().signal, fetcher as unknown as typeof fetch);
    const request = new URL((fetcher.mock.calls[0] as unknown as [string])[0]);
    expect(request.pathname).toBe('/deconstruct');
    expect(request.searchParams.get('url')).toBe('https://example.com/?a=1&b=가');
    expect(request.searchParams.get('query')).toBe('검색어');
  });

  it('turns API error codes into readable messages', async () => {
    const fetcher = async () => Response.json({ error: { code: 'BLOCKED_URL', message: 'internal detail' } }, { status: 403 });
    await expect(fetchDeconstruct('/deconstruct', 'http://10.0.0.1', '', new AbortController().signal, fetcher as unknown as typeof fetch))
      .rejects.toThrow('보안 정책상');
  });

  it('reports a stopped service whose proxy answers without JSON', async () => {
    const fetcher = async () => new Response('Bad gateway', { status: 500 });
    await expect(fetchDeconstruct('/deconstruct', 'https://example.com', '', new AbortController().signal, fetcher as unknown as typeof fetch))
      .rejects.toThrow('분해 서버에 연결하지 못했습니다');
  });

  it('accepts query similarities and image labels that match the contents', () => {
    const body = { contents: [{ type: 'text', content: '가' }, { type: 'img', content: 'https://example.com/a.png', label: '붉은 말' }], weights: [[0, 1, .8]], querySimilarities: [.7, .6] };
    expect(parseDeconstructResponse(body)).toEqual(body);
  });

  it.each([
    ['wrong length', [.5]],
    ['above one', [.5, 1.2]],
    ['not numeric', [.5, 'x']],
  ])('rejects query similarities with %s', (_label, querySimilarities) => {
    expect(() => parseDeconstructResponse({ ...valid, querySimilarities })).toThrow('검색어 유사도');
  });

  it('omits the query parameter when there is no search term', async () => {
    const fetcher = vi.fn(async () => Response.json(valid));
    await fetchDeconstruct('/deconstruct', 'https://example.com/', '  ', new AbortController().signal, fetcher as unknown as typeof fetch);
    expect(new URL((fetcher.mock.calls[0] as unknown as [string])[0]).searchParams.has('query')).toBe(false);
  });

  it('asks for phrases at the sibling route with the text encoded', async () => {
    const fetcher = vi.fn(async () => Response.json({ phrases: ['가상현실'], source: 'llm' }));
    const result = await fetchPhrases('/deconstruct', '가상현실 예술 & 작품', ' 검색어 ', new AbortController().signal, fetcher as unknown as typeof fetch);
    const request = new URL((fetcher.mock.calls[0] as unknown as [string])[0]);
    expect(request.pathname).toBe('/deconstruct/phrases');
    expect(request.searchParams.get('text')).toBe('가상현실 예술 & 작품');
    expect(request.searchParams.get('query')).toBe('검색어');
    expect(result).toEqual({ phrases: ['가상현실'], source: 'llm' });
  });

  it('stays within the phrase text limit', async () => {
    const fetcher = vi.fn(async () => Response.json({ phrases: [], source: 'rule' }));
    await fetchPhrases('/deconstruct', '가'.repeat(1500), '', new AbortController().signal, fetcher as unknown as typeof fetch);
    expect(new URL((fetcher.mock.calls[0] as unknown as [string])[0]).searchParams.get('text')).toHaveLength(1000);
  });

  it.each([[null], [{ phrases: 'x', source: 'llm' }], [{ phrases: [1], source: 'llm' }], [{ phrases: [], source: 'other' }], [{ phrases: ['가'], source: 'llm', querySimilarities: [] }], [{ phrases: ['가'], source: 'llm', querySimilarities: [2] }]])('rejects a malformed phrase result', (body) => {
    expect(() => parsePhraseResult(body)).toThrow();
  });

  it('allows only web image addresses', () => {
    expect(isWebImage('https://example.com/a.png')).toBe(true);
    expect(isWebImage('javascript:alert(1)')).toBe(false);
    expect(isWebImage('data:image/png;base64,AA')).toBe(false);
  });
});
