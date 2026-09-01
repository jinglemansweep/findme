# Managing the basemap (PMTiles + R2)

Operational runbook for the map tiles behind Find Me. Covers first-time setup,
routine updates, and the UK → planet upgrade.

**Current configuration:** UK extract, z0–14, single archive in R2, served
through the Worker at `/tiles/*`.

---

## 1. Background

MapLibre GL JS renders **vector tiles** in the browser: the tiles carry geometry
and attributes (`class=motorway`, `name=M62`) and the client decides how to draw
them. That is why zooming is smooth, labels stay upright, and restyling needs no
data regeneration.

A vector tileset is normally millions of `z/x/y.mvt` files. **PMTiles** packs the
whole set into one file with an internal directory, ordered so geographically
adjacent tiles sit adjacent in the file. Clients fetch individual tiles with HTTP
**range requests** — "give me bytes 4,182,000–4,183,500" — so a complete basemap
is a single object in R2 with no tile server.

Three things must exist for a map to render correctly:

| Piece | What it is | Where it lives |
| --- | --- | --- |
| Tiles | The map data | `R2://findme-tiles/<PMTILES_KEY>` |
| Glyphs | Font atlases for labels | `R2://findme-tiles/fonts/…` |
| Sprites | Icons | `R2://findme-tiles/sprites/…` |
| Style | JSON tying them together | Bundled in the SPA |

**If labels are missing, glyphs are the cause.** This is the single most common
PMTiles setup failure — the map renders beautifully and silently has no text.

---

## 2. Prerequisites

```bash
npm i -g wrangler                    # deploy + bucket management
brew install rclone                  # bulk upload (or your package manager)
# pmtiles CLI: download from github.com/protomaps/go-pmtiles/releases
```

### rclone config

Create an R2 **S3-API token** in the dashboard (R2 → Manage API Tokens), then
`rclone config` with:

- Storage: `s3`
- Provider: `Cloudflare`
- Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- Region: `auto`

Name the remote `r2`.

---

## 3. First-time setup

### 3.1 Create the bucket

```bash
wrangler r2 bucket create findme-tiles
```

### 3.2 Size the extract before downloading anything

Find the current planet build filename at <https://maps.protomaps.com>. Do not
guess it — builds are dated and rotate.

```bash
pmtiles extract \
  https://build.protomaps.com/<BUILD>.pmtiles \
  uk.pmtiles \
  --bbox=-8.65,49.84,1.77,60.86 \
  --maxzoom=14 \
  --dry-run
```

`--dry-run` reports the total transfer and output size without downloading.
Always run it first.

**bbox:** `-8.65,49.84,1.77,60.86` covers Great Britain, Northern Ireland and
Shetland. Order is `MIN_LON,MIN_LAT,MAX_LON,MAX_LAT`. Use bboxfinder.com to
adjust.

**maxzoom:** 14 gives street-level detail, which is right for a "meet me here"
pin. 15 roughly triples the size for building-level detail you almost certainly
do not need. Whatever you pick, **record it in `TILES_MAXZOOM`** and keep it
consistent across future archives so the style never needs changing.

### 3.3 Extract

Drop `--dry-run` and let it run. Expect this to take a while; it is bounded by
your download speed, not CPU.

```bash
pmtiles extract \
  https://build.protomaps.com/<BUILD>.pmtiles \
  uk.pmtiles \
  --bbox=-8.65,49.84,1.77,60.86 \
  --maxzoom=14 \
  --download-threads=4
```

Verify before uploading:

```bash
pmtiles show uk.pmtiles --header-json
pmtiles verify uk.pmtiles
```

### 3.4 Upload

```bash
rclone copyto uk.pmtiles r2:findme-tiles/uk.pmtiles \
  --progress --s3-chunk-size=256M --s3-upload-concurrency=2
```

### 3.5 Fonts and sprites

Copy these into R2 rather than hotlinking. Hotlinked assets are someone else's
uptime and someone else's URL stability.

Source: the Protomaps `basemaps-assets` repository.

```bash
rclone copy ./fonts   r2:findme-tiles/fonts   --progress
rclone copy ./sprites r2:findme-tiles/sprites --progress
```

### 3.6 Point the Worker at it

```jsonc
"vars": {
  "PMTILES_KEY": "uk.pmtiles",
  "TILES_MAXZOOM": "14"
}
```

```bash
wrangler deploy --env production
```

### 3.7 Verify end to end

```bash
curl -sI https://find.narks.uk/tiles/8/125/80.mvt   # expect 200 + Cache-Control
curl -s  https://find.narks.uk/tiles/tiles.json     # TileJSON for MapLibre
```

Then load the app and check, in order: tiles render, **labels appear**, icons
appear, attribution control is visible.

---

## 4. Upgrading UK → planet

The Worker addresses the archive by config var, so this is a variable flip with
no code change and a one-line rollback.

```bash
# 1. Size it
pmtiles extract https://build.protomaps.com/<BUILD>.pmtiles planet.pmtiles \
  --maxzoom=14 --dry-run

# 2. Extract and upload alongside the existing UK archive
pmtiles extract https://build.protomaps.com/<BUILD>.pmtiles planet.pmtiles \
  --maxzoom=14 --download-threads=4
rclone copyto planet.pmtiles r2:findme-tiles/planet.pmtiles \
  --progress --s3-chunk-size=256M --s3-upload-concurrency=2

# 3. Flip the var and deploy
#    "PMTILES_KEY": "planet.pmtiles"
wrangler deploy --env production

# 4. Verify a non-UK tile renders, then remove the old archive
wrangler r2 object delete findme-tiles/uk.pmtiles
```

**Rollback:** set `PMTILES_KEY` back to `uk.pmtiles` and redeploy. Keep the old
archive in place until you are satisfied — a few GB of R2 storage is far cheaper
than an outage.

**Keep `--maxzoom` identical.** Changing it alongside the archive swap means a
style change too, and you lose the clean rollback.

Expect the planet archive to be roughly 100–130GB at full zoom; less at z14.
Storage is `$0.015/GB-month` after the free 10GB, so a full planet archive costs
in the region of $1.50–2.00/month.

---

## 5. Refreshing to a newer OSM build

Same procedure as the upgrade, using a dated key:

```bash
pmtiles extract https://build.protomaps.com/<NEW_BUILD>.pmtiles uk-20260901.pmtiles \
  --bbox=-8.65,49.84,1.77,60.86 --maxzoom=14
rclone copyto uk-20260901.pmtiles r2:findme-tiles/uk-20260901.pmtiles --progress
# flip PMTILES_KEY → uk-20260901.pmtiles, deploy, verify, then delete the old key
```

Dated keys make rollback trivial and make it obvious in the dashboard how stale
the map is. Refresh a few times a year; OSM road geometry does not move fast.

---

## 6. Caching and cost

Tile reads are R2 **Class B** operations: `$0.36/million`, first 10 million free
each month. A typical map session pulls 20–50 tiles, so the free allowance covers
a lot of traffic.

The Worker must set a long `Cache-Control` on tile responses. This matters twice
over:

1. R2 range-request latency can spike to 500ms–1s. Cache hits mask that entirely,
   and first paint is where it is most visible.
2. Cached responses do not incur Class B operations.

Tiles are immutable for the life of an archive, so cache aggressively — a week or
a month is reasonable. Because the archive key changes on every refresh, there is
no cache-invalidation problem: a new key is a new URL.

Monitor under R2 → your bucket → Metrics.

---

## 7. Attribution

Protomaps basemaps are built from OpenStreetMap and carry **ODbL** obligations.
The attribution control is a licence requirement, not decoration, and must be
visible on the map. Do not remove it to save space on mobile.

---

## 8. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Map renders, no labels anywhere | Glyphs URL wrong or fonts not uploaded (§3.5) |
| Missing icons only | Sprites URL wrong or not uploaded |
| Blank map, 404s on `/tiles/*` | `PMTILES_KEY` does not match the R2 object key |
| Blank beyond a zoom level | Zooming past `TILES_MAXZOOM`; set `maxzoom` on the style source so MapLibre overzooms instead |
| Blank outside the UK | Expected on the UK extract. Constrain the map's `maxBounds`, or upgrade (§4) |
| Slow first paint, fast after | Cache miss against R2. Check `Cache-Control` is being set |
| `extract` fails on the source | Source archive must be clustered. Official Protomaps builds are; custom tippecanoe output may not be |
