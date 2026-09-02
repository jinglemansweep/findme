import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { CheckIcon, CopyIcon } from "../components/icons";
import { MapView } from "../components/MapView";
import { usePositionPoller } from "../hooks/usePositionPoller";
import { clearCreatedSessionFor } from "../lib/createdSession";
import { copyText } from "../lib/clipboard";
import { countdown, formatExpiry, relativeAge } from "../lib/format";
import { distanceMetres } from "../lib/geo";
import { geolocationErrorMessage, getCurrentPosition } from "../lib/geolocation";
import { getSavedPin, removeSavedPin, savePin, updateSavedPin } from "../lib/storage";
import type { AppConfig, PinMeta } from "../types";

/**
 * The private control page (booted from /u/:slug#s_…). The secret is read
 * from the fragment, stripped from the URL, and held in memory only.
 *
 * Manual update is the primary control; the auto-update toggle is honest
 * about what it does ("Keep updating while this screen is open") and stops
 * on visibilitychange→hidden, saying so (§4).
 */

const AUTO_MOVE_METRES = 15;
const AUTO_INTERVAL_MS = 15_000;

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
  useEffect(() => {
    const hash = location.hash;
    const match = /^#s_(.+)$/.exec(hash);
    if (match) {
      secretRef.current = match[1];
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      setSecretMissing(true);
    }
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

  if (secretMissing) {
    return (
      <section className="state-card" data-state="invalid">
        <h1>This control link is incomplete</h1>
        <p>The full link ends with a code after <code>#s_</code>. Use the exact
        link you were given (or the one saved on this device) — it can't be
        reconstructed from here.</p>
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
    />
  );
}

function EndedCard({ slug, meta }: { slug: string; meta: PinMeta }) {
  useEffect(() => {
    removeSavedPin(slug);
    // The create page must not resurrect its "share is live" panel for this.
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
}

function ControlPanel(props: ControlPanelProps) {
  const { config, slug, secretRef, meta, onMetaChanged, publicUrl, position } = props;
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);

  const [autoUpdate, setAutoUpdate] = useState(false);
  const [watchState, setWatchState] = useState<WatchState>("off");
  const watchIdRef = useRef<number | null>(null);
  const lastSentRef = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const [moveMode, setMoveMode] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ lat: number; lng: number } | null>(null);

  const [labelDraft, setLabelDraft] = useState(meta.label ?? "");
  const [remaining, setRemaining] = useState(meta.expiresAt - Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotated, setRotated] = useState<{ privateUrl: string } | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(Date.now());
      setRemaining(meta.expiresAt - Date.now());
    }, 1_000);
    return () => window.clearInterval(t);
  }, [meta.expiresAt]);

  useEffect(() => setLabelDraft(meta.label ?? ""), [meta.label]);

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

  async function saveLabel() {
    if (!secretRef.current) return;
    setBusy("label");
    setActionError(null);
    try {
      await api.patchPin(slug, secretRef.current, { label: labelDraft.trim() || null });
      await onMetaChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't save the message.");
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
      // The stored create-page panel would link to the dead old control URL.
      clearCreatedSessionFor(slug);
      setRotated({ privateUrl: result.privateUrl });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't rotate the link.");
    } finally {
      setBusy(null);
      setConfirmRotate(false);
    }
  }

  async function copyShareLink() {
    const ok = await copyText(publicUrl);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2_000);
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
        {/* Sticky at the top of the card: the warning stays visible even when
            the controls below are scrolled (§3 anti-footgun). */}
        <div className="control-banner" role="note">
          <strong>This is your private control page.</strong>
          <p>
            Anyone holding this link can move or stop your share — never paste
            it into a chat. To let people follow you, use the copy button
            beside the share link below.
          </p>
        </div>
        <div className="copy-block primary-copy">
          <h2>Let people follow you</h2>
          <div className="copy-row">
            <input type="text" readOnly value={publicUrl} onFocus={(e) => e.target.select()} />
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
          <p className="field-note">This is the safe link to paste into chats. It only shows your location.</p>
        </div>

        <div className="control-section">
          <h2>Your location</h2>
          <div className="button-row wrap">
            <button className="button primary" type="button" onClick={updateNow} disabled={updating}>
              {updating ? "Getting a fix…" : "Detect location"}
            </button>
            {moveMode ? (
              <>
                <button
                  className="button secondary"
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
              <button className="button secondary" type="button" onClick={() => setMoveMode(true)}>
                Move pin manually
              </button>
            )}
          </div>
          {moveMode && (
            <p className="field-note" role="status">
              Tap the map to choose a point, then confirm.
            </p>
          )}
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

          <label className="toggle-row" htmlFor="auto-update">
            <input
              id="auto-update"
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
            />
            <span>Keep updating while this screen is open</span>
          </label>
          {autoUpdate && (
            <p className="field-note" role="status">
              {watchState === "paused-hidden"
                ? "Paused — you switched away from this screen. Updates resume when you come back."
                : "Updating automatically while this screen is open."}
            </p>
          )}
        </div>

        <div className="control-section">
          <h2>Message</h2>
          <div className="copy-row">
            <input
              type="text"
              maxLength={140}
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder="e.g. Meet me at the car"
            />
            <button className="button secondary" type="button" onClick={saveLabel} disabled={busy === "label" || labelDraft === (meta.label ?? "")}>
              {busy === "label" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <div className="control-section">
          <h2>Expiry</h2>
          <p className="field-note">
            Expires in {countdown(remaining)} — {formatExpiry(meta.expiresAt)}
          </p>
          <div className="button-row wrap">
            <button className="button secondary" type="button" onClick={() => extend(3_600)} disabled={busy?.startsWith("extend") ?? false}>
              +1 hour
            </button>
            <button className="button secondary" type="button" onClick={() => extend(14_400)} disabled={busy?.startsWith("extend") ?? false}>
              +4 hours
            </button>
            <button className="button secondary" type="button" onClick={() => extend(86_400)} disabled={busy?.startsWith("extend") ?? false}>
              +24 hours
            </button>
          </div>
          <p className="field-note">Maximum 7 days from now.</p>
        </div>

        <div className="control-section danger-zone">
          <h2>Link safety</h2>
          {rotated ? (
            <div className="copy-block">
              <p className="field-note">New control link (saved on this device, old one no longer works):</p>
              <div className="copy-row">
                <input type="text" readOnly value={rotated.privateUrl} onFocus={(e) => e.target.select()} />
              </div>
            </div>
          ) : confirmRotate ? (
            <div className="confirm-row">
              <p>Replace the control link? The previous one stops working immediately.</p>
              <div className="button-row">
                <button className="button secondary" type="button" onClick={rotate} disabled={busy === "rotate"}>
                  {busy === "rotate" ? "Rotating…" : "Yes, replace link"}
                </button>
                <button className="button ghost" type="button" onClick={() => setConfirmRotate(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="button secondary" type="button" onClick={() => setConfirmRotate(true)}>
              Replace control link
            </button>
          )}
        </div>

        <div className="control-section danger-zone">
          <h2>Stop sharing</h2>
          {confirmStop ? (
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
          ) : (
            <button className="button danger" type="button" onClick={() => setConfirmStop(true)}>
              Stop sharing
            </button>
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
