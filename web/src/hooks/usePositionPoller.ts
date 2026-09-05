import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Position } from "../types";

/**
 * Viewer polling: every 5s while the tab is visible, backing off
 * on repeated failure (5s → 10s → 30s, capped), resuming immediately on
 * visibilitychange→visible or an `online` event, stopping once ended.
 *
 * "Stale" is derived by the caller from `position` + the current time, so it
 * keeps updating between polls.
 */

export type PollerStatus =
  | "pending" // no fix yet (204)
  | "connected" // last poll succeeded and returned a position
  | "disconnected" // 2+ consecutive poll failures
  | "ended" // 410 — the share has ended
  | "notfound"; // 404 — the slug never existed

export interface PolledPosition extends Position {
  /** Server clock at the moment of the poll response. */
  serverNow: number;
  /** Client clock at the moment of the poll response. */
  fetchedAt: number;
}

const BASE_INTERVAL_MS = 5_000;
const BACKOFF_STEPS = [5_000, 10_000, 30_000];

export function usePositionPoller(slug: string) {
  const [status, setStatus] = useState<PollerStatus>("pending");
  const [position, setPosition] = useState<PolledPosition | null>(null);

  const failures = useRef(0);
  const timer = useRef<number | null>(null);
  const cancelled = useRef(false);
  const pollRef = useRef<() => Promise<void>>(async () => {});

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    if (!cancelled.current) {
      timer.current = window.setTimeout(() => void pollRef.current(), delayMs);
    }
  };

  pollRef.current = async () => {
    if (!slug || cancelled.current || document.hidden) return;
    try {
      const data = await api.getPosition(slug);
      failures.current = 0;
      if (data === null) {
        setStatus("pending");
        schedule(BASE_INTERVAL_MS);
        return;
      }
      setPosition({
        lat: data.lat,
        lng: data.lng,
        accuracy: data.accuracy,
        at: data.at,
        serverNow: data.now ?? Date.now(),
        fetchedAt: Date.now(),
        expiresAt: data.expiresAt,
      });
      setStatus("connected");
      schedule(BASE_INTERVAL_MS);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 410 || err.status === 404)) {
        setStatus(err.status === 410 ? "ended" : "notfound");
        clearTimer();
        return;
      }
      failures.current += 1;
      if (failures.current >= 2) setStatus("disconnected");
      schedule(BACKOFF_STEPS[Math.min(failures.current - 1, BACKOFF_STEPS.length - 1)]);
    }
  };

  useEffect(() => {
    cancelled.current = false;
    void pollRef.current();

    const onVisibility = () => {
      if (document.hidden) {
        clearTimer();
      } else {
        failures.current = 0; // resume immediately on return
        void pollRef.current();
      }
    };
    const onOnline = () => {
      failures.current = 0;
      void pollRef.current();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled.current = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [slug]);

  return { status, position, refresh: () => pollRef.current() };
}
