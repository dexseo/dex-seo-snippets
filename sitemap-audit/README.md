# sitemap-audit

Read a sitemap the way a crawler would, then check every URL in it.

Your sitemap is a list of the pages you want in search. This script checks that every page on that list can actually get there: it answers 200, doesn't redirect, isn't blocked by robots.txt, doesn't say `noindex`, and declares itself as canonical.

Companion code for the video **Crawling and Indexing for Developers** (Dex SEO on YouTube) and the article [How to Create and Validate an XML Sitemap](https://www.getdexseo.com/blog/crawling-and-indexing/validate-xml-sitemap/?utm_source=github&utm_medium=repo&utm_campaign=crawling-and-indexing).

## Run it

Node 20 or newer, no install step, no dependencies.

```bash
# The whole site: reads the Sitemap: lines from robots.txt (falls back to /sitemap.xml)
node sitemap-audit/audit.mjs https://www.example.com/

# One sitemap or sitemap index
node sitemap-audit/audit.mjs https://www.example.com/sitemap-index.xml

# Save the full report
node sitemap-audit/audit.mjs https://www.example.com/ --json report.json --csv report.csv
```

Try it on the demo site first. It has one of each mistake planted on purpose:

```bash
node sitemap-audit/demo-site.mjs          # terminal 1: http://127.0.0.1:4173
node sitemap-audit/audit.mjs http://127.0.0.1:4173/   # terminal 2
```

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `--agent <name>` | `googlebot` | Which robots.txt group to evaluate (`bingbot`, `oai-searchbot`, …) |
| `--limit <n>` | all | Check at most n page URLs |
| `--concurrency <n>` | `4` | Parallel requests. Keep it low on small servers |
| `--timeout <ms>` | `15000` | Per-request timeout |
| `--json <file>` | — | Full report as JSON |
| `--csv <file>` | — | One row per URL |
| `--all` | off | List every affected URL instead of the first 10 per issue |
| `--fail-on <level>` | `error` | Exit 1 on `error`, `warning`, or `never` |

## What it checks

**Sitemap files**

| Issue | Severity | Meaning |
| --- | --- | --- |
| `sitemap-unreachable` | error | The file didn't return 200 (often a child of an index that no longer exists) |
| `sitemap-not-xml` | error | You got an HTML page: a login screen, an error page, a preview |
| `sitemap-invalid-root` | error | Root is neither `<urlset>` nor `<sitemapindex>` |
| `sitemap-too-many-urls` | error | Over 50,000 URLs in one file |
| `sitemap-too-large` | error | Over 50 MB uncompressed |
| `xml-unescaped` | error | A raw `&` in a URL. Write `&amp;` |
| `sitemap-namespace` | warning | Missing `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"` |
| `sitemap-nested-index` | warning | An index that points to another index |
| `sitemap-empty` | warning | No URLs |
| `lastmod-uniform` | warning | Every `<lastmod>` is the same value: it's the build time, not the page's last change |
| `lastmod-invalid` / `lastmod-future` | warning | Not a W3C date, or a date in the future |

**Each listed URL**

| Issue | Severity | Meaning |
| --- | --- | --- |
| `relative-url` | error | `<loc>` must be a full URL with protocol and host |
| `http-error` | error | Final status isn't 200 (404, 410, 5xx…) |
| `fetch-failed` | error | DNS, timeout or connection error |
| `redirect-loop` / `too-many-redirects` | error | The URL never lands |
| `blocked-by-robots` | error | robots.txt disallows it for the chosen crawler |
| `noindex` | error | The page says `noindex` (meta tag or `X-Robots-Tag`) but the sitemap asks for it to be indexed |
| `redirect` | warning | The URL redirects. List the destination instead |
| `canonical-other` | warning | The page's canonical is a different URL |
| `canonical-multiple` | warning | More than one canonical declared |
| `noindex-unseen` | warning | `noindex` behind a robots.txt block: Google can't fetch the page, so it never sees the tag |
| `duplicate-url` | warning | Listed more than once |
| `other-host` | warning | A URL on another host than its sitemap |
| `not-html` | info | PDFs and other files: only status, headers and robots.txt are checked |

## How robots.txt is evaluated

The parser follows [How Google interprets the robots.txt specification](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec):

- one group per crawler: the most specific `user-agent` match, otherwise `*`; groups for the same agent are merged;
- the longest matching rule wins; on a tie, `allow` wins;
- `*` matches anything and `$` anchors the end; paths are case-sensitive and compared percent-encoded;
- robots.txt answering 4xx means no restrictions; 429, 5xx or no answer means Google pauses crawling, so every URL is reported as blocked.

The script still fetches blocked pages, so you can see what Google can't (that's how it finds `noindex-unseen`).

## What it doesn't tell you

A clean report means your sitemap and your pages agree. It doesn't mean Google has indexed them: that's Google's decision, and the place to see it is the Page indexing report and URL Inspection in Search Console. The script also reads the HTML your server sends; it doesn't run JavaScript. If your canonical or robots tags are added by client-side code, check the rendered HTML in URL Inspection.

## Use it in CI

Fail the deploy when a release breaks the sitemap:

```yaml
- name: Audit sitemap
  run: node sitemap-audit/audit.mjs https://staging.example.com/ --fail-on error
```

## Tests

```bash
node --test
```

The tests cover Google's documented robots.txt examples, sitemap parsing edge cases and a full run against the demo site.
