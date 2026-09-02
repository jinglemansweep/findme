import { escapeHtml } from "../lib/html";
import type { PinRow } from "../api/pins";
import { renderShell } from "./layout";

export interface PublicShellInput {
  slug: string;
  row: PinRow | null; // null → unknown slug
  ended: boolean;
  origin: string;
  footer: { abuseEmail: string | null; privacyEmail: string | null };
}

/** Plain 404 page for URLs that match nothing — used when the Worker has no
 *  ASSETS binding (named environments) and cannot fall back to the SPA. */
export function notFoundShell(footer: { abuseEmail: string | null; privacyEmail: string | null }): string {
  return renderShell({
    title: "Not found — Find Me",
    includeApp: false,
    content: `
<section class="state-card" data-state="notfound">
  <h1>There's nothing here</h1>
  <p>This page doesn't exist. Check the link, or start a new share.</p>
  <p><a class="button secondary" href="/">Go to Find Me</a></p>
</section>`,
    footer,
  });
}

/**
 * HTML for /:slug — the public viewer page. Generic OG card only: previews
 * are fetched and cached by messaging platforms' CDNs, so no coordinates and
 * no label in meta tags (PLAN.md §10). The position itself never enters this
 * HTML; the SPA polls for it.
 */
export function publicShell(input: PublicShellInput): string {
  if (!input.row) {
    return renderShell({
      title: "Not found — Find Me",
      bodyClass: "shell-view",
      themeColor: "#12433a",
      content: `
<section class="state-card" data-state="notfound">
  <h1>This link doesn't match a share</h1>
  <p>The pin never existed, or the link is incomplete. Ask the person who
  shared it with you to send it again.</p>
  <p><a class="button secondary" href="/">Go to Find Me</a></p>
</section>`,
      footer: input.footer,
    });
  }

  if (input.ended) {
    return renderShell({
      title: "This share has ended — Find Me",
      bodyClass: "shell-view",
      themeColor: "#12433a",
      boot: { mode: "view", slug: input.slug, ended: true },
      content: `
<section class="state-card" data-state="ended">
  <h1>This share has ended</h1>
  <p>The person sharing their location stopped the share, or it expired.
  Their position is no longer available.</p>
  <p><a class="button secondary" href="/">Go to Find Me</a></p>
</section>`,
      footer: input.footer,
    });
  }

  const label = input.row.label ?? "Live location";
  // Generic title: scrapers that ignore OG tags fall back to <title>, and the
  // preview card must stay coordinate- and label-free (§10).
  return renderShell({
    title: "Find Me — a shared location",
    metaDescription: "A temporary, live location share. Open to see where this person is.",
    bodyClass: "shell-view",
    themeColor: "#12433a",
    og: {
      title: "Find Me — a shared location",
      description: "Someone is sharing their live location with you. Open the link to see it.",
      url: `${input.origin}/${input.slug}`,
    },
    boot: {
      mode: "view",
      slug: input.slug,
      label: input.row.label,
      expiresAt: input.row.expires_at,
    },
    content: `
<section class="view-page">
  <div class="map-wrap" id="map"><div class="map-loading" role="status">Loading map…</div></div>
  <div class="info-card">
    <h1 class="pin-label">${escapeHtml(label)}</h1>
    <p class="freshness" role="status">Loading live location…</p>
    <noscript><p class="notice">This page needs JavaScript to show the live position.</p></noscript>
  </div>
</section>`,
    footer: input.footer,
  });
}
