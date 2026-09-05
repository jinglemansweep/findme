// Generates wrangler.ci.jsonc for the Playwright e2e run: wrangler.jsonc with
// the `remote: true` stripped from the TILES R2 binding. Remote bindings make
// `wrangler dev` open an authenticated proxy session, which needs
// CLOUDFLARE_API_TOKEN — CI (and fork PRs in particular) runs without one.
// With a local empty bucket instead, /api/config falls back to the public
// basemap style, which the e2e suite does not depend on. It also sets
// ENV_LABEL, so the suite exercises the staging-style labelling path.
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("wrangler.jsonc", "utf8");
if (!source.includes('"remote": true')) {
  console.warn("wrangler.jsonc has no remote bindings — wrangler.ci.jsonc is a plain copy");
}
let out = source.replaceAll(', "remote": true', "");

// Exercise the non-production labelling path end to end: the suite runs with
// an ENV_LABEL exactly like staging's, so badge/title regressions on
// labelled environments are caught locally and in CI. The 4-space anchor
// matches only the top-level vars block (env blocks indent deeper).
const varsAnchor = '    "KILL_SWITCH": "false",';
if (!out.includes(varsAnchor)) {
  throw new Error("vars anchor not found in wrangler.jsonc — update make-ci-wrangler.mjs");
}
out = out.replace(varsAnchor, `${varsAnchor}\n    "ENV_LABEL": "beta",`);

writeFileSync("wrangler.ci.jsonc", out);
console.log("wrote wrangler.ci.jsonc");
