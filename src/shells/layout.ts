import { bootJson, escapeHtml } from "../lib/html";

export interface ShellOptions {
  title: string;
  metaDescription?: string;
  bodyClass?: string;
  /** Browser-chrome tint for light colour schemes. */
  themeColor?: string;
  /** Optional companion tint emitted with a dark-scheme media query. */
  themeColorDark?: string;
  /** OG card. Generic and coordinate-free on the public page; absent on the
   * control page, which must never unfurl a preview in a chat window. */
  og?: { title: string; description: string; url: string } | null;
  boot?: unknown;
  /** Set false for fully server-rendered pages (privacy) — no SPA bundle. */
  includeApp?: boolean;
  content: string;
  footer: { abuseEmail: string | null; privacyEmail: string | null };
}

export function renderShell(opts: ShellOptions): string {
  const og = opts.og
    ? [
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="Find Me">`,
        `<meta property="og:title" content="${escapeHtml(opts.og.title)}">`,
        `<meta property="og:description" content="${escapeHtml(opts.og.description)}">`,
        `<meta property="og:url" content="${escapeHtml(opts.og.url)}">`,
        `<meta name="twitter:card" content="summary">`,
      ].join("\n")
    : "";

  const themeColor = opts.themeColor
    ? opts.themeColorDark
      ? [
          `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${escapeHtml(opts.themeColor)}">`,
          `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${escapeHtml(opts.themeColorDark)}">`,
        ].join("\n")
      : `<meta name="theme-color" content="${escapeHtml(opts.themeColor)}">`
    : "";

  const footerContacts = [
    opts.footer.abuseEmail
      ? `<a href="mailto:${escapeHtml(opts.footer.abuseEmail)}">Report abuse</a>`
      : "",
    opts.footer.privacyEmail
      ? `<a href="mailto:${escapeHtml(opts.footer.privacyEmail)}">Privacy questions</a>`
      : "",
  ]
    .filter(Boolean)
    .join('<span aria-hidden="true">·</span>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${escapeHtml(opts.metaDescription ?? "Anonymous, expiring location sharing.")}">
${themeColor}
<title>${escapeHtml(opts.title)}</title>
${og}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/maplibre.css">
<link rel="stylesheet" href="/assets/index.css">
</head>
<body class="${opts.bodyClass ?? ""}">
<header class="app-header">
  <a class="brand" href="/">Find&nbsp;Me</a>
</header>
<main id="root">
${opts.content}
</main>
<footer class="app-footer">
  <a href="/privacy">Privacy</a>
  <span aria-hidden="true">·</span>
  ${footerContacts}
  <span aria-hidden="true">·</span>
  <span class="osm-attribution">Map data © OpenStreetMap contributors (ODbL)</span>
</footer>
<script type="application/json" id="findme-boot">${bootJson(opts.boot ?? {})}</script>
${opts.includeApp === false ? "" : '<script type="module" src="/assets/app.js"></script>'}
</body>
</html>`;
}
