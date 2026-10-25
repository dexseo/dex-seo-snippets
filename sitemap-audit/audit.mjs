#!/usr/bin/env node
// sitemap-audit — read a sitemap the way a crawler would, then check every URL in it.
//
//   node sitemap-audit/audit.mjs https://www.example.com/
//   node sitemap-audit/audit.mjs https://www.example.com/sitemap-index.xml --json report.json
//
// No dependencies. Node 20 or newer.
// Part of https://github.com/dexseo/dex-seo-snippets (MIT).

import { gunzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  agent: 'googlebot', // which robots.txt group to evaluate
  concurrency: 4,
  timeoutMs: 15000,
  limit: Infinity, // max page URLs to check
  userAgent: 'dex-seo-snippets-sitemap-audit/1.0 (+https://github.com/dexseo/dex-seo-snippets)',
};

// Limits from the sitemaps protocol and Google's docs.
const MAX_SITEMAP_URLS = 50_000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024; // 50 MB uncompressed
const MAX_ROBOTS_BYTES = 500 * 1024; // Google reads the first 500 KiB
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_REDIRECTS = 10;
const MAX_ROBOTS_REDIRECTS = 5; // Google: after 5 hops, robots.txt is treated as 404

// Every problem the audit can report. [severity, what it means]
export const ISSUES = {
  // sitemap files
  'sitemap-unreachable': ['error', 'The sitemap could not be fetched or did not return 200.'],
  'sitemap-not-xml': ['error', 'The sitemap response is not XML (an HTML page, login screen or error page?).'],
  'sitemap-invalid-root': ['error', 'The root element is neither <urlset> nor <sitemapindex>.'],
  'sitemap-namespace': ['warning', 'The root element is missing the sitemaps.org 0.9 namespace.'],
  'sitemap-too-many-urls': ['error', 'More than 50,000 URLs in one sitemap. Split it and use a sitemap index.'],
  'sitemap-too-large': ['error', 'Larger than 50 MB uncompressed. Split it and use a sitemap index.'],
  'sitemap-empty': ['warning', 'The sitemap lists no URLs.'],
  'sitemap-nested-index': ['warning', 'A sitemap index lists another sitemap index. The protocol expects sitemaps only.'],
  'xml-unescaped': ['error', 'A value has a raw "&" (or "<"). Values must be entity-escaped.'],
  'lastmod-invalid': ['warning', '<lastmod> is not a W3C date (YYYY-MM-DD or full timestamp).'],
  'lastmod-future': ['warning', '<lastmod> is in the future.'],
  'lastmod-uniform': ['warning', 'Every <lastmod> is identical. It probably records the build, not the last real change.'],
  // entries
  'relative-url': ['error', '<loc> is not a full, absolute URL.'],
  'duplicate-url': ['warning', 'The same URL is listed more than once.'],
  'other-host': ['warning', 'The URL is on a different host than the sitemap that lists it.'],
  // pages
  'fetch-failed': ['error', 'The request failed (DNS, timeout or connection error).'],
  'http-error': ['error', 'The final response is not 200.'],
  'redirect': ['warning', 'The listed URL redirects. List the final URL instead.'],
  'redirect-loop': ['error', 'The URL redirects in a loop.'],
  'too-many-redirects': ['error', 'More than 10 redirects.'],
  'blocked-by-robots': ['error', 'robots.txt blocks this URL for the chosen crawler.'],
  'noindex': ['error', 'The page asks not to be indexed (meta robots or X-Robots-Tag), but the sitemap lists it.'],
  'noindex-unseen': ['warning', 'The page has noindex, but robots.txt blocks crawling, so Google can never read it.'],
  'canonical-other': ['warning', 'The canonical points to a different URL than the one listed.'],
  'canonical-multiple': ['warning', 'The page declares more than one canonical URL.'],
  'not-html': ['info', 'Not an HTML page. Only status, redirects, headers and robots.txt were checked.'],
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------- robots.txt

/**
 * Parse robots.txt into groups, following Google's interpretation:
 * consecutive user-agent lines share one group, other fields (sitemap) don't
 * break a group, rules before any user-agent are ignored.
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || current.closed) {
        current = { agents: [], rules: [], closed: false };
        groups.push(current);
      }
      current.agents.push(normalizeAgent(value));
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue;
      current.closed = true; // a rule line ends the run of user-agent lines
      if (value) current.rules.push({ type: field, path: value });
    } else if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

// "Googlebot/1.2" and "googlebot*" both mean "googlebot".
function normalizeAgent(value) {
  const v = value.toLowerCase().trim();
  if (v === '*') return '*';
  return (v.match(/^[a-z_-]+/) || [v])[0];
}

/** The rules that apply to one crawler: its most specific group(s), else the * group(s). */
export function rulesFor(robots, agent) {
  const a = normalizeAgent(agent);
  const specific = robots.groups.filter((g) => g.agents.includes(a));
  const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

const patternCache = new Map();

function toRegex(pattern) {
  let re = patternCache.get(pattern);
  if (!re) {
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    re = new RegExp('^' + source + (anchored ? '$' : ''));
    patternCache.set(pattern, re);
  }
  return re;
}

// Compare rules and URLs in percent-encoded form, as Google does.
function encodePattern(path) {
  return Array.from(path)
    .map((ch) => (ch.codePointAt(0) > 0x7e || ch === ' ' ? encodeURIComponent(ch) : ch))
    .join('')
    .replace(/%[0-9a-f]{2}/gi, (h) => h.toUpperCase());
}

/**
 * Is this URL allowed for the crawler? The longest matching rule wins;
 * on a tie between allow and disallow, allow wins (least restrictive).
 */
export function isAllowed(robots, url, agent = DEFAULTS.agent) {
  const u = new URL(url);
  const target = (u.pathname + u.search).replace(/%[0-9a-f]{2}/gi, (h) => h.toUpperCase());
  let best = null;
  for (const rule of rulesFor(robots, agent)) {
    const pattern = encodePattern(rule.path);
    if (!toRegex(pattern).test(target)) continue;
    const better =
      !best ||
      pattern.length > best.length ||
      (pattern.length === best.length && rule.type === 'allow' && best.rule.type === 'disallow');
    if (better) best = { rule, length: pattern.length };
  }
  if (!best || best.rule.type === 'allow') return { allowed: true, rule: best ? `allow: ${best.rule.path}` : null };
  return { allowed: false, rule: `disallow: ${best.rule.path}` };
}

// ------------------------------------------------------------------ sitemaps

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function readValue(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return { value: cdata[1].trim(), unescaped: false };
  const raw = inner.trim();
  const unescaped = /&(?!(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(raw) || raw.includes('<');
  return { value: decodeEntities(raw), unescaped };
}

function child(block, tag) {
  // Only unprefixed tags: <loc> inside <image:image> is <image:loc> and is skipped.
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i'));
  return m ? readValue(m[1]) : null;
}

const W3C_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

/**
 * Parse a sitemap or sitemap index. Returns its type, entries and the
 * file-level problems found. Pure: no network.
 */
export function parseSitemap(xml, { now = Date.now() } = {}) {
  const text = xml.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '');
  const issues = [];
  const rootMatch = text.match(/<([A-Za-z_][\w.-]*(?::[\w.-]+)?)([^>]*)>/g)?.find((t) => !/^<[?!]/.test(t));
  const rootName = rootMatch?.match(/^<([^\s>/]+)/)?.[1].replace(/^[\w.-]+:/, '').toLowerCase();
  const type = rootName === 'urlset' || rootName === 'sitemapindex' ? rootName : null;
  if (!type) {
    issues.push({ code: 'sitemap-invalid-root', detail: rootName ? `<${rootName}>` : 'no root element' });
    return { type, entries: [], issues };
  }
  if (!/xmlns(:[\w-]+)?\s*=\s*["']https?:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9\/?["']/.test(rootMatch)) {
    issues.push({ code: 'sitemap-namespace', detail: null });
  }

  const tag = type === 'urlset' ? 'url' : 'sitemap';
  const blockRe = new RegExp(`<${tag}\\b(?![\\w-])[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  const entries = [];
  for (const [, block] of text.matchAll(blockRe)) {
    const loc = child(block, 'loc');
    if (!loc) continue;
    const lastmod = child(block, 'lastmod');
    const entry = { loc: loc.value, lastmod: lastmod?.value ?? null, issues: [] };
    if (loc.unescaped || lastmod?.unescaped) entry.issues.push({ code: 'xml-unescaped', detail: loc.value });
    if (entry.lastmod) {
      if (!W3C_DATE.test(entry.lastmod)) entry.issues.push({ code: 'lastmod-invalid', detail: entry.lastmod });
      else if (Date.parse(entry.lastmod) > now + 24 * 3600 * 1000) entry.issues.push({ code: 'lastmod-future', detail: entry.lastmod });
    }
    entries.push(entry);
  }

  if (!entries.length) issues.push({ code: 'sitemap-empty', detail: null });
  if (type === 'urlset' && entries.length > MAX_SITEMAP_URLS) {
    issues.push({ code: 'sitemap-too-many-urls', detail: `${entries.length} URLs` });
  }
  const dated = entries.filter((e) => e.lastmod);
  if (dated.length >= 5 && dated.length === entries.length && dated.every((e) => e.lastmod === dated[0].lastmod)) {
    issues.push({ code: 'lastmod-uniform', detail: dated[0].lastmod });
  }
  return { type, entries, issues };
}

// ------------------------------------------------------------- page signals

function decodeHtml(s) {
  return decodeEntities(s.replace(/&nbsp;/g, ' '));
}

function attributes(tag) {
  const attrs = {};
  const body = tag.replace(/^<\w+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([^\s"'=<>/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const NOINDEX = new Set(['noindex', 'none']);

/** Read robots meta tags and canonical links from an HTML document's head. */
export function extractPageSignals(html, baseUrl, agent = DEFAULTS.agent) {
  const end = html.search(/<\/head\s*>/i);
  const head = (end >= 0 ? html.slice(0, end) : html.slice(0, 200_000)).replace(/<!--[\s\S]*?-->/g, '');
  const meta = [];
  const canonicals = [];
  for (const [tag] of head.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    const a = attributes(tag);
    if (/^<meta/i.test(tag) && a.name) {
      const name = a.name.toLowerCase();
      if (name === 'robots' || name === agent.toLowerCase()) meta.push({ name, content: a.content || '' });
    } else if (/^<link/i.test(tag) && a.rel && a.rel.toLowerCase().split(/\s+/).includes('canonical') && a.href) {
      try {
        canonicals.push(new URL(a.href, baseUrl).href);
      } catch {
        canonicals.push(a.href);
      }
    }
  }
  const noindex = meta.some((m) => m.content.toLowerCase().split(',').some((d) => NOINDEX.has(d.trim())));
  return { meta, canonicals, noindex };
}

const XRT_DIRECTIVES_WITH_COLON = new Set(['unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview']);

/**
 * Does an X-Robots-Tag header value say noindex for this crawler?
 * Handles "noindex", "none" and the agent-prefixed form "googlebot: noindex, nofollow".
 */
export function headerNoindex(value, agent = DEFAULTS.agent) {
  if (!value) return false;
  let scope = null;
  for (const token of value.split(',')) {
    let directive = token.trim().toLowerCase();
    const m = directive.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (m && !XRT_DIRECTIVES_WITH_COLON.has(m[1])) {
      scope = m[1];
      directive = m[2].trim();
    }
    if (NOINDEX.has(directive) && (scope === null || scope === agent.toLowerCase())) return true;
  }
  return false;
}

function linkHeaderCanonicals(value, baseUrl) {
  if (!value) return [];
  const out = [];
  for (const m of value.matchAll(/<([^>]+)>\s*;([^,]*)/g)) {
    if (/rel\s*=\s*"?([^";]*\s)?canonical(\s[^";]*)?"?/i.test(m[2])) {
      try {
        out.push(new URL(m[1], baseUrl).href);
      } catch {
        out.push(m[1]);
      }
    }
  }
  return out;
}

function sameUrl(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return a === b;
  }
}

// ------------------------------------------------------------------ network

function client(options) {
  const headers = { 'user-agent': options.userAgent, accept: '*/*' };

  async function request(url) {
    return fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(options.timeoutMs) });
  }

  async function follow(url, maxHops) {
    const chain = [];
    const seen = new Set([url]);
    let current = url;
    for (;;) {
      const res = await request(current);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const next = new URL(location, current).href;
        chain.push({ url: current, status: res.status, to: next });
        if (seen.has(next)) return { chain, loop: true };
        if (chain.length >= maxHops) return { chain, tooMany: true };
        seen.add(next);
        current = next;
        continue;
      }
      return { chain, res, finalUrl: current };
    }
  }

  return { follow };
}

async function readBody(res, limit) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return { buf: Buffer.concat(chunks), truncated: true };
    }
  }
  return { buf: Buffer.concat(chunks), truncated: false };
}

async function pool(items, size, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

// --------------------------------------------------------------------- audit

/**
 * Audit a site. `input` can be the site root (sitemaps are read from
 * robots.txt, falling back to /sitemap.xml), a robots.txt URL, or a sitemap URL.
 */
export async function audit(input, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const http = client(options);
  const startedAt = new Date().toISOString();
  const robotsByOrigin = new Map();

  function loadRobots(origin) {
    if (!robotsByOrigin.has(origin)) {
      robotsByOrigin.set(
        origin,
        (async () => {
          const url = `${origin}/robots.txt`;
          try {
            const r = await http.follow(url, MAX_ROBOTS_REDIRECTS);
            if (r.loop || r.tooMany) return { url, status: 'redirects', robots: parseRobots(''), note: 'too many redirects, treated as no robots.txt' };
            const { status } = r.res;
            if (status >= 200 && status < 300) {
              const { buf } = await readBody(r.res, MAX_ROBOTS_BYTES);
              return { url, status, robots: parseRobots(buf.subarray(0, MAX_ROBOTS_BYTES).toString('utf8')) };
            }
            await r.res.body?.cancel();
            if (status === 429 || status >= 500) return { url, status, robots: null, note: 'server error: Google pauses crawling the site' };
            return { url, status, robots: parseRobots(''), note: 'no robots.txt: no restrictions' };
          } catch (err) {
            return { url, status: 'failed', robots: null, note: `could not fetch (${err.cause?.code || err.name}): Google pauses crawling the site` };
          }
        })(),
      );
    }
    return robotsByOrigin.get(origin);
  }

  // 1. Find the sitemaps to read.
  const start = new URL(input);
  let roots;
  if (start.pathname === '/robots.txt' || (start.pathname === '/' && !start.search)) {
    const r = await loadRobots(start.origin);
    roots = r.robots?.sitemaps.length ? r.robots.sitemaps : [`${start.origin}/sitemap.xml`];
  } else {
    roots = [start.href];
  }

  // 2. Read sitemaps, following sitemap indexes.
  const sitemaps = [];
  const entries = [];
  const queue = roots.map((url) => ({ url, depth: 0, parent: null }));
  const seenSitemaps = new Set();
  while (queue.length) {
    const { url, depth, parent } = queue.shift();
    if (seenSitemaps.has(url)) continue;
    seenSitemaps.add(url);
    const sm = { url, parent, status: null, type: null, count: 0, issues: [] };
    sitemaps.push(sm);
    let res;
    try {
      const r = await http.follow(url, MAX_PAGE_REDIRECTS);
      if (r.loop || r.tooMany) {
        sm.issues.push({ code: 'sitemap-unreachable', detail: r.loop ? 'redirect loop' : 'too many redirects' });
        continue;
      }
      res = r.res;
      sm.status = res.status;
      if (r.chain.length) sm.redirectedTo = r.finalUrl;
    } catch (err) {
      sm.issues.push({ code: 'sitemap-unreachable', detail: err.cause?.code || err.name });
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      sm.issues.push({ code: 'sitemap-unreachable', detail: `HTTP ${res.status}` });
      continue;
    }
    let { buf, truncated } = await readBody(res, MAX_SITEMAP_BYTES);
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        buf = gunzipSync(buf, { maxOutputLength: MAX_SITEMAP_BYTES + 1 });
      } catch {
        truncated = true;
      }
    }
    if (truncated || buf.length > MAX_SITEMAP_BYTES) {
      sm.issues.push({ code: 'sitemap-too-large', detail: null });
      continue;
    }
    const body = buf.toString('utf8');
    const contentType = res.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(body)) {
      sm.issues.push({ code: 'sitemap-not-xml', detail: contentType || 'HTML body' });
      continue;
    }
    const parsed = parseSitemap(body);
    sm.type = parsed.type;
    sm.count = parsed.entries.length;
    sm.issues.push(...parsed.issues);
    const base = new URL(sm.redirectedTo || url);
    for (const e of parsed.entries) {
      let absolute = null;
      try {
        if (/^https?:\/\//i.test(e.loc)) absolute = new URL(e.loc).href;
      } catch {
        /* stays null */
      }
      if (!absolute) {
        e.issues.push({ code: 'relative-url', detail: e.loc });
      }
      if (parsed.type === 'sitemapindex') {
        if (depth > 0) sm.issues.push({ code: 'sitemap-nested-index', detail: url });
        for (const i of e.issues) sm.issues.push(i);
        if (absolute && depth < 3) queue.push({ url: absolute, depth: depth + 1, parent: url });
      } else {
        if (absolute && new URL(absolute).host !== base.host) e.issues.push({ code: 'other-host', detail: `${new URL(absolute).host} in a sitemap on ${base.host}` });
        entries.push({ ...e, url: absolute, sitemap: url });
      }
    }
  }

  // 3. Check each listed URL once.
  const results = [];
  const byUrl = new Map();
  for (const e of entries) {
    const key = e.url || e.loc;
    if (byUrl.has(key)) {
      const first = byUrl.get(key);
      if (!first.issues.some((i) => i.code === 'duplicate-url')) first.issues.push({ code: 'duplicate-url', detail: null });
      first.listedIn.push(e.sitemap);
      continue;
    }
    const result = { url: key, sitemap: e.sitemap, listedIn: [e.sitemap], lastmod: e.lastmod, status: null, finalUrl: null, redirects: [], robots: null, noindex: null, canonical: null, issues: [...e.issues] };
    byUrl.set(key, result);
    results.push(result);
  }

  const toCheck = results.filter((r) => /^https?:\/\//i.test(r.url)).slice(0, options.limit);
  options.onStart?.(toCheck.length);
  let done = 0;
  await pool(toCheck, options.concurrency, async (r) => {
    await checkPage(r);
    options.onProgress?.(++done, toCheck.length, r);
  });

  async function checkPage(r) {
    const robotsInfo = await loadRobots(new URL(r.url).origin);
    const verdict = robotsInfo.robots ? isAllowed(robotsInfo.robots, r.url, options.agent) : { allowed: false, rule: `robots.txt ${robotsInfo.status}` };
    r.robots = verdict;

    let fetched;
    try {
      fetched = await http.follow(r.url, MAX_PAGE_REDIRECTS);
    } catch (err) {
      r.issues.push({ code: 'fetch-failed', detail: err.cause?.code || err.name });
      return;
    }
    r.redirects = fetched.chain.map((h) => `${h.status} → ${h.to}`);
    if (fetched.loop) return void r.issues.push({ code: 'redirect-loop', detail: r.redirects.join(' | ') });
    if (fetched.tooMany) return void r.issues.push({ code: 'too-many-redirects', detail: null });

    const { res, finalUrl } = fetched;
    r.status = res.status;
    r.finalUrl = finalUrl;
    if (fetched.chain.length) r.issues.push({ code: 'redirect', detail: r.redirects.join(' | ') });
    if (res.status !== 200) {
      await res.body?.cancel();
      r.issues.push({ code: 'http-error', detail: `HTTP ${res.status}` });
      if (!verdict.allowed) r.issues.push({ code: 'blocked-by-robots', detail: verdict.rule });
      return;
    }

    const headerSaysNoindex = headerNoindex(res.headers.get('x-robots-tag'), options.agent);
    const canonicals = linkHeaderCanonicals(res.headers.get('link'), finalUrl);
    let metaSaysNoindex = false;
    if (/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) {
      const { buf } = await readBody(res, MAX_PAGE_BYTES);
      const signals = extractPageSignals(buf.toString('utf8'), finalUrl, options.agent);
      metaSaysNoindex = signals.noindex;
      canonicals.push(...signals.canonicals);
    } else {
      await res.body?.cancel();
      r.issues.push({ code: 'not-html', detail: res.headers.get('content-type') });
    }

    const noindex = headerSaysNoindex || metaSaysNoindex;
    r.noindex = noindex ? (headerSaysNoindex ? 'X-Robots-Tag' : 'meta robots') : false;
    const unique = [...new Set(canonicals)];
    r.canonical = unique[0] ?? null;
    if (unique.length > 1) r.issues.push({ code: 'canonical-multiple', detail: unique.join(' | ') });
    if (r.canonical && !sameUrl(r.canonical, finalUrl)) r.issues.push({ code: 'canonical-other', detail: r.canonical });

    if (!verdict.allowed) {
      r.issues.push({ code: 'blocked-by-robots', detail: verdict.rule });
      if (noindex) r.issues.push({ code: 'noindex-unseen', detail: r.noindex });
    } else if (noindex) {
      r.issues.push({ code: 'noindex', detail: r.noindex });
    }
  }

  // 4. Summary.
  const robots = [];
  for (const [origin, p] of robotsByOrigin) {
    const info = await p;
    robots.push({ origin, url: info.url, status: info.status, note: info.note ?? null, sitemaps: info.robots?.sitemaps ?? [] });
  }
  const counts = {};
  for (const item of [...sitemaps, ...results]) for (const i of item.issues) counts[i.code] = (counts[i.code] || 0) + 1;
  const severity = (level) => Object.entries(counts).filter(([c]) => ISSUES[c][0] === level).reduce((n, [, v]) => n + v, 0);
  return {
    tool: 'dex-seo-snippets/sitemap-audit',
    input,
    agent: options.agent,
    startedAt,
    finishedAt: new Date().toISOString(),
    robots,
    sitemaps,
    urls: results,
    checked: toCheck.length,
    summary: { urls: results.length, checked: toCheck.length, errors: severity('error'), warnings: severity('warning'), counts },
  };
}

// ----------------------------------------------------------------------- CLI

const HELP = `sitemap-audit — check every URL in a sitemap the way a crawler would

Usage
  node sitemap-audit/audit.mjs <site-or-sitemap-url> [options]

  <site-or-sitemap-url>  https://example.com/ (reads Sitemap: lines from robots.txt),
                         a robots.txt URL, or a sitemap / sitemap index URL

Options
  --agent <name>         robots.txt group to evaluate (default: googlebot)
  --limit <n>            check at most n page URLs
  --concurrency <n>      parallel requests (default: 4)
  --timeout <ms>         per-request timeout (default: 15000)
  --json <file>          write the full report as JSON
  --csv <file>           write one row per URL as CSV
  --all                  list every affected URL (default: first 10 per issue)
  --fail-on <level>      exit 1 on "error" (default), "warning", or "never"
  -h, --help             show this help
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--all') args.all = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      args[k] = inline ?? argv[++i];
    } else args._.push(a);
  }
  return args;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(report) {
  const rows = [['url', 'sitemap', 'status', 'final_url', 'robots', 'noindex', 'canonical', 'issues', 'details']];
  for (const r of report.urls) {
    rows.push([
      r.url,
      r.sitemap,
      r.status,
      r.finalUrl,
      r.robots ? (r.robots.allowed ? 'allowed' : `blocked (${r.robots.rule})`) : '',
      r.noindex || '',
      r.canonical,
      r.issues.map((i) => i.code).join(';'),
      r.issues.map((i) => i.detail).filter(Boolean).join(' ; '),
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function paint(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { red: wrap(31), yellow: wrap(33), green: wrap(32), dim: wrap(2), bold: wrap(1), cyan: wrap(36) };
}

export function formatReport(report, { all = false, color = false } = {}) {
  const c = paint(color);
  const out = [];
  const label = { error: c.red('ERROR'), warning: c.yellow('WARN '), info: c.cyan('INFO ') };
  out.push(c.bold(`sitemap-audit · ${report.input}`), c.dim(`robots.txt evaluated for: ${report.agent}`), '');

  for (const rb of report.robots) out.push(`robots.txt  ${rb.url}  ${rb.status}${rb.note ? c.dim(`  (${rb.note})`) : ''}`);
  out.push('');
  out.push(c.bold('Sitemaps'));
  for (const sm of report.sitemaps) {
    const indent = sm.parent ? '  └ ' : '';
    const what = sm.type === 'sitemapindex' ? `index of ${sm.count}` : sm.type === 'urlset' ? `${sm.count} URLs` : '—';
    const mark = sm.issues.some((i) => ISSUES[i.code][0] === 'error') ? c.red('✗') : c.green('✓');
    out.push(`${indent}${mark} ${sm.url}  ${c.dim(what)}`);
    const pad = sm.parent ? '        ' : '    ';
    for (const i of sm.issues) out.push(`${pad}${label[ISSUES[i.code][0]]} ${i.code}${i.detail ? c.dim(`  ${i.detail}`) : ''}`);
  }
  out.push('');

  const byCode = new Map();
  for (const r of report.urls) for (const i of r.issues) {
    if (!byCode.has(i.code)) byCode.set(i.code, []);
    byCode.get(i.code).push({ url: r.url, detail: i.detail });
  }
  const codes = [...byCode.keys()].sort((a, b) => SEVERITY_ORDER[ISSUES[a][0]] - SEVERITY_ORDER[ISSUES[b][0]] || byCode.get(b).length - byCode.get(a).length);
  out.push(c.bold(`URLs: ${report.summary.urls} listed, ${report.summary.checked} checked`));
  if (!codes.length) out.push(c.green('  No problems found in the listed URLs.'));
  for (const code of codes) {
    const items = byCode.get(code);
    out.push(`${label[ISSUES[code][0]]} ${c.bold(code)} (${items.length})  ${c.dim(ISSUES[code][1])}`);
    for (const it of all ? items : items.slice(0, 10)) out.push(`        ${it.url}${it.detail && it.detail !== it.url ? c.dim(`  ${it.detail}`) : ''}`);
    if (!all && items.length > 10) out.push(c.dim(`        … ${items.length - 10} more (use --all or --csv)`));
  }
  out.push('');
  const { errors, warnings } = report.summary;
  out.push(`${errors ? c.red(`${errors} errors`) : c.green('0 errors')}, ${warnings ? c.yellow(`${warnings} warnings`) : '0 warnings'}`);
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._[0]) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  const failOn = args['fail-on'] || 'error';
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const report = await audit(args._[0], {
    agent: args.agent || DEFAULTS.agent,
    limit: args.limit ? Number(args.limit) : Infinity,
    concurrency: args.concurrency ? Number(args.concurrency) : DEFAULTS.concurrency,
    timeoutMs: args.timeout ? Number(args.timeout) : DEFAULTS.timeoutMs,
    onProgress: process.stderr.isTTY ? (n, total) => process.stderr.write(`\rchecking ${n}/${total}`) : undefined,
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  console.log(formatReport(report, { all: args.all, color }));
  if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2) + '\n');
  if (args.csv) await writeFile(args.csv, toCsv(report));
  const failed = failOn === 'never' ? false : failOn === 'warning' ? report.summary.errors + report.summary.warnings > 0 : report.summary.errors > 0;
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
