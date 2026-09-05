const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The label is user-controlled text rendered into server HTML — escape it
 * everywhere it appears. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Serialise boot data for the SPA. It is embedded in a
 * <script type="application/json"> block, so "<" must not appear literally
 * (it would let a crafted label close the tag) and U+2028/2029 must not
 * appear literally (they break JS string literals).
 */
export function bootJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function escapeUrlPath(value: string): string {
  return encodeURIComponent(value);
}
