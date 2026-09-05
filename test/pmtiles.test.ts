import { beforeEach, describe, expect, it } from "vitest";
import { exports, env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { findEntry, parseDirectory, parseHeader, zxyToTileId } from "../src/tiles/pmtiles";
import { buildArchive, type ArchiveTile } from "./helpers/pmtilesArchive";

const e = env as unknown as Env;
const ARCHIVE_KEY = "uk.pmtiles"; // matches PMTILES_KEY in wrangler.jsonc

const tile = (z: number, x: number, y: number, tag: string): ArchiveTile => ({
  z,
  x,
  y,
  data: new TextEncoder().encode(`tile:${tag}`),
});

async function get(path: string, method = "GET"): Promise<Response> {
  return exports.default.fetch(new Request(`http://localhost${path}`, { method }));
}

describe("PMTiles format", () => {
  it("converts z/x/y to Hilbert tile IDs (spec vectors)", () => {
    expect(zxyToTileId(0, 0, 0)).toBe(0);
    expect(zxyToTileId(1, 0, 0)).toBe(1);
    expect(zxyToTileId(1, 0, 1)).toBe(2);
    expect(zxyToTileId(1, 1, 1)).toBe(3);
    expect(zxyToTileId(1, 1, 0)).toBe(4);
    expect(zxyToTileId(2, 0, 0)).toBe(5);
    expect(zxyToTileId(12, 3423, 1763)).toBe(19_078_479);
  });

  it("rejects coordinates outside the zoom", () => {
    expect(() => zxyToTileId(2, 4, 0)).toThrow();
    expect(() => zxyToTileId(16, 0, 0)).toThrow();
  });
});

describe("tiles proxy", () => {
  beforeEach(async () => {
    await e.TILES.delete(ARCHIVE_KEY);
  });

  it("serves tiles and TileJSON from a flat-archive R2 object", async () => {
    const archive = await buildArchive([
      tile(0, 0, 0, "world"),
      tile(1, 0, 0, "z1nw"),
      tile(1, 0, 1, "z1sw"),
    ]);
    await e.TILES.put(ARCHIVE_KEY, archive);

    const tileRes = await get("/tiles/1/0/0.mvt");
    expect(tileRes.status).toBe(200);
    expect(tileRes.headers.get("Content-Type")).toBe("application/vnd.mapbox-vector-tile");
    expect(tileRes.headers.get("Cache-Control")).toContain("max-age");
    expect(await tileRes.text()).toBe("tile:z1nw");

    // HEAD works too (docs/TILES.md verifies with curl -sI).
    const headRes = await get("/tiles/1/0/0.mvt", "HEAD");
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Cache-Control")).toContain("max-age");

    const tileJson = await get("/tiles/tiles.json");
    expect(tileJson.status).toBe(200);
    const spec = (await tileJson.json()) as Record<string, unknown>;
    expect(spec.tilejson).toBe("3.0.0");
    expect(spec.tiles).toEqual(["http://localhost/tiles/{z}/{x}/{y}.mvt"]);
    expect(spec.attribution).toContain("OpenStreetMap");
    expect(spec.minzoom).toBe(0);
    expect(spec.maxzoom).toBe(1);
    expect(spec.bounds).toEqual([-10, 49, 2, 61]);
    expect(spec.vector_layers).toEqual([{ id: "hello", fields: { name: "String" } }]);
  });

  it("answers 204 for tiles outside the archive", async () => {
    await e.TILES.put(ARCHIVE_KEY, await buildArchive([tile(0, 0, 0, "world")]));
    const res = await get("/tiles/1/1/1.mvt");
    expect(res.status).toBe(204);
  });

  it("follows leaf directories", async () => {
    // entriesPerDirectory: 2 → three chunks → root of leaf pointers.
    const tiles = [
      tile(2, 0, 0, "a"),
      tile(2, 0, 1, "b"),
      tile(2, 1, 0, "c"),
      tile(2, 1, 1, "d"),
      tile(3, 0, 0, "e"),
    ];
    await e.TILES.put(ARCHIVE_KEY, await buildArchive(tiles, { entriesPerDirectory: 2 }));

    for (const t of tiles) {
      const res = await get(`/tiles/${t.z}/${t.x}/${t.y}.mvt`);
      expect(res.status, `${t.z}/${t.x}/${t.y}`).toBe(200);
      expect(await res.text()).toBe(new TextDecoder().decode(t.data));
    }
  });

  it("proxies glyphs from R2", async () => {
    await e.TILES.put("fonts/Noto Sans Regular/0-255.pbf", new Uint8Array([1, 2, 3]));
    const res = await get("/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-protobuf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("404s glyphs that were never uploaded", async () => {
    expect((await get("/tiles/fonts/Missing/0-255.pbf")).status).toBe(404);
  });

  it("405s non-GET/HEAD requests", async () => {
    expect((await get("/tiles/0/0/0.mvt", "POST")).status).toBe(405);
  });

  it("400s glyph paths that do not decode", async () => {
    expect((await get("/tiles/fonts/%E0%A4%A")).status).toBe(400);
  });
});

describe("archive validation", () => {
  it("rejects short buffers and buffers without the PMTiles magic", () => {
    expect(parseHeader(new Uint8Array(126))).toBeNull();
    expect(parseHeader(new Uint8Array(127))).toBeNull(); // no magic
  });

  it("serves 503 from TileJSON for a non-v3 archive", async () => {
    const bad = await buildArchive([tile(0, 0, 0, "x")]);
    bad[7] = 2; // specVersion — anything but 3 is refused
    await e.TILES.put(ARCHIVE_KEY, bad);
    expect((await get("/tiles/tiles.json")).status).toBe(503);
  });
});

describe("directory parsing (unit, against real archive bytes)", () => {
  it("parses the header and root directory from R2", async () => {
    const tiles = [tile(0, 0, 0, "world"), tile(1, 0, 0, "nw"), tile(1, 0, 1, "sw")];
    const archive = await buildArchive(tiles);
    await e.TILES.put(ARCHIVE_KEY, archive);

    const head = await e.TILES.get(ARCHIVE_KEY, { range: { offset: 0, length: 127 } });
    expect(head).not.toBeNull();
    const header = parseHeader(new Uint8Array(await head!.arrayBuffer()));
    expect(header).not.toBeNull();
    expect(header!.specVersion).toBe(3);
    expect(header!.minZoom).toBe(0);
    expect(header!.maxZoom).toBe(1);
    expect(header!.tileType).toBe(1);
    expect(header!.internalCompression).toBe(2);
    expect(header!.minLon).toBeCloseTo(-10, 5);

    const dirBlob = await e.TILES.get(ARCHIVE_KEY, {
      range: { offset: header!.rootOffset, length: header!.rootLength },
    });
    expect(dirBlob).not.toBeNull();
    const stream = new Blob([new Uint8Array(await dirBlob!.arrayBuffer())])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const dirBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const entries = parseDirectory(dirBytes);
    expect(entries.map((x) => x.tileId)).toEqual([0, 1, 2]);
    for (const entry of entries) expect(entry.runLength).toBe(1);
    // Contiguous tiles: offsets decode to 0, 10, 17 ("tile:world" is 10 bytes).
    expect(entries[0].offset).toBe(0);
    expect(entries[1].offset).toBe(10);
    expect(entries[2].offset).toBe(17);
  });

  it("misses when the tile ID falls between entries", () => {
    const dir = [
      { tileId: 5, runLength: 1, length: 10, offset: 0 },
      { tileId: 40, runLength: 2, length: 10, offset: 10 },
    ];
    expect(findEntry(dir, 4)).toEqual({ kind: "miss" });
    expect(findEntry(dir, 6)).toEqual({ kind: "miss" });
    expect(findEntry(dir, 5)).toEqual({ kind: "tile", offset: 0, length: 10 });
    expect(findEntry(dir, 41)).toEqual({ kind: "tile", offset: 10, length: 10 });
    expect(findEntry(dir, 42)).toEqual({ kind: "miss" });
  });

  it("resolves leaf pointers to the leaf directory section", () => {
    const dir = [
      { tileId: 0, runLength: 0, length: 30, offset: 0 },
      { tileId: 10, runLength: 0, length: 30, offset: 30 },
    ];
    expect(findEntry(dir, 5)).toEqual({ kind: "leaf", offset: 0, length: 30 });
    expect(findEntry(dir, 15)).toEqual({ kind: "leaf", offset: 30, length: 30 });
    // The last leaf covers everything beyond it — the proxy then misses
    // *inside* that leaf, which is where the 204 comes from.
    expect(findEntry(dir, 99)).toEqual({ kind: "leaf", offset: 30, length: 30 });
  });
});
