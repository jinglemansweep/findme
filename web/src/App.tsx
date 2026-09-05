import { useState } from "react";
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
  const [boot, setBoot] = useState<BootConfig>(readBoot);
  // Secret handed over during an in-page create → control transition. Same
  // lifetime rules as the URL fragment: memory only, never written anywhere
  // the server sees.
  const [handedSecret, setHandedSecret] = useState<string | null>(null);

  /**
   * Create → control without a document reload. replaceState keeps the
   * create form out of history (Back skips it), exactly as the old
   * location.replace did — a reload of /u/:slug then lands on the Worker
   * shell, which recovers the secret from device storage.
   */
  function enterControl(pin: { slug: string; secret: string }) {
    history.replaceState(null, "", `/u/${pin.slug}`);
    setHandedSecret(pin.secret);
    setBoot({ mode: "control", slug: pin.slug });
  }

  /** Control → create (after stopping a share) without a document reload. */
  function exitToCreate() {
    history.replaceState(null, "", "/");
    setHandedSecret(null);
    setBoot({ mode: "create" });
  }

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
    return (
      <ControlPage
        config={config}
        slug={boot.slug}
        endedBoot={Boolean(boot.ended)}
        handedSecret={handedSecret}
        onExitToCreate={exitToCreate}
      />
    );
  }
  return <CreatePage config={config} onCreated={enterControl} />;
}
