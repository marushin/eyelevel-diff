import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPreviewEndpointUrl,
  clearPreviewInspectionCache,
  inspectPreviewTarget,
} from '../preview-api.ts';

describe('preview endpoint resolution and target inspection', () => {
  afterEach(() => {
    clearPreviewInspectionCache();
  });

  it('derives /preview URLs from relative and absolute search endpoints', () => {
    expect(buildPreviewEndpointUrl('')).toBeNull();
    expect(buildPreviewEndpointUrl('/search')?.href).toBe('http://localhost/preview');
    expect(buildPreviewEndpointUrl('http://127.0.0.1:3000/search')?.href).toBe('http://127.0.0.1:3000/preview');
    expect(buildPreviewEndpointUrl('https://api.example.com/v1/search')?.href).toBe(
      'https://api.example.com/v1/preview',
    );
  });

  it('caches inspection verdicts and resolves relative proxy embed URLs against API origin', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        mode: 'proxy',
        embedUrl: '/preview?url=https%3A%2F%2Fdining.example.com%2F1',
        finalUrl: 'https://dining.example.com/1',
        meta: { title: '치로 피자바', description: '화덕피자' },
      }),
    );
    const signal = new AbortController().signal;
    const first = await inspectPreviewTarget(
      'http://127.0.0.1:3000/search',
      'https://www.google.com/goto?url=TOKEN',
      signal,
      fetcher as unknown as typeof fetch,
    );
    const second = await inspectPreviewTarget(
      'http://127.0.0.1:3000/search',
      'https://www.google.com/goto?url=TOKEN',
      signal,
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.mode).toBe('proxy');
    expect(first.embedUrl).toBe('http://127.0.0.1:3000/preview?url=https%3A%2F%2Fdining.example.com%2F1');
    expect(first.finalUrl).toBe('https://dining.example.com/1');
  });

  it('falls back cleanly when inspection endpoint returns an HTTP error', async () => {
    const fetcher = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    const verdict = await inspectPreviewTarget(
      '/search',
      'https://blocked.example.com/page',
      new AbortController().signal,
      fetcher as unknown as typeof fetch,
    );
    expect(verdict).toEqual({
      mode: 'fallback',
      finalUrl: 'https://blocked.example.com/page',
      reason: 'http_502',
    });
  });
});
