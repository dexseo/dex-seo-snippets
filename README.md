# dex-seo-snippets

Small, dependency-free tools for technical SEO, from the **Technical SEO for Developers** series by [Dex SEO](https://www.getdexseo.com/?utm_source=github&utm_medium=repo&utm_campaign=snippets).

Each folder is one tool, one video and one article. Copy the file you need, or clone the repo and run it with Node 20+.

| Tool | What it does | Video | Article |
| --- | --- | --- | --- |
| [`sitemap-audit`](sitemap-audit/) | Reads your sitemap like a crawler and checks every URL: status, redirects, robots.txt, noindex, canonical | Crawling and Indexing for Developers | [Validate an XML sitemap](https://www.getdexseo.com/blog/crawling-and-indexing/validate-xml-sitemap/?utm_source=github&utm_medium=repo&utm_campaign=crawling-and-indexing) |

More tools land with each new video: redirect checker, render diff, alt text audit, JSON-LD templates.

```bash
git clone https://github.com/dexseo/dex-seo-snippets.git
cd dex-seo-snippets
node sitemap-audit/audit.mjs https://www.example.com/
```

## Principles

- **No dependencies.** Read the code before you run it against your site.
- **Polite by default.** Low concurrency and a clear user agent: `dex-seo-snippets-…/1.0 (+https://github.com/dexseo/dex-seo-snippets)`.
- **Google's documentation is the source.** When a tool encodes a rule, the README links to where Google states it.
- **Honest output.** A clean report means the signals agree. It never means "indexed" or "will rank".

## License

MIT. See [LICENSE](LICENSE).
