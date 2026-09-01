import type { Env } from "../env";
import { bufferToHex } from "../lib/auth";

const SENDER = "noreply@mail.narks.uk";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export type EmailResult = "sent" | "failed" | "rate-limited" | "skipped";

function formatExpiry(expiresAtMs: number): string {
  return `${new Date(expiresAtMs).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/**
 * The one recovery path for a lost private URL: sent once, at creation,
 * best-effort (PLAN.md §9).
 *
 * The body is pure template — no label, no user-controlled text of any kind.
 * Otherwise it would be a free channel to send arbitrary content to
 * arbitrary inboxes over our domain's reputation. The address is discarded
 * as soon as send() resolves and is never written to D1.
 */
export async function sendRecoveryEmail(
  env: Env,
  to: string,
  privateLink: string,
  expiresAtMs: number,
): Promise<EmailResult> {
  if (!env.EMAIL) return "skipped";
  const address = to.trim().toLowerCase();
  if (address.length > 254 || !EMAIL_RE.test(address)) return "skipped";

  // Per-recipient quota needs exact global counting (§11) — one EmailLimiter
  // object per sha256(recipient), which deletes itself when the window ends.
  let allowed = true;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
    const id = env.EMAIL_LIMITER.idFromName(bufferToHex(digest));
    const check = await env.EMAIL_LIMITER.get(id).check();
    allowed = check.ok;
  } catch (err) {
    console.error("email limiter failed", err instanceof Error ? err.message : err);
  }
  if (!allowed) return "rate-limited";

  const text = [
    "You created a location share on Find Me.",
    "",
    "Your private control link (keep this to yourself):",
    privateLink,
    "",
    `This share expires at ${formatExpiry(expiresAtMs)}, after which the link stops working`,
    "and the location is deleted.",
    "",
    "Warning: anyone holding the private link above can move or stop your share.",
    "The link you send to other people is different — it only shows your location.",
    "",
    "If you did not create this share you can ignore this email; nothing else",
    "will be sent. This is the only email Find Me will ever send you.",
  ].join("\r\n");

  try {
    await env.EMAIL.send({
      from: SENDER,
      to: address,
      subject: "Your Find Me private link",
      text,
    });
    return "sent";
  } catch (err) {
    // Never fail pin creation on the send — the link is already on screen.
    console.error("email send failed", err instanceof Error ? err.message : err);
    return "failed";
  }
}
