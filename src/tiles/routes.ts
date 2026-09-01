import type { Env } from "../env";
import { errorJson } from "../lib/http";
import {
  HEADER_LENGTH,
  findEntry,
  parseDirectory,
  parseHeader,
  zxyToTileId,
  type DirectoryEntry,
  type PmtilesHeader,
} from "./pmtiles";

/**
 * PMTiles range-request proxy → R2 (PLAN.md §5, docs/TILES.md).
 *
 * MapLibre fetches individual tiles from `/tiles/{z}/{x}/{y}.mvt`; each
 * request is resolved through the archive's internal directory with two or
 * three ranged R2 reads (root dir → leaf dir → tile bytes). Directories are
 * cached per isolate so warm requests cost a single Class B operation.
 *
 * `/tiles/fonts/*` and `/tiles/sprites/*` are plain R2 pass-throughs for the
 * style's glyphs and icons (TILES.md §1).
 */

const TILE_CACHE_CONTROL = "public, max-age=2592000";
const TILEJSON_CACHE_CONTROL = "public, max-age=300";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors ODbL";

const dirCache = new Map<string, DirectoryEntry[]>();
const headerCache = new Map<string, { header: PmtilesHeader; metadata: Record<string, unknown> }>();
const probeCache = new Map<string, { available: boolean; at: number }>();
const PROBE_TTL_MS = 5 * 60 * 1000;

function cachePut<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (map.size >= cap) map.clear();
  map.set(key, value);
}

interface Ranged {
  bytes: Uint8Array;
  etag: string;
}

async function fetchRange(env: Env, key: string, offset: number, length: number): Promise<Ranged> {
  const obj = await env.TILES.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`R2 range miss for ${key}`);
  return { bytes: new Uint8Array(await obj.arrayBuffer()), etag: obj.httpEtag };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressInternal(bytes: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === 1) return bytes;
  if (compression === 2) return gunzip(bytes);
  throw new Error(`unsupported internal compression ${compression}`);
}

async function loadArchive(
  env: Env,
): Promise<{ header: PmtilesHeader; metadata: Record<string, unknown>; etag: string } | null> {
  const key = env.PMTILES_KEY;
  if (!key || !env.TILES) return null;
  // Archives are immutable per key in production, but key the caches by the
  // R2 ETag anyway: a refresh that reuses a key (or a test that overwrites
  // the object) then just looks like a new archive instead of serving a
  // stale directory.
  const head = await fetchRange(env, key, 0, HEADER_LENGTH);
  const cacheKey = `${key}@${head.etag}`;
  const cached = headerCache.get(cacheKey);
  if (cached) return { ...cached, etag: head.etag };

  const header = parseHeader(head.bytes);
  if (!header || header.specVersion !== 3) {
    console.error(`bad PMTiles header for ${key}`);
    return null;
  }
  let metadata: Record<string, unknown> = {};
  try {
    if (header.metadataLength > 0) {
      const raw = await decompressInternal(
        (
          await fetchRange(env, key, header.metadataOffset, header.metadataLength)
        ).bytes,
        header.internalCompression,
      );
      metadata = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    }
  } catch (err) {
    console.error("failed to read PMTiles metadata", err instanceof Error ? err.message : err);
  }
  const archive = { header, metadata };
  cachePut(headerCache, cacheKey, archive, 4);
  return { ...archive, etag: head.etag };
}

async function loadDirectory(
  env: Env,
  key: string,
  header: PmtilesHeader,
  etag: string,
  offset: number,
  length: number,
): Promise<DirectoryEntry[]> {
  const cacheKey = `${key}@${etag}:${offset}:${length}`;
  const cached = dirCache.get(cacheKey);
  if (cached) return cached;
  const raw = await decompressInternal(
    (await fetchRange(env, key, offset, length)).bytes,
    header.internalCompression,
  );
  const entries = parseDirectory(raw);
  cachePut(dirCache, cacheKey, entries, 64);
  return entries;
}

/** Cheap existence probe for /api/config — cached for a few minutes. */
export async function archiveAvailable(env: Env): Promise<boolean> {
  const key = env.PMTILES_KEY;
  if (!key || !env.TILES) return false;
  const probe = probeCache.get(key);
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.available;
  let available = false;
  try {
    const obj = await env.TILES.head(key);
    available = obj !== null && obj.size > HEADER_LENGTH;
  } catch {
    available = false;
  }
  cachePut(probeCache, key, { available, at: Date.now() }, 8);
  return available;
}

async function resolveTile(
  env: Env,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array | null> {
  const key = env.PMTILES_KEY;
  const archive = await loadArchive(env);
  if (!archive || !key) return null;
  const { header, etag } = archive;
  if (z < header.minZoom || z > header.maxZoom) return null;

  const tileId = zxyToTileId(z, x, y);
  let lookup = findEntry(
    await loadDirectory(env, key, header, etag, header.rootOffset, header.rootLength),
    tileId,
  );
  if (lookup.kind === "miss") return null;
  if (lookup.kind === "leaf") {
    const leaf = await loadDirectory(
      env,
      key,
      header,
      etag,
      header.leafOffset + lookup.offset,
      lookup.length,
    );
    lookup = findEntry(leaf, tileId);
    if (lookup.kind !== "tile") return null;
  }
  // Gzip'd tiles are passed through untouched — MapLibre detects and
  // inflates them client-side.
  return (
    await fetchRange(env, key, header.dataOffset + lookup.offset, lookup.length)
  ).bytes;
}

function r2ContentType(objectKey: string): string {
  if (objectKey.endsWith(".pbf")) return "application/x-protobuf";
  if (objectKey.endsWith(".json")) return "application/json; charset=utf-8";
  if (objectKey.endsWith(".png")) return "image/png";
  if (objectKey.endsWith(".webp")) return "image/webp";
  if (objectKey.endsWith(".jpg") || objectKey.endsWith(".jpeg")) return "image/jpeg";
  if (objectKey.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function tileJsonResponse(env: Env, origin: string): Promise<Response> {
  const archive = await loadArchive(env);
  if (!archive) return errorJson(503, "basemap not configured");
  const { header, metadata } = archive;
  const maxZoom = Math.min(
    header.maxZoom,
    Number.parseInt(env.TILES_MAXZOOM ?? "", 10) || header.maxZoom,
  );
  const body = {
    tilejson: "3.0.0",
    name: (metadata.name as string) ?? "Find Me basemap",
    description: (metadata.description as string) ?? undefined,
    attribution: (metadata.attribution as string) ?? OSM_ATTRIBUTION,
    tiles: [`${origin}/tiles/{z}/{x}/{y}.mvt`],
    minzoom: header.minZoom,
    maxzoom: maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    ...(metadata.vector_layers ? { vector_layers: metadata.vector_layers } : {}),
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": TILEJSON_CACHE_CONTROL,
    },
  });
}

export async function handleTiles(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorJson(405, "method not allowed");
  }

  const segments = url.pathname.slice("/tiles/".length).split("/").filter(Boolean);
  const isHead = request.method === "HEAD";

  if (segments[0] === "tiles.json") {
    const response = await tileJsonResponse(env, url.origin);
    return isHead ? withEmptyBody(response) : response;
  }

  // Glyphs and sprites: plain pass-through to the same bucket.
  if (segments[0] === "fonts" || segments[0] === "sprites") {
    let objectKey: string;
    try {
      objectKey = segments.map(decodeURIComponent).join("/");
    } catch {
      return errorJson(400, "malformed path");
    }
    const obj = await env.TILES.get(objectKey);
    if (!obj) return emptyResponse(404, isHead);
    return new Response(isHead ? null : obj.body, {
      headers: {
        "Content-Type": r2ContentType(objectKey),
        "Cache-Control": TILE_CACHE_CONTROL,
        Etag: obj.httpEtag,
      },
    });
  }

  // Vector tile: /tiles/{z}/{x}/{y}.mvt (MapLibre may request .pbf).
  const match = /^(\d+)\/(\d+)\/(\d+)\.(mvt|pbf)$/.exec(url.pathname.slice("/tiles/".length));
  if (!match) return emptyResponse(404, isHead);
  const [, zs, xs, ys] = match;
  const z = Number.parseInt(zs, 10);
  const x = Number.parseInt(xs, 10);
  const y = Number.parseInt(ys, 10);

  try {
    const bytes = await resolveTile(env, z, x, y);
    if (!bytes) return emptyResponse(204, isHead);
    return new Response(isHead ? null : bytes, {
      headers: {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        "Cache-Control": TILE_CACHE_CONTROL,
      },
    });
  } catch (err) {
    console.error("tile lookup failed", err instanceof Error ? err.message : err);
    return errorJson(502, "tile lookup failed");
  }
}

function emptyResponse(status: number, isHead: boolean): Response {
  return new Response(isHead ? null : undefined, { status });
}

function withEmptyBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
