// Generates wrangler.ci.jsonc for the Playwright e2e run: wrangler.jsonc with
// the `remote: true` stripped from the TILES R2 binding. Remote bindings make
// `wrangler dev` open an authenticated proxy session, which needs
// CLOUDFLARE_API_TOKEN — CI (and fork PRs in particular) runs without one.
// With a local empty bucket instead, /api/config falls back to the public
// basemap style, which the e2e suite does not depend on.
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("wrangler.jsonc", "utf8");
if (!source.includes('"remote": true')) {
  console.warn("wrangler.jsonc has no remote bindings — wrangler.ci.jsonc is a plain copy");
}
writeFileSync("wrangler.ci.jsonc", source.replaceAll(', "remote": true', ""));
console.log("wrote wrangler.ci.jsonc");
