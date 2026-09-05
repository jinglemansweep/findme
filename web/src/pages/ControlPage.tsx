import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { InfoTooltip } from "../components/InfoTooltip";
import { CheckIcon, CopyIcon, RotateIcon, ShareIcon } from "../components/icons";
import { MapView } from "../components/MapView";
import { usePositionPoller } from "../hooks/usePositionPoller";
import { clearCreatedSessionFor, loadCreatedSession, loadEmailNotice } from "../lib/createdSession";
import { copyText } from "../lib/clipboard";
import { countdown, formatExpiry, relativeAge } from "../lib/format";
import { distanceMetres } from "../lib/geo";
import { geolocationErrorMessage, getCurrentPosition } from "../lib/geolocation";
import { canNativeShare, shareUrl } from "../lib/share";
import { getSavedPin, removeSavedPin, savePin, updateSavedPin } from "../lib/storage";
import type { AppConfig, PinMeta } from "../types";

/**
 * The private control page (booted from /u/:slug#s_…). The secret is read
 * from the fragment, stripped from the URL, and held in memory only.
 *
 * Manual update is the primary control; the auto-update toggle ("Keep
 * updating", with a tooltip spelling out the limit) stops on
 * visibilitychange→hidden, saying so (§4).
 */

const AUTO_MOVE_METRES = 15;
const AUTO_INTERVAL_MS = 15_000;

// Armed two-tap confirm for replacing the control link: a generous window
// (reverting is always safe), minus a guard against accidental double-taps.
const ROTATE_ARMED_MS = 5_000;
const DOUBLE_TAP_GUARD_MS = 300;

// Screen Wake Lock (Chrome/Edge/Safari; not Firefox) — offered only where it
// exists, and only ever while the page is visible.
const WAKE_LOCK_SUPPORTED = typeof navigator !== "undefined" && "wakeLock" in navigator;

type WatchState = "off" | "on" | "paused-hidden";

export function ControlPage({ config, slug, endedBoot }: { config: AppConfig; slug: string; endedBoot: boolean }) {
  const secretRef = useRef<string | null>(null);
  const [secretMissing, setSecretMissing] = useState(false);
  const [meta, setMeta] = useState<PinMeta | null>(null);
  const [metaError, setMetaError] = useState<number | null>(null);
  const { status, position } = usePositionPoller(slug);
  const publicUrl = `${location.origin}/${slug}`;

  // Read the secret from the fragment once, then strip it from the URL
  // (history.replaceState — the fragment never reaches the server anyway).
  // A reload loses the fragment, so recover the secret from this device:
  // first the tab's stored session, then the saved current share. Only when
  // neither has it is the link truly unrecoverable.
  useEffect(() => {
    const match = /^#s_(.+)$/.exec(location.hash);
    if (match) {
      secretRef.current = match[1];
    } else {
      const stored = loadCreatedSession();
      const saved = getSavedPin(slug);
      const secret =
        stored?.slug === slug
          ? stored.secret
          : saved?.slug === slug
            ? saved.secret
            : null;
      if (!secret) {
        setSecretMissing(true);
        return;
      }
      secretRef.current = secret;
    }
    history.replaceState(null, "", location.pathname + location.search);
  }, []);

  const loadMeta = useCallback(async () => {
    if (!secretRef.current) return;
    try {
      const m = await api.getMeta(slug, secretRef.current);
      setMeta(m);
      setMetaError(null);
      updateSavedPin(slug, { label: m.label, expiresAt: m.expiresAt });
    } catch (err) {
      if (err instanceof ApiError) setMetaError(err.status);
    }
  }, [slug]);

  useEffect(() => {
    if (!secretMissing) void loadMeta();
  }, [secretMissing, loadMeta]);

  // A definitive failure (401 rotated secret / 404 unknown slug) means the
  // stored create-page session points here with a dead secret: drop it so
  // the create page stops redirecting to this link.
  useEffect(() => {
    if (metaError === 401 || metaError === 404) clearCreatedSessionFor(slug);
  }, [metaError, slug]);

  // One-time recovery-email result, handed over from the create page.
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  useEffect(() => {
    setEmailNotice(loadEmailNotice(slug));
  }, [slug]);

  if (secretMissing) {
    return (
      <section className="state-card" data-state="invalid">
        <h1>You don't have permission to modify this location share</h1>
        <p>This is the private page for managing a share, and its permission
        code isn't saved on this device or in this link. If someone shared
        their location with you, ask them to resend it — or start a share of
        your own.</p>
        <p>
          <a className="button primary" href="/">
            Home
          </a>
        </p>
      </section>
    );
  }

  if (metaError === 401) {
    return (
      <section className="state-card" data-state="invalid">
        <h1>This control link isn't valid</h1>
        <p>It may have been replaced when you rotated the link, or the pin was
        created elsewhere. If you have a newer control link, open that one.</p>
      </section>
    );
  }

  const ended =
    endedBoot || status === "ended" || meta?.status === "stopped" || (meta !== null && meta.expiresAt <= Date.now());

  if (!meta && metaError === null) {
    return (
      <section className="info-card">
        <p role="status">Loading your share…</p>
      </section>
    );
  }

  if (ended && meta) {
    return <EndedCard slug={slug} meta={meta} />;
  }
  if (!meta) {
    return (
      <section className="state-card" data-state="invalid">
        <h1>This share isn't available</h1>
      </section>
    );
  }

  return (
    <ControlPanel
      config={config}
      slug={slug}
      secretRef={secretRef}
      meta={meta}
      onMetaChanged={loadMeta}
      publicUrl={publicUrl}
      position={position}
      positionStatus={status}
      emailNotice={emailNotice}
    />
  );
}

function EndedCard({ slug, meta }: { slug: string; meta: PinMeta }) {
  useEffect(() => {
    removeSavedPin(slug);
    // The create page must not redirect back to this dead control link.
    clearCreatedSessionFor(slug);
  }, [slug]);
  return (
    <section className="state-card" data-state="ended">
      <h1>This share has ended</h1>
      <p>
        {meta.status === "stopped"
          ? "You stopped this share. The location has been deleted."
          : `This share expired ${relativeAge(Date.now() - meta.expiresAt)} ago. The location has been deleted.`}
      </p>
      <p>
        <a className="button primary" href="/">
          Share my location again
        </a>
        <a className="button secondary" href="/">
          Home
        </a>
      </p>
    </section>
  );
}

interface ControlPanelProps {
  config: AppConfig;
  slug: string;
  secretRef: React.RefObject<string | null>;
  meta: PinMeta;
  onMetaChanged: () => Promise<void>;
  publicUrl: string;
  position: ReturnType<typeof usePositionPoller>["position"];
  positionStatus: ReturnType<typeof usePositionPoller>["status"];
  emailNotice: string | null;
}

function ControlPanel(props: ControlPanelProps) {
  const { config, slug, secretRef, meta, onMetaChanged, publicUrl, position, emailNotice } = props;
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [copiedControl, setCopiedControl] = useState(false);
  const [shared, setShared] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const rotateBtnRef = useRef<HTMLButtonElement>(null);
  const rotateArmedAtRef = useRef(0);

  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);

  const [autoUpdate, setAutoUpdate] = useState(false);
  const [watchState, setWatchState] = useState<WatchState>("off");
  const watchIdRef = useRef<number | null>(null);
  const lastSentRef = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const [keepAwake, setKeepAwake] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const [moveMode, setMoveMode] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ lat: number; lng: number } | null>(null);

  const [remaining, setRemaining] = useState(meta.expiresAt - Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // Re-render trigger for after a rotation: the control-link row reads the
  // fresh secret from secretRef.
  const [rotated, setRotated] = useState(false);
  const [rotateArmed, setRotateArmed] = useState(false);

  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(Date.now());
      setRemaining(meta.expiresAt - Date.now());
    }, 1_000);
    return () => window.clearInterval(t);
  }, [meta.expiresAt]);

  // While the rotate button is armed: a generous window to tap again, closed
  // early by Escape, a press elsewhere, or scrolling away from the decision.
  useEffect(() => {
    if (!rotateArmed) return;
    const t = window.setTimeout(() => setRotateArmed(false), ROTATE_ARMED_MS);
    const onPointerDown = (e: PointerEvent) => {
      if (!rotateBtnRef.current?.contains(e.target as Node)) setRotateArmed(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRotateArmed(false);
    };
    const onScroll = () => setRotateArmed(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [rotateArmed]);

  const sendPosition = useCallback(
    async (pos: { lat: number; lng: number; accuracy: number | null }) => {
      if (!secretRef.current) return;
      try {
      const result = await api.setPosition(slug, secretRef.current, {
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy,
      });
        lastSentRef.current = { lat: pos.lat, lng: pos.lng, at: result.at };
        setLastSentAt(result.at);
        setUpdateError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) {
          setUpdateError("This share has ended.");
        } else {
          setUpdateError("Couldn't send your location — check your connection.");
        }
        throw err;
      }
    },
    [slug, secretRef],
  );

  async function updateNow() {
    setUpdating(true);
    setUpdateError(null);
    let fix: GeolocationPosition;
    try {
      fix = await getCurrentPosition();
    } catch (err) {
      setUpdateError(geolocationErrorMessage(err));
      setUpdating(false);
      return;
    }
    try {
      await sendPosition({
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        accuracy: fix.coords.accuracy ?? null,
      });
    } catch {
      // sendPosition already set updateError
    } finally {
      setUpdating(false);
    }
  }

  // Auto-update: watchPosition throttled to >15m movement or >15s elapsed,
  // stopped on hidden, resumed on visible. Never let the user believe it is
  // running when it isn't (§4).
  useEffect(() => {
    if (!autoUpdate) {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setWatchState("off");
      return;
    }

    const startWatch = () => {
      if (watchIdRef.current !== null) return;
      watchIdRef.current = navigator.geolocation.watchPosition(
        (fix) => {
          const last = lastSentRef.current;
          const coords = { lat: fix.coords.latitude, lng: fix.coords.longitude };
          const moved = last ? distanceMetres(last, coords) > AUTO_MOVE_METRES : true;
          const elapsed = last ? Date.now() - last.at > AUTO_INTERVAL_MS : true;
          if (moved || elapsed) {
            void sendPosition({ ...coords, accuracy: fix.coords.accuracy ?? null }).catch(() => {});
          }
        },
        (err) => setUpdateError(geolocationErrorMessage(err)),
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
      );
      setWatchState("on");
    };

    const stopWatch = (paused: boolean) => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setWatchState(paused ? "paused-hidden" : "off");
    };

    const onVisibility = () => (document.hidden ? stopWatch(true) : startWatch());
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) startWatch();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
  }, [autoUpdate, sendPosition]);

  // Screen Wake Lock: while enabled, hold a lock whenever the page is
  // visible. The browser releases the lock on its own when the page is
  // hidden — re-request on return, and let the note say what is true.
  useEffect(() => {
    if (!keepAwake) return;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || wakeLockRef.current || document.visibilityState !== "visible") return;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinel.addEventListener("release", () => {
          wakeLockRef.current = null;
          setWakeLockActive(false);
        });
        wakeLockRef.current = sentinel;
        setWakeLockActive(true);
      } catch {
        // Denied or unavailable (e.g. battery saver) — the note shows we are
        // not holding the screen rather than promising.
        setWakeLockActive(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLockRef.current?.release();
      wakeLockRef.current = null;
      setWakeLockActive(false);
    };
  }, [keepAwake]);

  async function moveToTarget() {
    if (!moveTarget) return;
    setBusy("move");
    setActionError(null);
    try {
      await sendPosition({ ...moveTarget, accuracy: null });
      setMoveTarget(null);
      setMoveMode(false);
    } catch {
      // sendPosition already set updateError
    } finally {
      setBusy(null);
    }
  }

  async function extend(ttlSeconds: number) {
    if (!secretRef.current) return;
    setBusy(`extend-${ttlSeconds}`);
    setActionError(null);
    try {
      await api.patchPin(slug, secretRef.current, { ttl: ttlSeconds });
      await onMetaChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't extend the share.");
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    if (!secretRef.current) return;
    setBusy("stop");
    setActionError(null);
    try {
      await api.stopPin(slug, secretRef.current);
      removeSavedPin(slug);
      clearCreatedSessionFor(slug);
      // Stopping is definitive — return to the create page for a fresh
      // share instead of showing the ended card here.
      location.assign("/");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't stop the share.");
      setBusy(null);
      setConfirmStop(false);
    }
  }

  async function rotate() {
    if (!secretRef.current) return;
    setBusy("rotate");
    setActionError(null);
    try {
      const result = await api.rotateSecret(slug, secretRef.current);
      secretRef.current = result.secret;
      const saved = getSavedPin(slug);
      if (saved) savePin({ ...saved, secret: result.secret });
      // The stored create-page session would redirect to this dead control URL.
      clearCreatedSessionFor(slug);
      setRotated(true);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't rotate the link.");
    } finally {
      setBusy(null);
      setRotateArmed(false);
    }
  }

  async function copyShareLink() {
    const ok = await copyText(publicUrl);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2_000);
  }

  // Rebuilt from the in-memory secret — the same URL the create page
  // redirected through, minus the fragment the page stripped on arrival.
  const controlUrl = `${location.origin}/u/${slug}#s_${secretRef.current ?? ""}`;

  async function copyControlLink() {
    const ok = await copyText(controlUrl);
    setCopiedControl(ok);
    if (ok) window.setTimeout(() => setCopiedControl(false), 2_000);
  }

  // Two-tap confirm: first tap arms (icon flips to a check), second tap
  // within the window rotates. A too-fast second tap is a double-click,
  // not a confirmation.
  function rotateClick() {
    const now = Date.now();
    if (!rotateArmed) {
      rotateArmedAtRef.current = now;
      setRotateArmed(true);
      return;
    }
    if (now - rotateArmedAtRef.current < DOUBLE_TAP_GUARD_MS) return;
    setRotateArmed(false);
    void rotate();
  }

  // Opens the OS share sheet for the PUBLIC link — never the control link.
  async function sharePublicLink() {
    const outcome = await shareUrl(publicUrl);
    if (outcome === "shared") {
      setShared(true);
      window.setTimeout(() => setShared(false), 2_000);
    } else if (outcome === "failed") {
      await copyShareLink();
    }
  }

  return (
    <section className="control-page">
      <div className="map-stack">
        <MapView
          config={config}
          position={moveTarget ?? position}
          follow
          fitAccuracyOnFirstFix
          overlayRef={cardRef}
          dimmed={watchState === "paused-hidden"}
          onMapClick={moveMode ? ({ lat, lng }) => setMoveTarget({ lat, lng }) : undefined}
        />
      </div>

      <div className="info-card control-card" ref={cardRef}>
        {/* Sticky at the top of the card: the title and the top-level Stop
            control stay visible even when the controls below are scrolled
            (§3 anti-footgun). */}
        <div className="panel-banner" role="note">
          <div className="banner-row">
            <strong>Share Control</strong>
            <button
              className="button danger small banner-stop"
              type="button"
              onClick={() => setConfirmStop(true)}
              disabled={busy === "stop"}
            >
              {busy === "stop" ? "Stopping…" : "Stop sharing"}
            </button>
          </div>
          {confirmStop && (
            <div className="confirm-row">
              <p>Stop sharing now? Your location is deleted and viewers see that the share has ended.</p>
              <div className="button-row">
                <button className="button danger" type="button" onClick={stop} disabled={busy === "stop"}>
                  {busy === "stop" ? "Stopping…" : "Yes, stop sharing"}
                </button>
                <button className="button ghost" type="button" onClick={() => setConfirmStop(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        {/* The live share status is important enough to sit above everything
            else in the card, where it stays visible without scrolling. */}
        <p className="field-note" role="status">
          {updateError
            ? updateError
            : lastSentAt
              ? position
                ? `Updated ${relativeAge(now - lastSentAt)} · ±${Math.round(position.accuracy ?? 0)} m`
                : `Updated ${relativeAge(now - lastSentAt)}`
              : position
                ? "Seen by viewers — no update sent from this screen yet"
                : "No location shared yet"}
        </p>
        {emailNotice && (
          <p className="field-note" role="status">
            {emailNotice === "sent"
              ? "Recovery email sent — check your inbox (and spam)."
              : emailNotice === "rate-limited"
                ? "Too many recovery emails sent to that address recently — copy the control link below."
                : "The recovery email could not be sent — copy the control link below."}
          </p>
        )}
        <div className="copy-block">
          <div className="copy-row">
            <input
              type="text"
              readOnly
              value={publicUrl}
              onFocus={(e) => e.target.select()}
              aria-label="Your share link"
            />
            {canNativeShare && (
              <button
                className={`button icon-button${shared ? " copied" : ""}`}
                type="button"
                onClick={sharePublicLink}
                aria-label="Share link via your apps"
                title="Share via your apps"
              >
                {shared ? <CheckIcon /> : <ShareIcon />}
              </button>
            )}
            <button
              className={`button icon-button${copied ? " copied" : ""}`}
              type="button"
              onClick={copyShareLink}
              aria-label="Copy share link"
              title="Copy share link"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
        </div>

        <div className="control-section">
          <div className="button-row wrap">
            <button className="button highlight" type="button" onClick={updateNow} disabled={updating}>
              {updating ? "Getting a fix…" : "Detect location"}
            </button>
            {moveMode ? (
              <>
                <button
                  className="button ok"
                  type="button"
                  onClick={moveToTarget}
                  disabled={!moveTarget || busy === "move"}
                >
                  {busy === "move" ? "Moving…" : "Confirm?"}
                </button>
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => {
                    setMoveMode(false);
                    setMoveTarget(null);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button className="button highlight" type="button" onClick={() => setMoveMode(true)}>
                Move pin
              </button>
            )}
          </div>
          {moveMode && (
            <p className="field-note" role="status">
              Tap the map to choose a point, then confirm.
            </p>
          )}

          {/* One status line under the row reflects what is actually
              happening, including whether the screen is being held on. */}
          <div className="toggle-row toggles-row">
            <span className="toggle-pair">
              <label className="toggle-row" htmlFor="auto-update">
                <input
                  id="auto-update"
                  type="checkbox"
                  checked={autoUpdate}
                  onChange={(e) => {
                    setAutoUpdate(e.target.checked);
                    if (!e.target.checked) setKeepAwake(false);
                  }}
                />
                <span>Keep updating</span>
              </label>
            </span>
            {WAKE_LOCK_SUPPORTED && autoUpdate && (
              <span className="toggle-pair">
                <label className="toggle-row" htmlFor="keep-awake">
                  <input
                    id="keep-awake"
                    type="checkbox"
                    checked={keepAwake}
                    onChange={(e) => setKeepAwake(e.target.checked)}
                  />
                  <span>Keep screen on</span>
                </label>
              </span>
            )}
          </div>
          {autoUpdate && (
            <p className="field-note" role="status">
              {watchState === "paused-hidden"
                ? "Paused — you switched away. Updates resume when you come back."
                : keepAwake
                  ? wakeLockActive
                    ? "Updating automatically — screen kept on."
                    : "Updating automatically — screen keep-on not active."
                  : "Updating automatically while this screen is open."}
            </p>
          )}
        </div>

        <div className="control-section">
          <div className="expiry-row">
            <button className="button highlight" type="button" onClick={() => extend(3_600)} disabled={busy?.startsWith("extend") ?? false}>
              +1 hour
            </button>
            <p className="field-note expiry-note">
              {remaining > 0 ? `${countdown(remaining)} left` : "expired"}
            </p>
            <InfoTooltip
              label="Expiry time"
              text={`Ends ${formatExpiry(meta.expiresAt)} — extending adds time from now, up to a 7-day maximum.`}
            />
          </div>
        </div>

        <div className="control-section danger-zone">
          <div className="label-row icon-row">
            <h2>Control link</h2>
            <button
              className={`button icon-button${copiedControl ? " copied" : ""}`}
              type="button"
              onClick={copyControlLink}
              aria-label="Copy control link"
              title="Copy control link"
            >
              {copiedControl ? <CheckIcon /> : <CopyIcon />}
            </button>
            <button
              ref={rotateBtnRef}
              className={`button icon-button${rotateArmed ? " armed" : ""}`}
              type="button"
              onClick={rotateClick}
              disabled={busy === "rotate"}
              aria-label={rotateArmed ? "Tap again to replace the control link" : "Replace control link"}
              aria-pressed={rotateArmed}
              title={rotateArmed ? "Tap again to replace the control link" : "Replace control link"}
            >
              {rotateArmed ? <CheckIcon /> : <RotateIcon />}
            </button>
            <InfoTooltip
              label="About the control link"
              above
              text="Saved on this device and hidden until you replace it. Never paste it into a chat — anyone holding it can move or stop your share."
            />
          </div>
          {/* The link itself is only revealed right after a rotation — at any
              other time showing it invites pasting the control link where the
              share link belongs. */}
          {rotated && (
            <div className="copy-row">
              <input
                type="text"
                readOnly
                value={controlUrl}
                onFocus={(e) => e.target.select()}
                aria-label="Your control link"
              />
            </div>
          )}
          <span className="visually-hidden" role="status">
            {rotateArmed ? "Tap again to replace the control link" : ""}
          </span>
          {rotated && (
            <p className="field-note" role="status">
              New link saved on this device — the old one no longer works.
            </p>
          )}
        </div>

        {actionError && (
          <p className="error-text" role="alert">
            {actionError}
          </p>
        )}
      </div>
    </section>
  );
}
