# Flight data licence: ODbL 1.0

The files in this folder (`flights-bay-day.parquet`, `flights-bay-30min.parquet` and the
measurements in `flights.manifest.json`) are derived from the
[adsb.lol](https://adsb.lol) ADS-B archive.

**Data © adsb.lol contributors, licensed under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1.0/).**
adsb.lol aggregates reports from volunteer receivers ("use it freely, just
keep it open"). The release's own `README.txt` says: "This database is
made available under the Open Database License" and "This is made possible
by the adsb.lol feeders" (who waive their rights to the data they feed under
CC0 1.0).

These derived databases are themselves made available under the ODbL 1.0:
you may use, share and adapt them, as long as you attribute adsb.lol
contributors, keep any adapted database open under the ODbL, and do not
add technical restrictions. The rest of Glassgrid (code, synthetic
samples) is MIT; that licence does not cover these files.

## Source

- Release: [`v2026.11.09-planes-readsb-prod-0`](https://github.com/adsblol/globe_history_2026/releases/tag/v2026.11.09-planes-readsb-prod-0) (readsb whole-sky history for the UTC day 2026-11-09).
- Assets, concatenated into one tar and streamed (never stored):
  - `v2026.11.09-planes-readsb-prod-0.tar.aa`: 2,000,000,000 bytes, SHA-256 `76beafbe30e2e05766cb57b41b87d3b8eb59aca6ec0dd3a37a46f4dd787d987d`
  - `v2026.11.09-planes-readsb-prod-0.tar.ab`: 1,723,313,664 bytes, SHA-256 `68cf603c5c61407d119095793bc08bc0618c9a06043ec18d26d6e587a2be265e`

## What was done to it

Produced by `tools/datasets/src/globe-history.ts` (recipe `flights-globe-history/1`):

1. Read every `traces/<xx>/trace_full_<hex>.json` (readsb trace format);
   ignored the rest of the archive (`heatmap/`, `acas/`).
2. Kept only fixes with 37 <= lat <= 38.5 and -123 <= lon <= -121.5
   (San Francisco Bay Area) and a time inside 2026-11-09 00:00–24:00 UTC.
3. Mapped each fix to Glassgrid's flight-point schema
   (`packages/core/src/flights`): callsign, squawk and category carried
   forward from the last detailed point of the same leg; geometric altitudes
   and rates moved out of the barometric fields; registration and type from
   the archive's aircraft database fields.
4. Dropped duplicate (hex, time) fixes; rounded positions to
   5 decimals, speed and track to 0.1, altitudes and vertical
   rates to whole feet and feet per minute; sorted by aircraft, then time.
5. `flights-bay-30min.parquet` is the 30-minute window with the most distinct aircraft
   in 10-second snapshots, plus the 60 seconds before it.

No other fields were added, and no data from other sources was mixed in.
