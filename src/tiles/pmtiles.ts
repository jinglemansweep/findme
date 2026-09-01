/**
 * PMTiles v3 format reader (https://github.com/protomaps/PMTiles — spec/v3).
 *
 * An archive is: 127-byte header · root directory · JSON metadata · leaf
 * directories · tile data. Directories are gzip'd varint blocks mapping a
 * Hilbert tile ID to an offset+length in the tile data section; entries with
 * run length 0 point at leaf directories instead.
 *
 * Pure functions only — R2 access lives in routes.ts.
 */

export const HEADER_LENGTH = 127;

export interface PmtilesHeader {
  specVersion: number;
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  dataOffset: number;
  dataLength: number;
  clustered: boolean;
  /** 1 = none, 2 = gzip */
  internalCompression: number;
  /** 1 = none, 2 = gzip */
  tileCompression: number;
  /** 1 = MVT, 6 = MapLibre vector tile (per spec §3.2) */
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
}

export function parseHeader(bytes: Uint8Array): PmtilesHeader | null {
  if (bytes.length < HEADER_LENGTH) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== "PMTiles") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const e7 = (offset: number) => view.getInt32(offset, true) / 10_000_000;

  return {
    specVersion: bytes[7],
    rootOffset: Number(view.getBigUint64(8, true)),
    rootLength: Number(view.getBigUint64(16, true)),
    metadataOffset: Number(view.getBigUint64(24, true)),
    metadataLength: Number(view.getBigUint64(32, true)),
    leafOffset: Number(view.getBigUint64(40, true)),
    leafLength: Number(view.getBigUint64(48, true)),
    dataOffset: Number(view.getBigUint64(56, true)),
    dataLength: Number(view.getBigUint64(64, true)),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97],
    tileCompression: bytes[98],
    tileType: bytes[99],
    minZoom: bytes[100],
    maxZoom: bytes[101],
    minLon: e7(102),
    minLat: e7(106),
    maxLon: e7(110),
    maxLat: e7(114),
    centerZoom: bytes[118],
    centerLon: e7(119),
    centerLat: e7(123),
  };
}

/** Cumulative tile count through the end of zoom z-1: (4^z - 1) / 3. */
function tileIdBase(z: number): number {
  return (Math.pow(4, z) - 1) / 3;
}

/**
 * (z, x, y) → Hilbert tile ID. Bitwise-safe through z15 (max cumulative ID
 * ≈ 1.43e9 < 2^31); our archives stop at z14 anyway.
 */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z < 0 || z > 15) throw new Error(`zoom ${z} out of supported range`);
  if (z === 0) return 0;
  const n = 2 ** z;
  if (x < 0 || x >= n || y < 0 || y >= n) throw new Error("x/y outside zoom bounds");

  let d = 0;
  let cx = x;
  let cy = y;
  for (let s = n / 2; s > 0; s /= 2) {
    const rx = (cx & s) > 0 ? 1 : 0;
    const ry = (cy & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // Rotate the quadrant: reflect when ry == 0, swap x/y (Hilbert U-shape).
    if (ry === 0) {
      if (rx === 1) {
        cx = s - 1 - cx;
        cy = s - 1 - cy;
      }
      const t = cx;
      cx = cy;
      cy = t;
    }
  }
  return tileIdBase(z) + d;
}

export interface DirectoryEntry {
  tileId: number;
  runLength: number; // 0 → this entry points at a leaf directory
  length: number;
  offset: number;
}

/** Little-endian base-128 varint reader with an explicit cursor. */
class Cursor {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  varint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.bytes[this.pos++];
      // Tile IDs fit well under 2^53; no need for bigint.
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
      if (shift > 56) throw new Error("varint too long");
    }
  }
}

/** Parse a *decompressed* directory block. */
export function parseDirectory(bytes: Uint8Array): DirectoryEntry[] {
  const cursor = new Cursor(bytes);
  const count = cursor.varint();
  if (count <= 0) return [];

  const entries: DirectoryEntry[] = [];
  for (let i = 0; i < count; i++) entries.push({ tileId: 0, runLength: 0, length: 0, offset: 0 });
  let lastId = 0;
  for (let i = 0; i < count; i++) {
    lastId += cursor.varint();
    entries[i].tileId = lastId;
  }
  for (let i = 0; i < count; i++) entries[i].runLength = cursor.varint();
  for (let i = 0; i < count; i++) entries[i].length = cursor.varint();
  for (let i = 0; i < count; i++) {
    const value = cursor.varint();
    // Offset 0 (for i > 0) means "directly after the previous entry".
    entries[i].offset =
      value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1;
  }
  return entries;
}

export type LookupResult =
  | { kind: "tile"; offset: number; length: number } // offset relative to header.dataOffset
  | { kind: "leaf"; offset: number; length: number } // offset relative to header.leafOffset
  | { kind: "miss" };

/** Binary-search a directory for a tile ID. */
export function findEntry(entries: DirectoryEntry[], tileId: number): LookupResult {
  let lo = 0;
  let hi = entries.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId <= tileId) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === -1) return { kind: "miss" };

  const entry = entries[idx];
  if (entry.runLength > 0) {
    if (tileId < entry.tileId + entry.runLength) {
      return { kind: "tile", offset: entry.offset, length: entry.length };
    }
    return { kind: "miss" };
  }
  // Leaf entry: covers tile IDs up to (but not including) the next entry.
  const next = entries[idx + 1];
  if (!next || tileId < next.tileId) {
    return { kind: "leaf", offset: entry.offset, length: entry.length };
  }
  return { kind: "miss" };
}
