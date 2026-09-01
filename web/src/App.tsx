import type { AppConfig, BootConfig } from "./types";
import { CreatePage } from "./pages/CreatePage";
import { ViewerPage } from "./pages/ViewerPage";
import { ControlPage } from "./pages/ControlPage";

const SLUG_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/**
 * The boot config is embedded by the Worker shells in a JSON script tag. In
 * `vite dev` (no Worker) the mode is derived from the URL path instead.
 */
function readBoot(): BootConfig {
  const el = document.getElementById("findme-boot");
  if (el?.textContent) {
    try {
      const parsed = JSON.parse(el.textContent) as BootConfig;
      if (parsed && typeof parsed.mode === "string") return parsed;
    } catch {
      // fall through to path detection
    }
  }
  const path = location.pathname.replace(/\/+$/, "");
  if (path.startsWith("/u/") && SLUG_RE.test(path.slice(3))) {
    return { mode: "control", slug: path.slice(3) };
  }
  if (SLUG_RE.test(path.slice(1))) {
    return { mode: "view", slug: path.slice(1) };
  }
  return { mode: "create" };
}

export default function App({ config }: { config: AppConfig }) {
  const boot = readBoot();

  if (boot.mode === "view" && boot.slug) {
    return (
      <ViewerPage
        config={config}
        slug={boot.slug}
        label={boot.label ?? null}
        expiresAt={boot.expiresAt ?? Date.now() + 7 * 24 * 3600 * 1000}
        endedBoot={Boolean(boot.ended)}
      />
    );
  }
  if (boot.mode === "control" && boot.slug) {
    return <ControlPage config={config} slug={boot.slug} endedBoot={Boolean(boot.ended)} />;
  }
  return <CreatePage config={config} />;
}
