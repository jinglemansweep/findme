/**
 * Web Share API helpers — the OS share sheet (WhatsApp, email, SMS, …).
 * Callers must only ever hand it the PUBLIC link: the control link must
 * never enter a share sheet.
 */

/** False where the API is absent (Firefox, Linux desktop) — hide the button. */
export const canNativeShare = typeof navigator.share === "function";

export type ShareOutcome = "shared" | "cancelled" | "failed";

export async function shareUrl(url: string, title = "Find Me"): Promise<ShareOutcome> {
  try {
    await navigator.share({ title, url });
    return "shared";
  } catch (err) {
    // Closing the sheet without sharing is not an error.
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    return "failed";
  }
}
