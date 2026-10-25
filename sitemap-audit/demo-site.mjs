#!/usr/bin/env node
// A tiny local site with crawling and indexing mistakes planted on purpose.
// Run it, then point sitemap-audit at it:
//
//   node sitemap-audit/demo-site.mjs            # http://127.0.0.1:4173
//   node sitemap-audit/audit.mjs http://127.0.0.1:4173/
//
// Every page says what is wrong with it, so you can open it in a browser too.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const page = (title, { head = '', note = '' } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} · Harbor Lamps (demo)</title>
${head}
</head>
<body>
<h1>${title}</h1>
<p>${note || 'A healthy page: 200, indexable, self-canonical, listed in the sitemap.'}</p>
</body>
</html>`;

export function createDemoSite() {
  let origin = '';
  const self = (path) => `<link rel="canonical" href="${origin}${path}">`;

  const routes = {
    '/robots.txt': () => ({
      type: 'text/plain',
      body: `# Demo robots.txt
User-agent: *
Disallow: /private/
Allow: /private/press-kit

Sitemap: ${origin}/sitemap-index.xml
`,
    }),

    '/sitemap-index.xml': () => ({
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-blog.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-shop.xml</loc></sitemap>
</sitemapindex>`,
    }),

    '/sitemap-blog.xml': () => ({
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/blog/</loc><lastmod>2026-10-20</lastmod></url>
  <url><loc>${origin}/blog/choose-a-desk-lamp/</loc><lastmod>2026-10-18</lastmod></url>
  <url><loc>${origin}/blog/old-lamp-guide/</loc><lastmod>2026-09-02</lastmod></url>
  <url><loc>${origin}/blog/draft-lamp-review/</loc><lastmod>2026-10-21</lastmod></url>
  <url><loc>${origin}/blog/lamp-catalog.pdf</loc><lastmod>2026-10-01</lastmod></url>
  <url><loc>${origin}/blog/desk-lamps/?ref=nav</loc><lastmod>2026-10-10</lastmod></url>
  <url><loc>${origin}/blog/removed-post/</loc><lastmod>2026-08-15</lastmod></url>
  <url><loc>${origin}/blog/choose-a-desk-lamp/</loc><lastmod>2026-10-18</lastmod></url>
  <url><loc>/blog/relative-link/</loc></url>
</urlset>`,
    }),

    '/sitemap-pages.xml': () => ({
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><lastmod>2026-10-24T03:00:00Z</lastmod></url>
  <url><loc>${origin}/about/</loc><lastmod>2026-10-24T03:00:00Z</lastmod></url>
  <url><loc>${origin}/contact/</loc><lastmod>2026-10-24T03:00:00Z</lastmod></url>
  <url><loc>${origin}/private/report/</loc><lastmod>2026-10-24T03:00:00Z</lastmod></url>
  <url><loc>${origin}/private/press-kit/</loc><lastmod>2026-10-24T03:00:00Z</lastmod></url>
  <url><loc>${origin}/status/</loc><lastmod>2026-10-24T03:00:00Z</lastmod></url>
</urlset>`,
    }),

    // Listed in the index, but the file is gone.
    '/sitemap-shop.xml': () => ({ status: 404, type: 'text/html', body: page('Not found') }),

    '/': () => ({ body: page('Harbor Lamps', { head: self('/') }) }),
    '/about/': () => ({ body: page('About us', { head: self('/about/') }) }),
    '/contact/': () => ({ body: page('Contact', { head: self('/contact/') }) }),
    '/blog/': () => ({ body: page('Blog', { head: self('/blog/') }) }),
    '/blog/choose-a-desk-lamp/': () => ({ body: page('How to choose a desk lamp', { head: self('/blog/choose-a-desk-lamp/') }) }),

    // Moved: the sitemap should list the new URL.
    '/blog/old-lamp-guide/': () => ({ status: 301, location: '/blog/lamp-guide/' }),
    '/blog/lamp-guide/': () => ({ body: page('Lamp guide', { head: self('/blog/lamp-guide/'), note: 'The old URL redirects here.' }) }),

    // A draft that went live with noindex still on.
    '/blog/draft-lamp-review/': () => ({
      body: page('Lamp review (draft)', { head: `<meta name="robots" content="noindex, follow">\n${self('/blog/draft-lamp-review/')}`, note: 'Left over from drafting: meta robots noindex.' }),
    }),

    // A PDF excluded by header, not by HTML.
    '/blog/lamp-catalog.pdf': () => ({ type: 'application/pdf', headers: { 'X-Robots-Tag': 'noindex' }, body: '%PDF-1.4 demo' }),

    // A parameter URL whose canonical is the clean one.
    '/blog/desk-lamps/': () => ({ body: page('Desk lamps', { head: self('/blog/desk-lamps/'), note: 'Listed with ?ref=nav; the canonical is the clean URL.' }) }),

    // Deleted, still in the sitemap.
    '/blog/removed-post/': () => ({ status: 410, body: page('Gone', { note: 'Deleted, but still in the sitemap.' }) }),

    // Blocked by robots.txt and noindex: Google can't read the noindex.
    '/private/report/': () => ({ body: page('Internal report', { head: '<meta name="robots" content="noindex">', note: 'Blocked in robots.txt AND noindex.' }) }),

    // Allowed by the longer Allow rule.
    '/private/press-kit/': () => ({ body: page('Press kit', { head: self('/private/press-kit/'), note: 'Inside /private/ but allowed by a longer Allow rule.' }) }),

    // A server error.
    '/status/': () => ({ status: 503, body: page('Down for maintenance') }),
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const route = routes[path];
    const r = route ? route() : { status: 404, body: page('Not found') };
    const headers = { 'content-type': `${r.type || 'text/html'}; charset=utf-8`, ...(r.headers || {}) };
    if (r.location) headers.location = r.location;
    res.writeHead(r.status || 200, headers);
    res.end(r.body || '');
  });

  return {
    server,
    listen(port = 4173, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const { port: p } = server.address();
          origin = `http://${host}:${p}`;
          resolve(origin);
        });
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = createDemoSite();
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  site.listen(port).then((origin) => {
    console.log(`Demo site running at ${origin}`);
    console.log(`Now run: node sitemap-audit/audit.mjs ${origin}/`);
  });
}
