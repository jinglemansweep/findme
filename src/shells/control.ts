import { renderShell } from "./layout";

export interface ControlShellInput {
  slug: string;
  ended: boolean; // row stopped or expired — controls are read-only
  footer: { abuseEmail: string | null; privacyEmail: string | null };
}

/**
 * HTML for /u/:slug — the private control page.
 *
 * The fragment never reaches the server, so this HTML is served to anyone
 * with the slug: it must contain nothing private. No OG tags at all, noindex,
 * no-store, no-referrer.
 *
 * Visually distinct from the public page (anti-footgun): a dark control
 * theme and a prominent copy-the-public-link button once hydrated.
 */
export function controlShell(input: ControlShellInput): string {
  return renderShell({
    title: "Your control page — Find Me",
    bodyClass: "shell-control",
    themeColor: "#26221d",
    themeColorDark: "#0e0c0a",
    boot: { mode: "control", slug: input.slug, ended: input.ended },
    content: `
<section class="control-page">
  <div class="info-card">
    <p class="freshness" role="status">Loading your share…</p>
    <noscript><p class="notice">This page needs JavaScript to update your
    location — and remember: this is your private control link. Never paste
    it into a chat.</p></noscript>
  </div>
</section>`,
    footer: input.footer,
  });
}
