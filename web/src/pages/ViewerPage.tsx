import { useEffect, useRef, useState } from "react";
import { usePositionPoller, type PolledPosition } from "../hooks/usePositionPoller";
import { MapView } from "../components/MapView";
import { countdown, formatCoords, relativeAge } from "../lib/format";
import { handoffTargets } from "../lib/handoff";
import type { AppConfig } from "../types";

/**
 * The public viewer page. Three connection states, never conflated (§4):
 * live / stale / disconnected, plus ended. Ages are computed from the
 * server-supplied `now`, not the client clock.
 */

const STALE_AFTER_MS = 60_000;

export function ViewerPage({
  config,
  slug,
  label,
  expiresAt,
  endedBoot = false,
}: {
  config: AppConfig;
  slug: string;
  label: string | null;
  expiresAt: number;
  endedBoot?: boolean;
}) {
  const { status, position } = usePositionPoller(endedBoot ? "" : slug);
  const [now, setNow] = useState(Date.now());
  const [recenterToken, setRecenterToken] = useState(0);
  const [remaining, setRemaining] = useState(expiresAt - Date.now());
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(Date.now());
      setRemaining(expiresAt - Date.now());
    }, 1_000);
    return () => window.clearInterval(t);
  }, [expiresAt]);

  if (endedBoot || status === "ended" || remaining <= 0) {
    return (
      <section className="state-card" data-state="ended">
        <h1>This share has ended</h1>
        <p>The person sharing their location stopped the share, or it expired.
        Their position is no longer available.</p>
      </section>
    );
  }
  if (status === "notfound") {
    return (
      <section className="state-card" data-state="notfound">
        <h1>This link doesn't match a share</h1>
        <p>The pin never existed, or the link is incomplete. Ask the person who
        shared it with you to send it again.</p>
      </section>
    );
  }

  const freshness = freshnessOf(position, now);

  return (
    <section className="view-page">
      <div className="map-stack">
        <MapView
          config={config}
          position={position}
          follow
          fitAccuracyOnFirstFix
          recenterToken={recenterToken}
          overlayRef={cardRef}
          dimmed={status === "disconnected" || freshness === "stale"}
        />
        <button
          className="button map-button"
          type="button"
          onClick={() => setRecenterToken((t) => t + 1)}
          aria-label="Recenter on the shared location"
        >
          Recenter
        </button>
      </div>

      <div className="info-card" ref={cardRef}>
        <h1 className="pin-label">{label || "Live location"}</h1>

        {status === "pending" && (
          <p className="freshness pending" role="status">
            Waiting for the sender's first location…
          </p>
        )}

        {status === "disconnected" && (
          <p className="banner disconnected" role="alert">
            Can't reach the server — showing last known position
          </p>
        )}

        {position && (
          <p className={`freshness ${freshness}`} role="status">
            {freshness === "live"
              ? `Updated ${relativeAge(ageOf(position, now))}`
              : `Last update ${relativeAge(ageOf(position, now))}`}
            {status === "disconnected" ? " (offline)" : ""}
          </p>
        )}

        <p className="expiry field-note">Expires in {countdown(remaining)}</p>

        {position && (
          <details className="a11y-summary">
            <summary>Position details</summary>
            <p>
              Coordinates:{" "}
              <output>{formatCoords(position.lat, position.lng, position.accuracy)}</output>
            </p>
            <p>Updated: {relativeAge(ageOf(position, now))}</p>
            <div className="button-row wrap">
              {handoffTargets(position, label).map((target) => (
                <a key={target.name} className="button secondary small" href={target.url} target="_blank" rel="noopener noreferrer">
                  {target.name}
                </a>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function ageOf(position: PolledPosition, now: number): number {
  // Server age at fetch time, plus client elapsed time since the fetch —
  // immune to device clock skew (§4).
  return position.serverNow - position.at + (now - position.fetchedAt);
}

function freshnessOf(position: PolledPosition | null, now: number): "live" | "stale" {
  if (!position) return "stale";
  return ageOf(position, now) <= STALE_AFTER_MS ? "live" : "stale";
}
