# @glassgrid/datasets

Reproducible, pinned benchmark CSVs for Glassgrid (two families below), and
the web demo's sample datasets ([Web demo samples](#web-demo-samples-pnpm---filter-glassgriddatasets-samples)).

| Dataset | Command | Rows | CSV size (approx.) |
| --- | --- | --- | --- |
| `nyc-taxi-yellow-10m` (primary benchmark) | `npm run taxi` | exactly 10,000,000 | ~1.0 GB |
| `nyc-taxi-yellow-1m` | `npm run taxi -- --rows 1000000` | exactly 1,000,000 | ~100 MB |
| `synthetic-1m-seed42` | `npm run synthetic -- --rows 1m` | exactly 1,000,000 | 149 MB |
| `synthetic-10m-seed42` | `npm run synthetic -- --rows 10m` | exactly 10,000,000 | 1.5 GB |
| `synthetic-50m-seed42` | `npm run synthetic -- --rows 50m` | exactly 50,000,000 | 7.4 GB |

Every run writes `out/<name>.csv` and `out/<name>.manifest.json`. `npm run verify`
recomputes row count, size and SHA-256 and checks them against the manifest and
against `pins.json` (the checked-in reference hashes).

## Requirements

- Node.js 22.12+ (uses `tsx` to run the TypeScript directly; no build step).
- `npm install` (or `pnpm install` once this folder is part of the workspace).
- Network access to `d37ci6vzurychx.cloudfront.net` for the taxi data. Behind an
  HTTP proxy, set `NODE_USE_ENV_PROXY=1` so Node's `fetch` honours `HTTPS_PROXY`.
- No DuckDB extensions are needed: Parquet is built in, and downloads use Node's
  `fetch` rather than `httpfs`, so nothing is fetched from `extensions.duckdb.org`.

Pinned versions (exact, in `package.json`): `@duckdb/node-api` 1.5.6-r.1 (DuckDB
v1.5.6), `tsx` 4.23.15, `typescript` 6.0.3, `@types/node` 22.20.4.

## Commands

```sh
npm install

# NYC taxi
npm run taxi                                 # 10,000,000 rows from 2024-03, 2024-04, 2024-05
npm run taxi -- --rows 1000000               # 1,000,000 rows from 2024-03 only
npm run taxi -- --rows 1m --prune-cache      # delete the downloaded Parquet afterwards

# Synthetic
npm run synthetic -- --rows 1m  --seed 42
npm run synthetic -- --rows 10m --seed 42
npm run synthetic -- --rows 50m --seed 42

# Verify every manifest in out/ (or name specific manifests or CSVs)
npm run verify
npm run verify -- out/nyc-taxi-yellow-10m.manifest.json

npm run typecheck
```

Row counts accept `1000000`, `1_000_000`, `1m`, `10M`, `500k`.

Common options: `--out DIR` (default `out/`, gitignored), `--name NAME` (file
base name), `--threads N`. Taxi only: `--months 2024-03,2024-04,...` (ordered
candidate list), `--base-url URL` (or env `GLASSGRID_TLC_BASE_URL`, for a mirror),
`--memory-limit 4GB`, `--prune-cache`. Synthetic only: `--seed N`,
`--chunk-rows N` (default 1m; affects speed and memory only, never the bytes).

## NYC TLC Yellow Taxi (`npm run taxi`)

### What it does

1. Takes the months in order (default `2024-03, 2024-04, 2024-05, 2024-06`) and
   downloads `https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_<YYYY-MM>.parquet`
   until the Parquet footers' row counts cover `--rows`. 10M needs the first
   three months; 1M needs only `2024-03`. June is a spare.
2. Caches each file in `out/cache/<sha256(url)[0:16]>-<file name>` with a
   `.meta.json` sidecar (URL, size, SHA-256, ETag, Last-Modified). Reruns don't
   re-download. A half-finished download is never reused.
3. Runs one DuckDB query over the cached files: the 19 data-dictionary columns in a
   fixed order with explicit casts, `ORDER BY` every column (pickup time, drop-off
   time, VendorID, PULocationID, DOLocationID, then the rest, all `NULLS LAST`),
   `LIMIT <rows>`. Ordering by every column is a total order: rows that tie are
   byte-identical, so the output doesn't depend on thread scheduling.
4. `COPY ... TO ... (FORMAT csv, HEADER ...)` to `out/nyc-taxi-yellow-<rows>.csv`,
   then writes the manifest, including each source file's URL, size, SHA-256 and
   row count, plus the exact SQL.

### Columns (fixed order)

`VendorID` INTEGER, `tpep_pickup_datetime` TIMESTAMP, `tpep_dropoff_datetime`
TIMESTAMP, `passenger_count` BIGINT, `trip_distance` DOUBLE, `RatecodeID` BIGINT,
`store_and_fwd_flag` VARCHAR, `PULocationID` INTEGER, `DOLocationID` INTEGER,
`payment_type` BIGINT, `fare_amount`, `extra`, `mta_tax`, `tip_amount`,
`tolls_amount`, `improvement_surcharge`, `total_amount`, `congestion_surcharge`,
`airport_fee` (all DOUBLE).

These are fields 1-19 of the TLC Yellow data dictionary (dated 2025-03-18).
`airport_fee` is spelled `Airport_fee` in the 2024 Parquet files. DuckDB binds
column names case-insensitively, and the CSV uses the dictionary's lowercase name.

### Chosen months and expected sizes

| Month | Parquet rows (approx.) | Parquet size (approx.) |
| --- | --- | --- |
| 2024-03 | ~3.58M | ~60 MB |
| 2024-04 | ~3.51M | ~60 MB |
| 2024-05 | ~3.72M | ~62 MB |
| **Sum** | **~10.8M** (comfortably > 10M) | ~180 MB |

The exact counts come from the Parquet footers at run time and are recorded in the
manifest (`source.files[].rows`). For a lower bound, an independent analysis of the
2024 files reports these trip counts *after* removing invalid rows: Mar 3,398,906,
Apr 3,373,782, May 3,576,039 (sum 10,348,727). The raw files hold more.
Source: [Wyclife5X4/NYC-Yellow-Taxi-2024-Full-Year-Analysis-Insights](https://github.com/Wyclife5X4/NYC-Yellow-Taxi-2024-Full-Year-Analysis-Insights).

All three months are 2024 files. They share one 19-column schema with no differences
between them. Schema differences to know about if you change `--months`:

- **2025 onwards** adds `cbd_congestion_fee` (MTA Congestion Relief Zone charge,
  from 2025-01-05). This recipe always writes the fixed 19 columns, so that
  column would be dropped.
- Older years differ in spelling and type (for example `airport_fee` versus
  `Airport_fee`, and integer columns stored as DOUBLE in some years). The explicit
  casts normalise types. Mixing years that spell a column differently can make
  `union_by_name` produce two columns, which DuckDB reports as an ambiguity error.
- TLC warns that "there may be minor changes in the near future to standardize the
  parquet schema across all years and datasets". If that happens, the source
  SHA-256 in the manifest changes. The explicit casts are meant to keep the CSV
  stable when only types change.

### Data quirks (kept on purpose, this is raw TLC data)

- Each monthly file contains a few trips with out-of-month timestamps (for example
  2002 or 2009 dates, or early-next-month). Because the output is sorted by pickup
  time, **those outliers are the first rows of the CSV**.
- The 1M file is built from `2024-03` alone, so it is *not* the first 1M rows of
  the 10M file. The 10M sort also sees early-dated outliers from the April and May
  files.
- `passenger_count`, `RatecodeID`, `store_and_fwd_flag`, `congestion_surcharge`
  and `airport_fee` have NULLs (empty fields). Some money fields are negative
  (refunds or voids).

### Disk space

- Downloads: ~60 MB per month (~180 MB for 10M, ~60 MB for 1M) in `out/cache/`.
- CSV: ~1.0 GB for 10M, ~100 MB for 1M.
- Sort spill: DuckDB may spill to `out/cache/duckdb-tmp/` on low-memory machines
  (up to roughly the CSV size). The folder is removed when the run ends. Peak RSS
  for a 10M-row sort was about 2.3 GB on a 2-core, 7 GB machine.
- Plan for **~2.5 GB free** for the 10M run. Add `--prune-cache` to delete the
  Parquet once the CSV is written.

### Data source and terms

- Source page: [TLC Trip Record Data](https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page)
  (Yellow Taxi Trip Records, monthly Parquet files at
  `https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_YYYY-MM.parquet`).
  The page says data is "published monthly ... typically with a two-month delay"
  (latest listed when this was written: 2026-08).
- Data dictionary: [data_dictionary_trip_records_yellow.pdf](https://www.nyc.gov/assets/tlc/downloads/pdf/data_dictionary_trip_records_yellow.pdf)
  (codes: `payment_type` 0 Flex Fare, 1 card, 2 cash, 3 no charge, 4 dispute,
  5 unknown, 6 voided; `RatecodeID` 1 standard, 2 JFK, 3 Newark, 4 Nassau or
  Westchester, 5 negotiated, 6 group ride, 99 unknown).
  Also: [Trip Record User Guide](https://www.nyc.gov/assets/tlc/downloads/pdf/trip_record_user_guide.pdf).
- Terms:
  - The TLC page has no separate licence. Its disclaimer says the data "was not
    created by the TLC" and that "TLC makes no representations as to the accuracy
    of these data" (records come from TPEP technology vendors).
  - [NYC OpenData Terms of Use](https://www.nyc.gov/html/data/terms.html): use is
    subject to the NYC.gov Terms of Use and any terms of the providing agency. The
    data is "for informational purposes", with no warranty of accuracy,
    completeness or fitness, and "may be updated, corrected, overwritten and/or
    refreshed at any time". Older versions are not retained.
  - NYC Open Data Law, Local Law 11 of 2012, Admin. Code § 23-502(d)
    ([text](https://intro.nyc/local-laws/2012-11)): public data sets "shall be made
    available without any registration requirement, license requirement or
    restrictions on their use". The City may require users to identify the data's
    source and version and describe any modifications.
  - **What this means for Glassgrid (not legal advice):** benchmarking, and
    redistributing derived samples (for example a small CSV slice in a public web
    demo), are not restricted. Do this when redistributing:
    1. Credit the source ("NYC Taxi & Limousine Commission, TLC Trip Record Data")
       and link the page.
    2. Name the months and say the data is a sorted, column-normalised subset
       (`source.months` and `query` in the manifest describe it exactly).
    3. Repeat the no-warranty disclaimer.
    4. Don't use City or TLC logos, and don't imply endorsement.

    The records have no names or other direct personal identifiers. Locations are
    taxi-zone IDs, not coordinates.
  - Because TLC may re-publish a month, the manifest stores each source file's
    SHA-256. If a later run's CSV hash differs, compare `source.files[].sha256`
    first.

## Synthetic (`npm run synthetic`)

A seeded, deterministic generator for any size. Same seed + same row count + same
recipe version (`synthetic/1`) + same DuckDB version gives a **byte-identical CSV**.
Also, the N-row file is an exact prefix of any larger file with the same seed, so
`synthetic-1m-seed42.csv` equals the first 1,000,001 lines of `synthetic-10m-seed42.csv`.

### Columns

| Column | Type | Shape |
| --- | --- | --- |
| `id` | BIGINT | 1..N, unique, sorted |
| `event_time` | TIMESTAMP | from 2024-01-01, ~2 s apart with 0-4 s jitter (locally out of order) |
| `region` | VARCHAR | low cardinality, 8 values, skewed (`us-east` ~35%) |
| `status` | VARCHAR | low cardinality: completed 70%, pending 15%, refunded 10%, failed 5% |
| `customer_id` | VARCHAR | high cardinality, `C0000000`-`C1999999` |
| `session_id` | VARCHAR | 16 hex chars, effectively unique |
| `quantity` | INTEGER | 1..20, geometric-like |
| `unit_price` | DECIMAL(10,2) | 0.99..2000.79, skewed toward small values |
| `amount` | DECIMAL(14,2) | `quantity * unit_price` |
| `discount_pct` | DOUBLE | **nullable**: NULL ~35% (empty field), else 0.0..40.0 |
| `latitude`, `longitude` | DOUBLE | NYC bounding box, 6 decimals |
| `is_returning` | BOOLEAN | `true` ~40% |
| `comment` | VARCHAR | **free text**, 1-12 words, NULL ~8%. About 11% of rows each contain a comma, a `"` (escaped as `""`), or non-ASCII (`café`, `naïve`, `—`, `📦`) |

### How determinism is guaranteed

The generator doesn't use `random()`/`setseed()`. Every value is a pure function
of `(seed, row index, column salt)`, using DuckDB's `hash()` and integer
arithmetic only. Floats are built as `integer / 10^k`, a single correctly rounded
IEEE division. There are no `exp`/`ln`/`cos` calls, whose last bit can vary between
libm builds. So:

- Generation runs on all cores and still gives the same bytes. Verified identical
  with `--threads 1` and the default.
- Rows are generated in contiguous chunks of `--chunk-rows`. Each chunk is
  `ORDER BY id` before `COPY`, and the chunks are appended in order. This keeps
  memory flat: about 1 GB RSS for 10M rows, versus about 4 GB for a single 10M-row
  sort. Chunk size doesn't change the output (verified with 250k, 333,333 and 1m
  chunks).
- What can change the bytes: the recipe version (bump `RECIPE` in
  `src/synthetic.ts` when the SQL changes), and the DuckDB version (its `hash()`
  and number formatting). Both are recorded in the manifest. `pins.json` entries
  are only compared when both match.

### Disk space and time (2-core container, DuckDB 1.5.6)

| Rows | CSV | Generation time |
| --- | --- | --- |
| 1M | 148.9 MB | ~6 s |
| 10M | 1.5 GB | ~60 s |
| 50M | 7.4 GB (7,900,340,340 bytes) | ~5 min |

Plan for the CSV size plus one chunk (~150 MB) of free space.

## Manifest

`out/<name>.manifest.json`:

```jsonc
{
  "manifestVersion": 1,
  "dataset": "nyc-taxi-yellow",          // or "synthetic"
  "name": "nyc-taxi-yellow-10m",
  "file": "nyc-taxi-yellow-10m.csv",     // relative to the manifest
  "rows": 10000000,                      // data rows, header excluded
  "bytes": 0, "sha256": "…",
  "columns": [{ "name": "VendorID", "type": "INTEGER", "description": "…" }, …],
  "format": { "delimiter": ",", "header": true, "quote": "\"", "escape": "\"",
              "newline": "\n", "nullString": "", "timestampFormat": "%Y-%m-%d %H:%M:%S",
              "decimalSeparator": ".", "encoding": "utf-8" },
  "generator": { "package": "@glassgrid/datasets", "packageVersion": "0.1.0",
                 "recipe": "nyc-taxi-yellow/1", "duckdbVersion": "v1.5.6", "nodeVersion": "…" },
  "seed": 42,                            // synthetic only
  "source": { "provider": "…", "page": "…", "dataDictionary": "…", "terms": […],
              "months": ["2024-03", …],
              "files": [{ "month": "2024-03", "url": "…", "bytes": 0, "sha256": "…", "rows": 0 }] },  // taxi only
  "query": "SELECT … ORDER BY … LIMIT 10000000",
  "generatedAt": "…", "elapsedSeconds": 0
}
```

CSV dialect: UTF-8 without a BOM, comma delimiter, a header row, `\n` line endings,
RFC 4180 quoting (`"` with a doubled `""` escape, applied only when needed). NULL is
an empty unquoted field; an empty string is `""`. Timestamps are
`YYYY-MM-DD HH:MM:SS` (ISO 8601 / RFC 3339 with a space separator, no time zone;
TLC times are local New York time). Decimals use `.`.

`verify` counts records quote-aware, so a newline inside a quoted field doesn't
count as a row. It computes SHA-256 in the same streaming pass, which takes about
0.4 s per 150 MB.

## pins.json

Reference `{ rows, sha256, recipe, duckdbVersion }` per dataset name. `verify`
fails if a CSV with the same name, recipe and DuckDB version has a different hash.
To pin a new dataset, copy those fields from its manifest. The taxi datasets aren't
pinned yet: add them after the first run against the live TLC files.

## Web demo samples (`pnpm --filter @glassgrid/datasets samples`)

Three synthetic tables for the web demo (`apps/web`), written as Parquet with
one `.glassgrid` workspace each into `apps/web/public/samples/` (committed;
about 38 MB in all):

| Sample | File | Rows | Parquet | Columns |
| --- | --- | ---: | ---: | --- |
| `taxi` | `taxi-trips-2025h1.parquet` | 2,000,000 | 20.8 MB | trips in a made-up city, Jan–Jun 2025: pickup time, zones, passengers, distance, duration, fare, tip, payment type, pickup lat/lon |
| `retail` | `retail-orders-2023-2025.parquet` | 1,500,000 | 11.1 MB | orders of a made-up chain, 2023–2025: order id, time, region, channel, category, units, unit price, discount, revenue, segment, rating (mostly null) |
| `sensors` | `sensor-readings-2025-09.parquet` | 1,382,400 | 8.0 MB | 64 sensors in four buildings every two minutes, Sept 2025: time, sensor, site, temperature, humidity, CO₂ (office only), battery, status |

- **Made up from scratch** by seeded DuckDB SQL (`src/samples.ts`), so there
  is no third-party data or licence to track: MIT like the rest of the repo.
  The shapes are there to make charts worth brushing: rush hours, weekly and
  holiday dips, airport runs, seasonal and Black-Friday peaks, daily
  temperature cycles, a cold store whose door is left open now and then.
- **Deterministic:** values come from `hash(row, seed, salt)` and integer
  arithmetic, and DuckDB writes with one thread, so the same recipe
  (`samples/1`) and DuckDB version give the same bytes (two runs compared).
  `samples.manifest.json` records rows, bytes, SHA-256 and columns.
- **Parquet:** zstd level 9, row groups of 122,880 rows, Parquet format v2
  encodings (delta-encoded timestamps and ids), which DuckDB-WASM 1.32.0
  (DuckDB 1.4.3) reads.
- **Workspaces:** `<id>.glassgrid` (format v1), written with
  `@glassgrid/core`'s serializer (valid by construction), with the column
  types the engine infers from the Parquet file and four charts each. Every
  chart is compiled against the file's columns and ranges before it is
  written.
- **Changing a sample:** the Parquet files are served as immutable (one year,
  `apps/web/vercel.json`), so new bytes need a new file name (bump the
  recipe, rename, regenerate, update `apps/web/src/samples.ts`). Each file
  should stay under 25 MB (`apps/web/src/samples.test.ts` checks it).

## Layout

```
src/taxi.ts          NYC TLC pipeline (download → cache → DuckDB sort → CSV + manifest)
src/synthetic.ts     seeded generator (DuckDB SQL)
src/samples.ts       the web demo's sample Parquet files and .glassgrid workspaces
src/verify.ts        manifest + pins check
src/lib/common.ts    CSV dialect, arg helpers, paths
src/lib/duck.ts      DuckDB connection, DESCRIBE, COPY (single and chunked)
src/lib/download.ts  URL-keyed download cache
src/lib/manifest.ts  manifest types, streaming SHA-256 + quote-aware row count, pins
pins.json            reference hashes
out/                 outputs and cache (gitignored)
```
