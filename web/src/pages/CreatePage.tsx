import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { InfoTooltip } from "../components/InfoTooltip";
import { MapView } from "../components/MapView";
import { Turnstile } from "../components/Turnstile";
import { loadCreatedSession, storeCreatedSession, storeEmailNotice } from "../lib/createdSession";
import { geolocationErrorMessage, getCurrentPosition } from "../lib/geolocation";
import { savePin } from "../lib/storage";
import type { AppConfig } from "../types";

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

  // A stored session means this tab already has a live share: funnel
  // straight into its control page. No liveness check here — the control
  // page owns the stopped / expired / rotated-link states and clears the
  // session when it is definitively dead.
  useEffect(() => {
    const stored = loadCreatedSession();
    if (stored) location.replace(stored.privateUrl);
  }, []);

  // Offer the visitor's location as soon as the form opens rather than
  // waiting for the button: an undecided permission raises the browser
  // prompt, a granted one fixes silently, and a denied one stays quiet (the
  // button and map tap remain). Skipped when a stored session is about to
  // redirect to the control page.
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
      if (result.email) storeEmailNotice(result.slug, result.email);
      // The control page owns the share from here. replace() keeps the form
      // out of history so Back doesn't return to a page that redirects.
      location.replace(result.privateUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the pin. Check your connection and try again.");
      setCreating(false);
    }
  }

  return (
    <section className="create-page">
      <div className="map-stack">
        <MapView
          config={config}
          position={position}
          recenterToken={recenterToken}
          overlayRef={cardRef}
          onMapClick={({ lat, lng }) => {
            setGeoError(null);
            setPosition({ lat, lng, accuracy: null });
            setRecenterToken((t) => t + 1);
          }}
          showAccuracy={false}
        />
      </div>

      <div className="info-card" ref={cardRef}>
        <div className="form-field">
          <div className="button-row wrap">
                <button className="button primary small" type="button" onClick={create} disabled={!canCreate}>
                  {creating ? "Sharing…" : "Share"}
                </button>
                <button className="button highlight small" type="button" onClick={useMyLocation} disabled={locating}>
                  {locating ? "Finding you…" : "Use my location"}
                </button>
            <InfoTooltip text="Anyone with the share link can see this location until it expires. Nothing is stored after that." />
          </div>
          <p className="field-note">or tap the map to place your pin</p>
          {geoError && (
            <p className="error-text" role="alert">
              {geoError}
            </p>
          )}
        </div>

        <div className="field-row">
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
          <div className="form-field expiry">
            <label htmlFor="ttl">Expires after</label>
            <select id="ttl" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
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
      </div>
    </section>
  );
}
