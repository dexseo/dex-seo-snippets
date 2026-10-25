// node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { parseRobots, isAllowed, parseSitemap, extractPageSignals, headerNoindex, audit, toCsv, formatReport } from './audit.mjs';
import { createDemoSite } from './demo-site.mjs';

// ---------------------------------------------------------------- robots.txt
// Cases taken from "How Google interprets the robots.txt specification".

const allowed = (robotsTxt, url, agent) => isAllowed(parseRobots(robotsTxt), url, agent).allowed;

test('robots: the longest matching rule wins', () => {
  assert.equal(allowed('User-agent: *\nallow: /p\ndisallow: /', 'https://example.com/page'), true);
  assert.equal(allowed('User-agent: *\nallow: /page\ndisallow: /*.htm', 'https://example.com/page.htm'), false);
});

test('robots: on a tie, the least restrictive rule wins', () => {
  assert.equal(allowed('User-agent: *\nallow: /folder\ndisallow: /folder', 'https://example.com/folder/page'), true);
  assert.equal(allowed('User-agent: *\nallow: /page\ndisallow: /*.ph', 'https://example.com/page.php5'), true);
});

test('robots: $ anchors the end of the URL', () => {
  const txt = 'User-agent: *\nallow: /$\ndisallow: /';
  assert.equal(allowed(txt, 'https://example.com/'), true);
  assert.equal(allowed(txt, 'https://example.com/page.htm'), false);
  const php = 'User-agent: *\ndisallow: /*.php$';
  assert.equal(allowed(php, 'https://example.com/folder/filename.php'), false);
  assert.equal(allowed(php, 'https://example.com/filename.php?parameters'), true);
});

test('robots: paths are case-sensitive and match from the start', () => {
  const txt = 'User-agent: *\ndisallow: /fish';
  assert.equal(allowed(txt, 'https://example.com/fish.html'), false);
  assert.equal(allowed(txt, 'https://example.com/fishheads/yummy.html'), false);
  assert.equal(allowed(txt, 'https://example.com/fish.php?id=anything'), false);
  assert.equal(allowed(txt, 'https://example.com/Fish.asp'), true);
  assert.equal(allowed(txt, 'https://example.com/catfish'), true);
  assert.equal(allowed(txt, 'https://example.com/?id=fish'), true);
});

test('robots: the most specific user-agent group is used, others ignored', () => {
  const txt = 'user-agent: googlebot-news\ndisallow: /news\n\nuser-agent: *\ndisallow: /all\n\nuser-agent: googlebot\ndisallow: /web';
  assert.equal(allowed(txt, 'https://example.com/web', 'googlebot'), false);
  assert.equal(allowed(txt, 'https://example.com/all', 'googlebot'), true);
  assert.equal(allowed(txt, 'https://example.com/news', 'googlebot-news'), false);
  assert.equal(allowed(txt, 'https://example.com/all', 'Storebot-Google'), false);
});

test('robots: groups for the same agent are merged', () => {
  const txt = 'user-agent: googlebot-news\ndisallow: /fish\n\nuser-agent: *\ndisallow: /carrots\n\nuser-agent: googlebot-news\ndisallow: /shrimp';
  assert.equal(allowed(txt, 'https://example.com/fish', 'googlebot-news'), false);
  assert.equal(allowed(txt, 'https://example.com/shrimp', 'googlebot-news'), false);
  assert.equal(allowed(txt, 'https://example.com/carrots', 'googlebot-news'), true);
});

test('robots: a sitemap line does not split a group', () => {
  const txt = 'user-agent: a\nsitemap: https://example.com/sitemap.xml\n\nuser-agent: b\ndisallow: /';
  assert.equal(allowed(txt, 'https://example.com/x', 'a'), false);
  assert.equal(allowed(txt, 'https://example.com/x', 'b'), false);
  assert.deepEqual(parseRobots(txt).sitemaps, ['https://example.com/sitemap.xml']);
});

test('robots: user-agent values ignore versions and case', () => {
  assert.equal(allowed('User-agent: Googlebot/2.1\nDisallow: /x', 'https://example.com/x', 'googlebot'), false);
});

test('robots: raw UTF-8 and percent-encoded rules are equivalent', () => {
  assert.equal(allowed('User-agent: *\nDisallow: /foo/bar/ツ', 'https://example.com/foo/bar/%E3%83%84'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /foo/bar/%e3%83%84', 'https://example.com/foo/bar/ツ'), false);
});

test('robots: an empty disallow allows everything', () => {
  assert.equal(allowed('User-agent: *\nDisallow:', 'https://example.com/anything'), true);
});

// ------------------------------------------------------------------ sitemaps

test('sitemap: reads a urlset with entities, CDATA and extension tags', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-10-01</lastmod>
    <image:image><image:loc>https://example.com/a.png</image:loc></image:image></url>
  <url><loc><![CDATA[https://example.com/b]]></loc></url>
</urlset>`;
  const s = parseSitemap(xml);
  assert.equal(s.type, 'urlset');
  assert.deepEqual(s.entries.map((e) => e.loc), ['https://example.com/a?x=1&y=2', 'https://example.com/b']);
  assert.equal(s.issues.length, 0);
});

test('sitemap: recognises an index', () => {
  const s = parseSitemap('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(s.type, 'sitemapindex');
  assert.equal(s.entries[0].loc, 'https://example.com/s1.xml');
});

test('sitemap: flags raw ampersands, bad and future dates', () => {
  const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a?x=1&y=2</loc></url>
  <url><loc>https://example.com/b</loc><lastmod>24/10/2026</lastmod></url>
  <url><loc>https://example.com/c</loc><lastmod>2099-01-01</lastmod></url>
</urlset>`;
  const codes = parseSitemap(xml).entries.flatMap((e) => e.issues.map((i) => i.code));
  assert.deepEqual(codes, ['xml-unescaped', 'lastmod-invalid', 'lastmod-future']);
});

test('sitemap: flags a wrong root, a missing namespace and identical lastmod values', () => {
  assert.equal(parseSitemap('<html><body>Login</body></html>').issues[0].code, 'sitemap-invalid-root');
  assert.equal(parseSitemap('<urlset><url><loc>https://e.com/</loc></url></urlset>').issues[0].code, 'sitemap-namespace');
  const same = Array.from({ length: 5 }, (_, i) => `<url><loc>https://e.com/${i}</loc><lastmod>2026-10-24</lastmod></url>`).join('');
  const codes = parseSitemap(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${same}</urlset>`).issues.map((i) => i.code);
  assert.deepEqual(codes, ['lastmod-uniform']);
});

// -------------------------------------------------------------- page signals

test('page: reads meta robots in any attribute order and quoting', () => {
  assert.equal(extractPageSignals('<head><meta content="noindex,follow" name="robots"></head>', 'https://e.com/').noindex, true);
  assert.equal(extractPageSignals("<head><meta name=googlebot content='none'></head>", 'https://e.com/').noindex, true);
  assert.equal(extractPageSignals('<head><meta name="bingbot" content="noindex"></head>', 'https://e.com/').noindex, false);
  assert.equal(extractPageSignals('<head><!-- <meta name="robots" content="noindex"> --></head>', 'https://e.com/').noindex, false);
});

test('page: resolves canonical links against the page URL', () => {
  const s = extractPageSignals('<head><link rel="canonical" href="/a?x=1&amp;y=2"></head>', 'https://e.com/b/');
  assert.deepEqual(s.canonicals, ['https://e.com/a?x=1&y=2']);
});

test('page: ignores tags after </head>', () => {
  assert.equal(extractPageSignals('<head></head><body><meta name="robots" content="noindex"></body>', 'https://e.com/').noindex, false);
});

test('header: X-Robots-Tag with and without an agent prefix', () => {
  assert.equal(headerNoindex('noindex'), true);
  assert.equal(headerNoindex('none'), true);
  assert.equal(headerNoindex('googlebot: noindex, nofollow'), true);
  assert.equal(headerNoindex('otherbot: noindex'), false);
  assert.equal(headerNoindex('unavailable_after: 2026-12-31'), false);
  assert.equal(headerNoindex(null), false);
});

// ------------------------------------------------------------- end to end

let demo;
let origin;
before(async () => {
  demo = createDemoSite();
  origin = await demo.listen(0);
});
after(() => demo.close());

const issuesOf = (report, path) => report.urls.find((u) => u.url === origin + path)?.issues.map((i) => i.code) ?? null;

test('demo site: every planted problem is found, healthy pages are clean', async () => {
  const report = await audit(`${origin}/`);
  assert.deepEqual(issuesOf(report, '/'), []);
  assert.deepEqual(issuesOf(report, '/blog/choose-a-desk-lamp/'), ['duplicate-url']);
  assert.deepEqual(issuesOf(report, '/blog/old-lamp-guide/'), ['redirect']);
  assert.deepEqual(issuesOf(report, '/blog/draft-lamp-review/'), ['noindex']);
  assert.deepEqual(issuesOf(report, '/blog/lamp-catalog.pdf'), ['not-html', 'noindex']);
  assert.deepEqual(issuesOf(report, '/blog/desk-lamps/?ref=nav'), ['canonical-other']);
  assert.deepEqual(issuesOf(report, '/blog/removed-post/'), ['http-error']);
  assert.deepEqual(issuesOf(report, '/private/report/'), ['blocked-by-robots', 'noindex-unseen']);
  assert.deepEqual(issuesOf(report, '/private/press-kit/'), []);
  assert.deepEqual(issuesOf(report, '/status/'), ['http-error']);
  assert.deepEqual(report.urls.find((u) => u.url === '/blog/relative-link/').issues.map((i) => i.code), ['relative-url']);

  const shop = report.sitemaps.find((s) => s.url.endsWith('/sitemap-shop.xml'));
  assert.equal(shop.issues[0].code, 'sitemap-unreachable');
  const pages = report.sitemaps.find((s) => s.url.endsWith('/sitemap-pages.xml'));
  assert.deepEqual(pages.issues.map((i) => i.code), ['lastmod-uniform']);

  assert.equal(report.summary.errors, 7);
  assert.equal(report.summary.warnings, 5);
  assert.match(toCsv(report), /^url,sitemap,status/);
  assert.match(formatReport(report), /7 errors, 5 warnings/);
});

test('limit: checks only the first n URLs', async () => {
  const report = await audit(`${origin}/sitemap-blog.xml`, { limit: 2 });
  assert.equal(report.checked, 2);
});

test('gzip, redirect loops and robots.txt server errors', async () => {
  const xml = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>LOOP</loc></url><url><loc>OK</loc></url></urlset>';
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/robots.txt') return res.writeHead(503).end();
    if (req.url === '/sitemap.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(gzipSync(xml.replace('LOOP', `${base}/a`).replace('OK', `${base}/ok`)));
    }
    if (req.url === '/a') return res.writeHead(302, { location: '/b' }).end();
    if (req.url === '/b') return res.writeHead(302, { location: '/a' }).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end('<head></head>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = await audit(`${base}/sitemap.xml.gz`);
  server.close();
  const codes = (p) => report.urls.find((u) => u.url === base + p).issues.map((i) => i.code);
  assert.deepEqual(codes('/a'), ['redirect-loop']);
  assert.deepEqual(codes('/ok'), ['blocked-by-robots']); // 503 robots.txt: Google pauses crawling
  assert.equal(report.robots[0].status, 503);
});
