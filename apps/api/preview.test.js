import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSearchServer, search } from './server.js';
import {
  clearPreviewCacheForTest,
  isBlockedByFrameHeaders,
  isPrivateOrReservedIp,
  resolveNativeEmbedUrl,
  sanitizeProxiedHtml,
  unwrapGoogleRedirectUrl,
} from './preview.js';

async function listen(t, options) {
  const server = createSearchServer({
    apiKey: 'test-serp',
    anthropicApiKey: 'test-anthropic',
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('unwraps Google /url query parameters without network calls and resolves /goto 302 redirects', async () => {
  let calls = 0;
  const direct = await unwrapGoogleRedirectUrl(
    'https://www.google.com/url?sa=t&q=https%3A%2F%2Fblog.naver.com%2Fpost%2F123',
    {
      fetchImpl: () => {
        calls++;
        throw new Error('should not fetch');
      },
    },
  );
  assert.equal(direct, 'https://blog.naver.com/post/123');
  assert.equal(calls, 0);

  const gotoResolved = await unwrapGoogleRedirectUrl(
    'https://www.google.com/goto?url=CAES_OPAQUE_TOKEN',
    {
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(new URL(url).hostname, 'www.google.com');
        assert.equal(init.redirect, 'manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://polle.com/place/pizza' },
        });
      },
    },
  );
  assert.equal(gotoResolved, 'https://polle.com/place/pizza');
  assert.equal(calls, 1);
});

test('search unwraps direct Google /url params without burst-fetching /goto, while /preview unwraps opaque /goto tokens', async (t) => {
  const result = await search('광화문 피자', {
    apiKey: 'test-serp',
    goodCount: 4,
    awesomeCount: 0,
    fetchImpl: async (input) => {
      const url = new URL(input);
      assert.equal(url.hostname, 'serpapi.com');
      return Response.json({
        organic_results: [
          {
            link: 'https://www.google.com/url?sa=t&q=https%3A%2F%2Fblog.naver.com%2Fmullespace%2F224304',
            title: '도치피자 후기',
            snippet: '화덕피자 맛집',
            position: 1,
          },
          {
            link: 'https://blog.naver.com/mullespace/224304',
            title: '중복 원문 링크',
            snippet: '중복 제거 확인',
            position: 2,
          },
          {
            link: 'https://www.google.com/goto?url=TOKEN_NAVER',
            title: '불투명 토큰 링크',
            snippet: '클릭 시 언래핑',
            position: 3,
          },
        ],
      });
    },
  });

  assert.equal(result.good.length, 2);
  assert.equal(result.good[0].url, 'https://blog.naver.com/mullespace/224304');
  assert.equal(result.good[1].url, 'https://www.google.com/goto?url=TOKEN_NAVER');

  const base = await listen(t, {
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.hostname === 'www.google.com' && url.pathname === '/goto') {
        return new Response('<A HREF="https://blog.naver.com/mullespace/224304">here</A>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      assert.equal(url.href, 'https://blog.naver.com/mullespace/224304');
      return new Response('<html><body>Naver Blog</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  const unwrapped = await (
    await fetch(
      `${base}/preview?mode=inspect&url=${encodeURIComponent('https://www.google.com/goto?url=TOKEN_NAVER')}`,
    )
  ).json();
  assert.deepEqual(unwrapped, {
    mode: 'iframe',
    embedUrl: 'https://blog.naver.com/mullespace/224304',
    finalUrl: 'https://blog.naver.com/mullespace/224304',
  });
});

test('blocks private, loopback, link-local, IPv6-mapped, and DNS-rebinding SSRF targets', async (t) => {
  for (const ip of ['127.0.0.1', '10.0.0.8', '172.16.5.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);

  const base = await listen(t, {
    lookupImpl: async (host) =>
      host === 'rebind.attacker.example'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      throw new Error('must not contact blocked host');
    },
  });

  for (const target of [
    'http://localhost:3000/.env',
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3000/',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
    'https://rebind.attacker.example/secret',
  ]) {
    const res = await fetch(`${base}/preview?mode=inspect&url=${encodeURIComponent(target)}`);
    assert.equal(res.status, 400, target);
  }
});

test('preview endpoint classifies iframe-allowed, XFO-proxied SSR, YouTube embed, and empty-shell fallback', async (t) => {
  clearPreviewCacheForTest?.();
  const ssrBody = `<!doctype html><html><head><title>치로 피자바 - 다이닝코드</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
    <meta property="og:description" content="광화문 화덕피자 맛집 상세 리뷰">
    <meta property="og:image" content="/images/pizza.jpg">
    <script>window.__EVIL__ = true;</script></head>
    <body><main>${'정통 나폴리 화덕피자와 파스타 리뷰 본문입니다. '.repeat(12)}</main>
    <img data-src="/photos/slice.jpg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>`;

  let diningFetches = 0;
  const base = await listen(t, {
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === 'blog.example.com') {
        assert.equal(init.headers['Sec-Fetch-Dest'], 'iframe');
        return new Response('<html><body>Allowed</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.hostname === 'dining.example.com') {
        diningFetches++;
        return new Response(ssrBody, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-frame-options': 'DENY',
          },
        });
      }
      if (url.hostname === 'spa-wall.example.com') {
        return new Response(
          '<html><head><title>Instagram</title><meta property="og:description" content="로그인 필요"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
          {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy': "frame-ancestors 'none'",
            },
          },
        );
      }
      return new Response('Forbidden', { status: 403 });
    },
  });

  // 1. Direct iframe allowed
  const allowed = await (
    await fetch(`${base}/preview?mode=inspect&url=${encodeURIComponent('https://blog.example.com/post/1')}`)
  ).json();
  assert.deepEqual(allowed, {
    mode: 'iframe',
    embedUrl: 'https://blog.example.com/post/1',
    finalUrl: 'https://blog.example.com/post/1',
  });

  // 2. YouTube native embed transform
  assert.equal(resolveNativeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  const yt = await (
    await fetch(`${base}/preview?mode=inspect&url=${encodeURIComponent('https://youtu.be/dQw4w9WgXcQ')}`)
  ).json();
  assert.equal(yt.mode, 'iframe');
  assert.equal(yt.embedUrl, 'https://www.youtube.com/embed/dQw4w9WgXcQ');

  // 3. X-Frame-Options blocked SSR page -> proxy mode + cached sanitized HTML with strict CSP
  const proxied = await (
    await fetch(`${base}/preview?mode=inspect&url=${encodeURIComponent('https://dining.example.com/profile?id=1')}`)
  ).json();
  assert.equal(proxied.mode, 'proxy');
  assert.equal(proxied.embedUrl, '/preview?url=https%3A%2F%2Fdining.example.com%2Fprofile%3Fid%3D1');
  assert.equal(proxied.meta.image, 'https://dining.example.com/images/pizza.jpg');
  assert.equal(diningFetches, 1);

  const htmlRes = await fetch(`${base}${proxied.embedUrl}`);
  assert.equal(htmlRes.status, 200);
  assert.equal(diningFetches, 1, 'cached HTML should be served without a second upstream fetch');
  assert.ok(htmlRes.headers.get('content-security-policy').includes("script-src 'none'"));
  const htmlText = await htmlRes.text();
  assert.ok(htmlText.includes('<base href="https://dining.example.com/profile?id=1" target="_self">'));
  assert.ok(!htmlText.includes('<script'));
  assert.ok(!htmlText.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(htmlText.includes('src="/photos/slice.jpg"'));

  // 4. Client-only empty shell with CSP frame-ancestors 'none' -> fallback mode with OG metadata
  const fallback = await (
    await fetch(`${base}/preview?mode=inspect&url=${encodeURIComponent('https://spa-wall.example.com/p/abc')}`)
  ).json();
  assert.equal(fallback.mode, 'fallback');
  assert.equal(fallback.reason, 'client_only_shell');
  assert.equal(fallback.meta.title, 'Instagram');
  assert.equal(fallback.meta.description, '로그인 필요');
});

test('frame header detector and HTML sanitizer handle CSP frame-ancestors variants', () => {
  assert.equal(isBlockedByFrameHeaders(new Headers({ 'x-frame-options': 'SAMEORIGIN' })), true);
  assert.equal(
    isBlockedByFrameHeaders(new Headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self' https://partner.com" })),
    true,
  );
  assert.equal(
    isBlockedByFrameHeaders(new Headers({ 'content-security-policy': 'frame-ancestors *' })),
    false,
  );
  const cleaned = sanitizeProxiedHtml(
    '<div onclick="evil()"><a href="javascript:void(0)">본문</a><a href="/menu" target="_blank">메뉴</a></div><script>alert(1)</script>',
    'https://a.example/path',
  );
  assert.ok(cleaned.includes('<base href="https://a.example/path" target="_self">'));
  assert.ok(cleaned.includes('href="/preview?url=https%3A%2F%2Fa.example%2Fmenu"'));
  assert.ok(!cleaned.includes('target="_blank"'));
  assert.ok(!cleaned.includes('<script'));
  assert.ok(!cleaned.includes('onclick='));
  assert.ok(!cleaned.includes('javascript:'));
});
