import { zxyToTileId } from "../../src/tiles/pmtiles";

/**
 * Builds tiny but spec-conformant PMTiles v3 archives in memory so the range
 * proxy can be tested without a multi-gigabyte extract. Supports leaf
 * directories via `entriesPerDirectory`.
 */

export interface ArchiveTile {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

export interface ArchiveOptions {
  /** ≤ entries per directory; a second directory forces leaf directories. */
  entriesPerDirectory?: number;
  bounds?: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
}

interface RawEntry {
  tileId: number;
  runLength: number;
  length: number;
  offset: number;
}

const encoder = new TextEncoder();

export async function buildArchive(
  tiles: ArchiveTile[],
  opts: ArchiveOptions = {},
): Promise<Uint8Array> {
  const sorted = [...tiles].sort((a, b) => {
    const ta = zxyToTileId(a.z, a.x, a.y);
    const tb = zxyToTileId(b.z, b.x, b.y);
    return ta - tb;
  });

  // --- tile data section (contiguous, offsets from 0) ---
  const tileData: Uint8Array[] = [];
  const tileEntries: RawEntry[] = [];
  let cursor = 0;
  for (const tile of sorted) {
    tileData.push(tile.data);
    tileEntries.push({
      tileId: zxyToTileId(tile.z, tile.x, tile.y),
      runLength: 1,
      length: tile.data.byteLength,
      offset: cursor,
    });
    cursor += tile.data.byteLength;
  }

  // --- directories (optionally split into leaves) ---
  const per = opts.entriesPerDirectory ?? sorted.length;
  const chunks: RawEntry[][] = [];
  for (let i = 0; i < tileEntries.length; i += per) chunks.push(tileEntries.slice(i, i + per));

  const encodedLeaves: Uint8Array[] = [];
  const rootEntries: RawEntry[] = [];
  let leafCursor = 0;
  for (const chunk of chunks) {
    const encoded = await gzip(encodeDirectory(chunk));
    if (chunks.length === 1) {
      rootEntries.push(...chunk); // no leaves: root IS the directory
    } else {
      encodedLeaves.push(encoded);
      rootEntries.push({
        tileId: chunk[0].tileId,
        runLength: 0, // leaf pointer
        length: encoded.byteLength,
        offset: leafCursor,
      });
      leafCursor += encoded.byteLength;
    }
  }
  const rootDir = await gzip(encodeDirectory(rootEntries));

  const metadata = await gzip(
    encoder.encode(
      JSON.stringify({
        name: "findme-test",
        attribution: "© OpenStreetMap contributors ODbL",
        vector_layers: [{ id: "hello", fields: { name: "String" } }],
      }),
    ),
  );

  // --- layout ---
  const rootOffset = 127;
  const metaOffset = rootOffset + rootDir.byteLength;
  const leafOffset = metaOffset + metadata.byteLength;
  const dataOffset = leafOffset + encodedLeaves.reduce((n, l) => n + l.byteLength, 0);

  const zooms = sorted.map((t) => t.z);
  const bounds = opts.bounds ?? [-10, 49, 2, 61];
  const header = new Uint8Array(127);
  const view = new DataView(header.buffer);
  header.set(encoder.encode("PMTiles"), 0);
  header[7] = 3;
  view.setBigUint64(8, BigInt(rootOffset), true);
  view.setBigUint64(16, BigInt(rootDir.byteLength), true);
  view.setBigUint64(24, BigInt(metaOffset), true);
  view.setBigUint64(32, BigInt(metadata.byteLength), true);
  view.setBigUint64(40, BigInt(leafOffset), true);
  view.setBigUint64(48, BigInt(encodedLeaves.reduce((n, l) => n + l.byteLength, 0)), true);
  view.setBigUint64(56, BigInt(dataOffset), true);
  view.setBigUint64(64, BigInt(cursor), true);
  view.setBigUint64(72, BigInt(sorted.length), true);
  view.setBigUint64(80, BigInt(sorted.length), true);
  header[96] = 1; // clustered
  header[97] = 2; // internal compression: gzip
  header[98] = 1; // tile compression: none (synthetic bytes)
  header[99] = 1; // tile type: MVT
  header[100] = Math.min(...zooms);
  header[101] = Math.max(...zooms);
  e7(view, 102, bounds[0]);
  e7(view, 106, bounds[1]);
  e7(view, 110, bounds[2]);
  e7(view, 114, bounds[3]);
  header[118] = 2;
  e7(view, 119, (bounds[0] + bounds[2]) / 2);
  e7(view, 123, (bounds[1] + bounds[3]) / 2);

  const total = dataOffset + cursor;
  const out = new Uint8Array(total);
  out.set(header, 0);
  out.set(rootDir, rootOffset);
  out.set(metadata, metaOffset);
  let pos = leafOffset;
  for (const leaf of encodedLeaves) {
    out.set(leaf, pos);
    pos += leaf.byteLength;
  }
  pos = dataOffset;
  for (const tile of tileData) {
    out.set(tile, pos);
    pos += tile.byteLength;
  }
  return out;
}

function e7(view: DataView, offset: number, value: number): void {
  view.setInt32(offset, Math.round(value * 10_000_000), true);
}

function encodeDirectory(entries: RawEntry[]): Uint8Array {
  const buf: number[] = [];
  varint(buf, entries.length);

  let lastId = 0;
  for (const e of entries) {
    varint(buf, e.tileId - lastId);
    lastId = e.tileId;
  }
  for (const e of entries) varint(buf, e.runLength);
  for (const e of entries) varint(buf, e.length);
  let nextByte = 0;
  entries.forEach((e, i) => {
    if (i > 0 && e.offset === nextByte) varint(buf, 0);
    else varint(buf, e.offset + 1);
    nextByte = e.offset + e.length;
  });
  return new Uint8Array(buf);
}

function varint(buf: number[], value: number): void {
  let v = value;
  for (;;) {
    const b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v === 0) {
      buf.push(b);
      return;
    }
    buf.push(b | 0x80);
  }
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
