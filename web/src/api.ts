import type { CreatedPin, PinMeta, Position } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request(
  method: string,
  path: string,
  opts: { secret?: string; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (opts.secret) headers["X-Pin-Secret"] = opts.secret;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    cache: "no-store",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  let data: { error?: string } & Record<string, unknown> = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // fall through to status-based error
  }
  if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" ? data.error : res.statusText);
  return data;
}

export const api = {
  async createPin(input: {
    lat?: number;
    lng?: number;
    accuracy?: number | null;
    label?: string;
    ttl: number;
    email?: string;
    turnstileToken?: string;
  }): Promise<CreatedPin> {
    return (await request("POST", "/api/pins", { body: input })) as CreatedPin;
  },

  /** null → no fix yet; throws ApiError(410) when the share has ended. */
  async getPosition(slug: string): Promise<Position | null> {
    const data = await request("GET", `/api/pins/${slug}/position`);
    return data as Position | null;
  },

  async setPosition(
    slug: string,
    secret: string,
    pos: { lat: number; lng: number; accuracy: number | null },
  ): Promise<{ at: number }> {
    return (await request("POST", `/api/pins/${slug}/position`, {
      secret,
      body: pos,
    })) as { at: number };
  },

  async getMeta(slug: string, secret: string): Promise<PinMeta> {
    return (await request("GET", `/api/pins/${slug}`, { secret })) as PinMeta;
  },

  async patchPin(
    slug: string,
    secret: string,
    body: { ttl?: number; label?: string | null },
  ): Promise<{ label: string | null; expiresAt: number }> {
    return (await request("PATCH", `/api/pins/${slug}`, { secret, body })) as {
      label: string | null;
      expiresAt: number;
    };
  },

  async stopPin(slug: string, secret: string): Promise<void> {
    await request("DELETE", `/api/pins/${slug}`, { secret });
  },

  async rotateSecret(slug: string, secret: string): Promise<{ secret: string; privateUrl: string }> {
    return (await request("POST", `/api/pins/${slug}/rotate`, { secret })) as {
      secret: string;
      privateUrl: string;
    };
  },
};
