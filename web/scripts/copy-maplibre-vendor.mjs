// maplibre-gl v6 spawns its tile workers from a real same-origin module
// script (maplibre-gl-worker.mjs) rather than a blob URL. The bundler does
// not emit it, so we serve the shipped files verbatim from /vendor and point
// maplibre at them via setWorkerUrl() in src/main.tsx. The files must match
// the installed maplibre-gl version — that's why they're copied at build
// time instead of committed. (Resolved via createRequire so npm's hoisting
// of the workspace dependency is irrelevant.)
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require.resolve("maplibre-gl/package.json");
const source = join(dirname(pkg), "dist");

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(webRoot, "public", "vendor");

mkdirSync(target, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(source, file), join(target, file));
  console.log(`vendor: ${file}`);
}
