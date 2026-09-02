/**
 * Marks non-production environments (ENV_LABEL, e.g. staging's "beta") on
 * every HTML response — the page title gets a suffix and the header brand a
 * small badge — so a staging tab can never be mistaken for production.
 * Static and worker-rendered HTML are both covered because this runs on the
 * final response, whatever produced it.
 */
export async function withEnvLabel(res: Response, label: string): Promise<Response> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return res;

  let body = await res.text();
  body = body.replace(/<\/title>/i, ` (${label})</title>`);
  body = body.replace(
    /(<a class="brand" href="\/">Find&nbsp;Me<\/a>)/,
    `$1<span class="env-badge">${label}</span>`,
  );

  const headers = new Headers(res.headers);
  headers.delete("Content-Length"); // the rewritten body has a new length
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
