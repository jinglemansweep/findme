// Tells @cloudflare/vitest-plugin what our main module exports are, so
// `exports.default.fetch/scheduled` are fully typed in tests. Note: uses a
// type-only import expression on purpose — a top-level import would make this
// file a module and stop the global namespace augmentation from applying.
// (Same shape as `wrangler types` output.)
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
