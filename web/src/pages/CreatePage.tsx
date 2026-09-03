import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { CheckIcon, CloseIcon, CopyIcon } from "../components/icons";
import { MapView } from "../components/MapView";
import { Turnstile } from "../components/Turnstile";
import { loadCreatedSession, storeCreatedSession } from "../lib/createdSession";
import { copyText } from "../lib/clipboard";
import { countdown, formatCoords, formatExpiry } from "../lib/format";
import { geolocationErrorMessage, getCurrentPosition } from "../lib/geolocation";
import { listSavedPins, savePin } from "../lib/storage";
import type { AppConfig, CreatedPin, SavedPin } from "../types";

const TTL_OPTIONS = [
  { value: 900, label: "15 minutes" },
  { value: 3_600, label: "1 hour" },
  { value: 14_400, label: "4 hours" },
  { value: 86_400, label: "24 hours" },
  { value: 604_800, label: "7 days" },
];

export function CreatePage({ config }: { config: AppConfig }) {
  const [position, setPosition] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(3_600);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPin | null>(null);
  const [saved, setSaved] = useState<SavedPin[]>([]);
  const cardRef = useRef<HTMLDivElement>(null);

  // Non-production marker (staging's "beta"): this page's shell is a static
  // asset the Worker never renders, so the label is applied client-side
  // from the config (worker-rendered pages are labelled server-side).
  useEffect(() => {
    if (!config.envLabel) return;
    document.title = `${document.title} (${config.envLabel})`;
    document
      .querySelector(".app-header .brand")
      ?.insertAdjacentHTML("afterend", `<span class="env-badge">${config.envLabel}</span>`);
  }, [config.envLabel]);

  // Restore the "share is live" panel only if the pin really is still live —
  // it may have been stopped or rotated from the control page since.
  useEffect(() => {
    const stored = loadCreatedSession();
    if (!stored) return;
    let cancelled = false;
    api
      .getMeta(stored.slug, stored.secret)
      .then((meta) => {
        if (cancelled) return;
        if (meta.status === "active") setCreated(stored);
        else storeCreatedSession(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Definitively gone (rotated secret / unknown slug) — drop it. On an
        // inconclusive failure (offline, rate-limited) assume it is live.
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
          storeCreatedSession(null);
        } else {
          setCreated(stored);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => setSaved(listSavedPins()), [created]);

  // Offer the visitor's location as soon as the form opens rather than
  // waiting for the button: an undecided permission raises the browser
  // prompt, a granted one fixes silently, and a denied one stays quiet (the
  // button and map tap remain). Skipped when a share is about to restore.
  useEffect(() => {
    if (!("geolocation" in navigator) || loadCreatedSession()) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (!cancelled && status.state !== "denied") void useMyLocation();
      })
      .catch(() => {
        // Permissions API missing or picky — the button stays the path.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canCreate = Boolean(position) && !creating && (!config.turnstileSiteKey || Boolean(turnstileToken));

  async function useMyLocation() {
    setLocating(true);
    setGeoError(null);
    try {
      const fix = await getCurrentPosition();
      setPosition({
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        accuracy: fix.coords.accuracy ?? null,
      });
      setRecenterToken((t) => t + 1);
    } catch (err) {
      setGeoError(geolocationErrorMessage(err));
    } finally {
      setLocating(false);
    }
  }

  async function create() {
    if (!position) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api.createPin({
        lat: position.lat,
        lng: position.lng,
        accuracy: position.accuracy,
        label: label.trim() || undefined,
        ttl,
        email: emailEnabled && email.trim() ? email.trim() : undefined,
        turnstileToken: turnstileToken ?? undefined,
      });
      savePin({
        slug: result.slug,
        secret: result.secret,
        label: label.trim() || null,
        createdAt: Date.now(),
        expiresAt: result.expiresAt,
        lat: position.lat,
        lng: position.lng,
      });
      storeCreatedSession(result);
      setCreated(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the pin. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  }

  function resetForNewPin() {
    storeCreatedSession(null);
    setCreated(null);
    setPosition(null);
    setLabel("");
    setEmail("");
    setEmailEnabled(false);
    setTurnstileToken(null);
    setGeoError(null);
  }

  return (
    <section className="create-page">
      <div className="map-stack">
        <MapView
          config={config}
          position={position}
          recenterToken={recenterToken}
          overlayRef={cardRef}
          onMapClick={
            created
              ? undefined
              : ({ lat, lng }) => {
                  setGeoError(null);
                  setPosition({ lat, lng, accuracy: null });
                  setRecenterToken((t) => t + 1);
                }
          }
          showAccuracy={false}
        />
      </div>

      <div className="info-card" ref={cardRef}>
        {created ? (
          <CreatedPanel created={created} onReset={resetForNewPin} />
        ) : (
          <>
            <div className="form-field">
              <button className="button secondary" type="button" onClick={useMyLocation} disabled={locating}>
                {locating ? "Finding you…" : "Use my location"}
              </button>
              <p className="field-note">or tap the map to place your pin</p>
              {geoError && (
                <p className="error-text" role="alert">
                  {geoError}
                </p>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="label">Message (optional)</label>
              <input
                id="label"
                type="text"
                maxLength={140}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Meet me at the car"
              />
            </div>

            <div className="form-field">
              <label htmlFor="ttl">Share expires after</label>
              <select id="ttl" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                {TTL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label className="toggle-row" htmlFor="email-toggle">
                <input
                  id="email-toggle"
                  type="checkbox"
                  checked={emailEnabled}
                  onChange={(e) => setEmailEnabled(e.target.checked)}
                />
                <span>Email me a recovery link (optional)</span>
              </label>
              {emailEnabled && (
                <>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                  <details className="help-details">
                    <summary>Why?</summary>
                    <p className="field-note">
                      Sent once, right now, then the address is discarded. Only tick this if
                      you might lose this browser's saved link.
                    </p>
                  </details>
                </>
              )}
            </div>

            {config.turnstileSiteKey && (
              <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />
            )}

            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}

            <button className="button primary big" type="button" onClick={create} disabled={!canCreate}>
              {creating ? "Sharing…" : "Share"}
            </button>
            <p className="field-note">
              Anyone with the share link can see this location until it expires.
              Nothing is stored after that.
            </p>
          </>
        )}

        <SavedPinsList saved={saved} />
      </div>
    </section>
  );
}

function CreatedPanel({ created, onReset }: { created: CreatedPin; onReset: () => void }) {
  const [copied, setCopied] = useState<"public" | "private" | null>(null);
  const [remaining, setRemaining] = useState(created.expiresAt - Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setRemaining(created.expiresAt - Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [created.expiresAt]);

  async function copy(which: "public" | "private") {
    const ok = await copyText(which === "public" ? created.publicUrl : created.privateUrl);
    setCopied(ok ? which : null);
    if (ok) window.setTimeout(() => setCopied(null), 2_000);
  }

  return (
    <div className="created-panel">
      <div className="panel-header">
        <h1>Your share is live</h1>
        <button className="button ghost icon-button panel-close" type="button" onClick={onReset} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      <p className="field-note">
        Expires in {countdown(remaining)} ({formatExpiry(created.expiresAt)}).
      </p>

      <div className="copy-block">
        <h2>Send this to people</h2>
        <div className="copy-row">
          <input type="text" readOnly value={created.publicUrl} onFocus={(e) => e.target.select()} />
          <button
            className={`button icon-button${copied === "public" ? " copied" : ""}`}
            type="button"
            onClick={() => copy("public")}
            aria-label="Copy share link"
            title="Copy share link"
          >
            {copied === "public" ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      <div className="copy-block private">
        <h2>Your control link (already saved on this device)</h2>
        <div className="copy-row">
          <input type="text" readOnly value={created.privateUrl} onFocus={(e) => e.target.select()} />
          <button
            className={`button icon-button${copied === "private" ? " copied" : ""}`}
            type="button"
            onClick={() => copy("private")}
            aria-label="Copy control link"
            title="Copy control link"
          >
            {copied === "private" ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        <p className="field-note warning">
          Don't paste this one into a chat — anyone holding it can move or stop
          your share.
        </p>
      </div>

      {created.email && (
        <p className="field-note" role="status">
          {created.email === "sent"
            ? "Recovery email sent — check your inbox (and spam)."
            : created.email === "rate-limited"
              ? "Too many recovery emails sent to that address recently — copy the control link now."
              : "The recovery email could not be sent — copy the control link now."}
        </p>
      )}

      <div className="button-row">
        <a className="button primary big" href={created.privateUrl}>
          Edit
        </a>
      </div>
    </div>
  );
}

function SavedPinsList({ saved }: { saved: SavedPin[] }) {
  const now = Date.now();
  const active = useMemo(() => saved.filter((p) => p.expiresAt > now), [saved, now]);
  if (active.length === 0) return null;
  return (
    <div className="saved-pins">
      <h2>Sharing from this device</h2>
      <ul>
        {active.map((pin) => (
          <li key={pin.slug}>
            <a className="saved-link" href={`/u/${pin.slug}#s_${pin.secret}`}>
              {pin.label ||
                (pin.lat != null && pin.lng != null ? formatCoords(pin.lat, pin.lng, null) : "Untitled pin")}
            </a>
            <span className="field-note">expires in {countdown(pin.expiresAt - now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
