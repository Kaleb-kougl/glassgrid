# Live flights L2: ingest in the engine worker

Branch `live-flights`, dated 2026-11-10. Milestone L2 of the live-flights
feature: the engine (the web demo's worker, and the desktop's utility
process, which share `packages/engine`) fills a DuckDB table,
`flight_states`, from either the site's live endpoint or a replayed
fixture. It builds on [L0](live-flights-l0.md) (the `FlightPoint` schema,
the readsb adapters, the Parquet fixtures). Nothing in the UI shows the
table yet; the next milestone points views at it.

| Goal | Result |
| --- | --- |
| One source interface, two sources | `LiveSource` (core, `flights/live.ts`), implemented in `packages/engine/src/live/`: `AdsbLolSource` polls `GET /api/flights`; `ReplaySource` plays a fixture on the same tick clock. Both hand batches of `FlightPoint` to the engine and report a `LiveSourceState`. |
| `flight_states` in DuckDB | The fixtures' Parquet types exactly (`ts` TIMESTAMP, `lat`/`lon` DECIMAL(7,5)/(8,5), ...), appended per batch in one transaction, deduplicated, with a rolling retention (60 minutes by default, off on request). |
| Dedup of re-reported live fixes | Exact (hex, ts) for every source, plus: two live fixes of one aircraft at the identical stored position within 2 s are one fix. Property-tested in JS (400 runs per property) and on the real table under both drivers. |
| The replay gate | **Passes on native DuckDB and on DuckDB-WASM**: replaying `flights-bay-30min.parquet` through `ReplaySource` and ingest, retention off, leaves `flight_states` equal to the fixture: 71,595 rows, every cell equal as DuckDB's own text, and (native) `EXCEPT ALL` empty both ways. It also passes in Chromium through the real worker (row count). |
| Visibility pause | A `liveVisibility` engine request; the web platform reports `document.visibilityState`; the feed stops polling while every page that reported is hidden. The desktop never pauses (below). |
| Commands | `startLive`, `stopLive`, `setLiveSource`: effect commands, exposed to MCP; `startLive` and `setLiveSource` are tier `write` (they can empty `flight_states`), `stopLive` is `edit`. The parity test passes with no new exemption. |
| Desktop | Typechecks, its 91 tests pass. The native engine has the feed too (replay is tested on native), but the desktop host configures no URL or fixtures, so its `live*` requests answer `not_implemented`. |

## What was built

| File | What |
| --- | --- |
| `packages/core/src/flights/live.ts` | The contract: `LiveSource`, `FlightBatch`, `LiveClock`, `LiveSourceConfigSchema`, `LiveSourceStateSchema`, `LiveStateSchema`, `FlightsApiResponseSchema`, `liveFlightsUrl`, `LIVE_FIXTURES`, the cadence and retention constants, `ADSBLOL_ATTRIBUTION` |
| `packages/core/src/protocol/engine.ts` | Requests `liveStart`, `liveStop`, `liveSetSource`, `liveState`, `liveVisibility`; the `liveState` reply; the `liveState` event |
| `packages/core/src/commands/builtins/live.ts` | `startLive`, `stopLive`, `setLiveSource` and `liveSourceConfigFromInput` |
| `packages/engine/src/live/adsblol-source.ts` | `AdsbLolSource`, `retryAfterMs`, `backoffDelayMs` |
| `packages/engine/src/live/replay-source.ts` | `ReplaySource`, `FixtureReader`, `parquetFixtureReader`, `memoryFixtureReader` |
| `packages/engine/src/live/dedup.ts` | `newFixes` (the dedup rule), `toStoredPoint` (stored precision) |
| `packages/engine/src/live/flight-store.ts` | `FlightStore`: the table, the append path, dedup and retention per batch |
| `packages/engine/src/live/live-feed.ts` | `LiveFeed`: one source and one table per engine, source switching, visibility across connections |
| `packages/engine/src/query-service.ts`, `session.ts` | `QueryService.live` (option `live`), and EngineSession routing the `live*` requests to it |
| `packages/engine/src/worker/*` | `WorkerInit.live` (`url`, `fixtures`, same-origin only); the worker registers a fixture as an HTTP source when a replay first needs it |
| `packages/engine/src/client/*`, `web/worker-engine.ts` | `LiveEngineApi` (`EngineClientApi.live`, optional), implemented by `PortEngineClient`, so the worker engine has it |
| `packages/app/src/live.ts`, `platform.ts`, `App.tsx` | `provideLiveFlights` (the three commands over `engine.live`, visibility forwarding, restart), `PlatformWindow.onVisibilityChange` |
| `apps/web/src/web-engine.ts`, `web-platform.ts` | The web demo's configuration (`/api/flights` on the site origin, the fixtures under the base) and `visibilitychange` |
| `packages/engine/e2e/*` | A Chromium case: replay over HTTP into `flight_states`, then a poll of a stand-in endpoint, hidden, shown, stopped |

No dependency was added.

## Design

```
page (main thread)                               engine worker (or the desktop utility process)
──────────────────                               ──────────────────────────────────────────────
registry.dispatch('startLive', …)                EngineSession ── live* requests ──▶ QueryService.live (LiveFeed)
  └ provideLiveFlights ── liveStart ───────────▶   LiveFeed: one source, one FlightStore
platform.window.onVisibilityChange                   AdsbLolSource ── fetch(/api/flights, no-store) ──▶ CDN ──▶ adsb.lol
  └ liveVisibility ────────────────────────────▶     ReplaySource ── FixtureReader (read_parquet → gg_replay_fixture)
◀── event liveState (status, rowCount, lastBatch)    └ sink: FlightStore.ingest ── BEGIN; dedup; INSERT; DELETE expired; COMMIT
```

- **Where the sources run.** In the engine, next to the table: the worker
  can `fetch` and DuckDB is in the same thread, so a batch never crosses
  `postMessage`. One feed per engine, shared by every connection (desktop
  windows, or a restarted page), as QueryService's tables are.
- **Configuration is the host's.** The endpoint URL and the fixtures'
  locations come from the engine host (`QueryServiceOptions.live`; in the
  browser `WorkerInit.live`, on an allowed origin only), never from a
  request, as with file paths. Requests carry only `{ kind, fixture,
  intervalMs, speed, retentionMs }`. A host without a URL or fixtures
  answers `not_implemented`.
- **The URL.** The web demo passes `liveFlightsUrl(location.origin)`:
  `/api/flights` on the site's origin, deliberately outside the
  `/glassgrid/` base (it is the portfolio's route). Since L4, Vite's dev
  server proxies it to the portfolio's dev server
  ([L4](live-flights-l4.md#live-data-locally)); `vite preview` has no such
  route, and the source then backs off on its 404s.
  `createDuckdbWebEngine({ liveFlightsUrl })` takes another same-origin URL
  (a local relay, say). The CSP's `connect-src 'self'` already allows it.
- **Lazy engine.** The app sends visibility only after a feed was started
  from the page, so a visitor who never uses live data does not start
  DuckDB-WASM by switching tabs.
- **Restart.** After an engine restart (a new worker), the app starts the
  feed that was running again, and re-sends a hidden page's visibility.

### Sources

**`AdsbLolSource`** (named after `tools/datasets/src/lib/adsblol.ts`; it
polls our relay of adsb.lol):

- **Request.** `fetch(url, { cache: 'no-store', headers: { Accept:
  'application/json' }, signal })` with a 20 s timeout (longer than the relay's own 15 s wait on adsb.lol, whose TLS handshake measured ~9 s), through an injected
  `fetch` (the worker passes the global one).
- **Mapping.** The body is checked with `FlightsApiResponseSchema` (the
  envelope only). Each aircraft goes through
  `fromReadsbAircraft(ac, now / 1000, 'live')`: the contract's `now` is
  epoch milliseconds, and the adapter takes seconds. The fix time is
  `round((now/1000 - seen_pos) * 1000)` ms. Aircraft outside
  `BAY_AREA_BBOX` (the relay already filters) or without a position are
  skipped.
- **Data clock.** The batch's data clock (what retention counts back from)
  is the body's `now`, clamped to at most 5 s ahead of this machine's clock
  (`MAX_LIVE_CLOCK_AHEAD_MS`): a relay clock hours ahead would otherwise
  expire every stored fix. Fix times still use the relay's `now`, so
  re-reports keep matching.
- **Cadence.** One poll per `intervalMs`, measured from the start of the
  previous poll.
  - Default **20 s**, at least **10 s**, at most 10 minutes.
  - **Never more than one poll per 10 s, whatever the commands do.** The
    feed remembers when the endpoint was last polled, across sources, and a
    new source (a restart, a stop and start, another interval) waits until
    10 s after that poll; a source restarted after `stop()` does the same.
    Backoff and Retry-After are floored at 10 s too. Before this, a
    stop/start loop could poll on every call.
  - Why 20 s: the relay is cached by the CDN for 10 s (`s-maxage=10,
    stale-while-revalidate=20`), so a faster poll gets the same body back
    and only costs a request. Every request counts against the site's
    budget: Vercel Hobby includes 1M CDN requests a month. One open tab at
    10 s makes 360 requests an hour, so 1M lasts about 2,800 viewer-hours a
    month; at 20 s, 180 an hour and about 5,600 viewer-hours.
  - The fixtures' median gap between an aircraft's fixes is 2.1 s (L0), so
    a 20 s poll samples each aircraft about once per poll either way.
- **503.** It waits for `Retry-After` (delta seconds or an HTTP date),
  clamped to 10 s .. 5 minutes. A 429 is treated the same way.
- **Other failures.** Network errors, the timeout, any other status and a
  body off the contract back off exponentially from the interval with
  "equal jitter": half of `min(5 min, interval x 2^(n-1))` plus a random
  half, never under 10 s. That gives 10-20 s, then 20-40 s, then 40-80 s,
  and so on. A success resets the count. Nothing stops the source but
  `stop()`.

**Statuses** (`LiveSourceState.status`):

| Status | When |
| --- | --- |
| `connecting` | Started, no answer yet |
| `live` | The last poll succeeded |
| `stale` | The body said `stale: true` (its rows are still ingested), or a `live` source had no success for longer than the larger of 30 s (`LIVE_STALE_AFTER_MS`) and one interval plus the 20 s timeout plus 2 s (`LIVE_STALE_MARGIN_MS`), so a 60 s interval does not flicker to `stale` between polls |
| `backoff` | The last attempt failed; `nextAttemptAt`, `failures` and `error` say more. A failing source stays `backoff` rather than `stale`; `lastSuccessAt` tells how old its data is. |
| `stopped` | Not running: never started, stopped, or a replay that ended (`ended: true`) |

`paused` is reported beside the status, not as one. The state also carries
`attribution` and `license` (from the body, or the fixture's ODbL line),
`lastSuccessAt`, `dataClockMs` (the body's `now`, or the replay position)
and `nextAttemptAt`.

**`ReplaySource`** keeps its own position in fixture time.

- Tick k happens every `intervalMs` of wall time (default 20 s, at least
  1 s) and moves the position to `v_k = floor(start + k * intervalMs * speed)`.
  Any speed in range is allowed, so the step need not be whole (speed
  1.0005 at 1 s); positions are floored to whole milliseconds, since they
  are epoch-ms values everywhere (bound as BIGINT, `LiveStateSchema`
  integers). Floored positions still tile the fixture: each fix is emitted
  exactly once.
- Each tick emits the fixes with ts in `(v_{k-1}, v_k]`; tick 0 emits
  everything up to the first fix. `speed` is 1 to 120: 40 minutes of
  fixture per 20 s tick.
- The position advances by ticks, never by reading the clock. Late timers,
  slow ingests and pauses change *when* ticks happen, never *what* they
  hold (tested: a paused, re-paused, slow-sink run gives the batches of an
  undisturbed one).
- The tick that passes the last fix ends the replay.
- The reader is a `FixtureReader`. The engine's copies the Parquet file
  once into a table ordered by time (`gg_replay_fixture`) in the feed's own
  database, so a tick is a range scan in memory, not a decompression of
  the (hex, ts)-sorted file. Tests and drivers without Parquet can pass a
  `memoryFixtureReader`.

Both sources wait for the ingest of a batch before scheduling the next, so
batches never overlap.

### `flight_states`

The columns are `FlightPoint`'s, in `FLIGHT_POINT_FIELDS` order and with
**the fixtures' types as DuckDB reads them** (`flights.manifest.json`):
`ts TIMESTAMP` (whole milliseconds), `lat DECIMAL(7,5)`, `lon
DECIMAL(8,5)`, altitudes and vertical rates `INTEGER`, `gsKt` and
`trackDeg` `DOUBLE` (to 0.1), `onGround BOOLEAN`, the rest `VARCHAR`; `ts`,
`hex`, `lat`, `lon`, `onGround` and `source` are `NOT NULL`.

- **Why the fixture's types and not DOUBLE positions.** The replay gate
  can then compare the table with `read_parquet(fixture)` value for value
  (`EXCEPT ALL` both ways). A chart over live data and one over the
  fixture compile to the same SQL. And dedup can compare positions exactly.
- **Live values are rounded on the way in** to the fixtures' precision
  (`toStoredPoint`): 5 decimals of a degree (about 1 m), whole feet and
  ft/min, 0.1 kt and 0.1°, a track that rounds to 360 wrapped to 0.
  Altitudes and vertical rates outside DuckDB's INTEGER range become null:
  one garbled aircraft at 3e9 ft would otherwise fail the CAST and roll
  back the whole batch on every poll. Narrower physical bounds are not
  applied, because the archive itself holds implausible values (-142,136
  ft/min in the 30-minute fixture) and the replay gate must stay exact.
  Rounding is half away from zero, like DuckDB's. It happens once, in JS,
  before dedup, so dedup compares exactly what the table will hold.
  Fixture values are already at that precision and pass through unchanged.
- **`TIMESTAMP`, not `TIMESTAMP_MS`.** That is what DuckDB reads the
  fixtures' `TIMESTAMP(MILLIS)` column as, and what the engine's compiler
  and Arrow mapping already handle.
- **No PRIMARY KEY.** The dedup below is stricter than a (hex, ts) key, and
  the ART index would cost memory on DuckDB-WASM. The property tests check
  that (hex, ts) stays unique.
- **Its own database.** The table lives in a database created through the
  driver: on native, an instance of its own, locked down like a table's,
  with the fixture as its only allowed path; on WASM, an attached in-memory
  database. A new source gets a new database, so its allowlist is fixed at
  creation.

### Append path

The append path is **a parameterised INSERT with one bound list per
column**:

```sql
INSERT INTO flight_states SELECT epoch_ms(CAST(c0 AS BIGINT)), NULLIF(c1, ''), …
FROM (SELECT unnest(string_split(?, chr(31))) AS c0, …, unnest(string_split(?, chr(31))) AS c17)
```

It sends 18 bound VARCHARs per statement, each holding up to 5,000 values
separated by U+001F.

- **Not Arrow.** `@duckdb/node-api` 1.5 cannot scan or append Arrow from
  JS. DuckDB-WASM can (`insertArrowFromIPCStream`), but outside the
  interruptible pending-query path the driver uses. Arrow would therefore
  mean two append paths and a change to the driver interface.
- **Bound values need neither.** They go through `run(sql, params)`, which
  both drivers already implement (WASM: PREPARE/EXECUTE with typed
  constants), and no value ever becomes SQL text.
- **Not row-wise `VALUES (?, …), (?, …)`.** That was the first cut, and
  DuckDB binds each of its 18 x n placeholders separately. Measured on
  8,000 rows on this VM:

  | Append | native | DuckDB-WASM (Node) |
  | --- | ---: | ---: |
  | `VALUES`, 25 / 100 / 400 rows per statement | 5.5k / 6.2k / 8.6k rows/s | 2.8k / 4.1k / 3.2k rows/s |
  | one list per column, 4,000 rows per statement | **443k rows/s** | **285k rows/s** |

  With `VALUES`, the 30-minute replay gate took 9.8 s (native) and 21.7 s
  (WASM); with lists, 0.9 s and 0.7 s.
- **Exact round trip.** Numbers travel as JS's shortest round-trip text,
  which DuckDB parses back to the same DOUBLE, and exactly as DECIMAL or
  INTEGER. NULL travels as `''` (no stored text is empty: the schema
  requires at least one character). U+001F cannot occur in a value:
  `toStoredPoint` replaces C0 control characters and DEL in text fields with
  U+FFFD. readsb callsigns and registrations never contain them, and NUL
  would break the WASM driver's literals anyway.
- **One transaction per batch:** the retention delete, the dedup read, the
  inserts and the count, in that order. A failure rolls back and leaves the table
  as it was (tested). The feed reports it in `LiveState.ingestError`, and
  the source carries on.

### Dedup

`newFixes(stored, batch, toleranceMs)` (`dedup.ts`) decides what is new.

1. **Exact key, every source:** one row per (hex, ts). A replayed window
   delivered twice, or a poll answered from the CDN's cache (the same body
   again), adds nothing.
2. **Re-reported live fixes.** readsb keeps reporting an aircraft's last
   position until a newer one arrives, so consecutive polls repeat the same
   fix with a later `now` and a larger `seen_pos`. Its computed time `now -
   seen_pos` can come back a few milliseconds off: `seen_pos` is rounded
   (typically to 0.1 s) and `now` to 1 ms. So two `live` fixes of the same
   aircraft at the **identical stored position** (lat and lon after
   rounding) whose times are **at most 2 s apart** (`LIVE_FIX_TOLERANCE_MS`)
   are one fix. The first one ingested is kept, with its altitude and
   speed.

Why this rule:

- **Not quantising `ts`.** Rounding times to buckets fails at bucket
  edges: 12.999 s and 13.001 s are the same fix in different buckets.
- **Position, not altitude.** Altitude, speed and track are left out of the
  identity on purpose: readsb updates them from other messages between
  position updates, so a re-reported position can carry a newer altitude.
- **What it can merge.** At 450 kt an aircraft moves about 460 m in 2 s,
  far more than the 1 m rounding, so in the air only a repeat merges. It
  merges a genuinely new fix only when an aircraft repeats its exact
  position within 2 s (a parked aircraft), and the dropped row then says
  nothing the kept one does not.
- **Archive rows never merge this way.** Their times are exact, and the
  fixtures hold distinct fixes at one spot: 68,078 distinct positions
  among the 30-minute file's 71,595 rows. That is why the replay gate can
  be exact.

The rule is applied greedily in arrival order, against the rows **kept**
so far (stored rows, then earlier rows of the batch), never against rows it
dropped. So every dropped fix has a kept twin that stays until retention
removes it, and ingest is idempotent:

- ingesting rows that were already ingested (a repeated batch, or a subset
  of earlier ones) changes nothing;
- `ingest(A); ingest(B)` equals `ingest(A ++ (B minus A))`;
- re-reports of a fix whose times differ by at most the tolerance collapse
  to one row however they are split into polls or ordered.

Matching against dropped rows too would make a chain of near repeats depend
on how it was batched. The stored rows the rule needs are read per batch:
those with ts in the batch's span widened by the tolerance (a few hundred
rows for a live poll).

### Retention

Each batch first deletes rows with `ts < dataClock - retention` (the cutoff
floored to whole ms), then dedups against what is left, and never inserts
fixes already older than the cutoff. Deleting first matters: otherwise a
stored fix just before the cutoff could suppress its re-report just after
it and then be deleted, losing both (property-tested with retention and
dedup together).

- **The data clock**, not the wall clock: the body's `now` for live data,
  the replay position for a replay. A replay therefore keeps a rolling
  window of *fixture* time.
- **Default 60 minutes** for both (`DEFAULT_LIVE_RETENTION_MS`), set per
  start: `retentionMs` from 1 minute to 24 hours, or `null` to keep
  everything (the replay gate does). The commands take `retentionMinutes`.
- **Sizes.** On the day fixture at 120x, a 60-minute window holds about
  137,000 rows and the whole day 1,456,777. A live hour at the Bay Area's
  peak (about 180 aircraft, one fix each per 20 s poll) is about 32,000
  rows.

### Feed lifecycle and switching

- **Start.** `start(config)` runs `config`, or does nothing when exactly
  that configuration already runs. A replay that played to its end starts
  over.
- **Set source.** `setSource(config)` switches a running feed, or only
  records the choice when the feed is stopped.
- **Stop.** `stop()` stops the source and keeps the table.
- **When the table is emptied.** Live rows (now) and replayed rows
  (2026-11-09) must never mix, and a replay must match its fixture. So the
  table is emptied (a new store) when the kind or the fixture changes, when
  the retention changes, and whenever a replay starts. Restarting the same
  live source, for example with another interval, keeps its rows.
- **Order.** Control calls run one at a time, in order.
- **Failures.** A start that fails leaves the rows the caller asked to keep
  (the same live source); only a half-made new table is dropped.
- **State.** After `setSource` to another source while stopped, the state
  reports that source with `feed: null` and no rows, rather than the old
  source's last state. `setSource` never starts a replay that ended.
- **Client.** A reply the client cannot validate rejects its request with
  `bad_response` instead of being dropped, so a caller (an MCP command)
  never waits forever. The repo's clients have no request timeouts, so
  this is the fix rather than a timeout. The desktop `EngineClient`, which
  duplicates the logic and has no live API, still drops such replies.
- **App restarts.** The app forgets a feed once it reports `stopped` (a
  replay that ended, or a stop from another window), so an engine restart
  does not replay it over the table.

### Visibility

A worker cannot see `document.visibilityState`.

- **Web.** `PlatformWindow.onVisibilityChange` (new, optional) reports it:
  the web platform calls the listener at once and on every
  `visibilitychange`. The app forwards each change as `liveVisibility`.
- **In the engine.** The engine counts connections: the feed pauses while
  every connection that reported is hidden, and resumes when one is
  visible again or the hidden ones disconnect. Connections that never
  report do not count.
- **On pause,** the request in flight is aborted and nothing is scheduled,
  including the stale check.
- **On resume,** the next poll waits until one interval has passed since
  the last poll, so hiding and showing a tab never adds requests. A replay
  resumes exactly where it paused.
- **Desktop: never paused.** The desktop platform does not implement
  `onVisibilityChange`. It has no live URL wired. A desktop window that is
  merely unfocused is often still being watched (a second monitor), and a
  minimised one costs one small request per 20 s at most. If the desktop
  gets live data, `BrowserWindow` `minimize` / `restore` would be the
  events to map, not focus.

### Commands

`startLive`, `stopLive` and `setLiveSource` are core commands, provided by
the app over `engine.live` (`provideLiveFlights`).

- **Names.** The plan called them `live.start`, `live.stop` and
  `live.setSource`. The registry only accepts camelCase names
  (`/^[a-z][A-Za-z0-9]{0,63}$/`, verb first like `sortGrid` and
  `addChart`), and loosening it would change every MCP client's view of
  command names. So they are `startLive`, `stopLive` and `setLiveSource`.
- **Input.** A discriminated union on `source`:
  - `{ source: 'live', intervalSeconds?, retentionMinutes? }`, with the
    interval between 10 and 600 s;
  - `{ source: 'replay', fixture, intervalSeconds?, speed?, retentionMinutes? }`,
    with the interval between 1 and 600 s and `speed` between 1 and 120;
  - `stopLive` takes `{}`.

  Inputs are strict objects, so a URL or a path is an error.
  `liveSourceConfigFromInput` maps the input to the protocol's config.
- **Effect commands, not undoable.** They follow `copySelection` and the
  workspace-file commands: the effect is outside the workspace state (a
  poller in the engine), so they record no undo entry and Undo never starts
  or stops a feed. Undo restores views, not data feeds. The way back is the
  opposite command. Each returns the feed's `LiveState` as its value. They
  answer `unavailable` where they are not provided (the desktop today).
- **Tiers.** `edit` promises "always runs, undoable", and the design's
  security notes rely on it: a hijacked model "can at worst make undoable
  edits".
  - `startLive` and `setLiveSource` are **`write`**, like `copySelection`.
    A new source starts on an empty table, which Undo cannot bring back,
    and they start network activity. They run only when the host's
    `confirmWrite` allows it: in the app (`appPolicy`) a person's own
    action, and no AI caller until a confirmation UI exists.
  - `stopLive` stays **`edit`**: it only stops polling, keeps every row,
    and is undone by starting again.
  - No caller can make the feed poll more than once per 10 s (see
    Cadence), and the only network access is the host's endpoint. The
    commands read no rows for the caller: views read `flight_states`
    through the same aggregate and page requests as any table.
- **MCP: exposed** (`mcp: true`). An agent asks for a feed the same way a
  person does and the tier decides, so no exemption is needed and the
  parity test passes unchanged.

## Numbers

Linux VM, 2 vCPUs, Node 22, native DuckDB 1.5.6, DuckDB-WASM 1.32.0 (DuckDB 1.4.3).

| Measured | native | DuckDB-WASM |
| --- | ---: | ---: |
| Replay gate, `flights-bay-30min` (71,595 rows, 5 ticks of 10 fixture minutes): load, play, ingest | 0.93 s | 0.67 s (Node, rows handed over in memory) |
| The same in Chromium through the worker (Parquet over HTTP, 16 ticks of 1 s at 120x) | | 17.7 s, almost all of it the 16 one-second ticks |
| `flights-bay-day` at 120x, 20 s ticks (37 ticks, up to 92,968 rows per tick), retention off / 60 min | 18.0 s / 16.2 s total, about 0.45 s per tick | not measured |
| Web first-load JS (`pnpm --filter @glassgrid/web size`) | | 255.8 kB gzip of 400 kB (253.6 kB before this branch) |
| Engine worker script | | 117.3 kB gzip (108.9 kB before) |

## Unverified

- **The live endpoint's timing semantics.** The relay
  (`/api/flights`) is built on the portfolio side and was not reachable
  from here, and neither is api.adsb.lol. Everything about live data is
  tested against mocked responses only. To check against the real relay:
  - that `now` is the time `seen_pos` is measured from, in ms (if `now` is
    the relay's fetch time instead, fix times shift by the upstream's age;
    `fetchedAt` is in the contract for this check);
  - how much `now - seen_pos` of one fix varies across polls (the 2 s
    tolerance assumes tens of milliseconds);
  - whether a CDN-cached answer (`s-maxage=10`) returns the same `now`
    (exact repeats, harmless) or a refreshed one;
  - what `stale: true` looks like in practice.

  `record-flights --raw` (L0) saves raw responses for this.
- **The CDN budget arithmetic** assumes one request per poll per open tab
  and no other traffic to the route.
- **Firefox and Safari:** not run. The worker uses only `fetch` and
  `AbortController`, which both have.
- **The desktop** has the feed in its engine but no host configuration and
  no UI wiring, by design for this milestone.

## Tests

| Suite | What |
| --- | --- |
| `packages/core/src/flights/live.test.ts` (7) | The config's cadence bounds, no URL or path in a config, fixtures, `sameLiveSource`, `/api/flights` at the site root, the envelope schema, the protocol's live messages |
| `packages/core/src/commands/live-commands.test.ts` (6) | Tiers (`write`, `write`, `edit`), MCP exposure and JSON Schema; `unavailable` until provided; AI callers refused for start/switch without confirmation, allowed to stop; validated input to the handler, no undo entry; refused inputs; `liveSourceConfigFromInput` |
| `packages/engine/src/live/dedup.test.ts` (9, fast-check) | Idempotence (a repeated batch; any already-ingested rows); overlap (`ingest(A); ingest(B)` = `ingest(A ++ B\A)`); unique (hex, ts) and no live twins; jittered re-reports collapse however they are batched; archive rows never merge; stored precision; out-of-INTEGER values null |
| `packages/engine/src/live/adsblol-source.test.ts` (14, mocked fetch, fake timers) | Cadence and `cache: 'no-store'`; ms `now` mapping; the 10 s floor, also across stop/start loops and a new source told the last poll; the stale flag; the stale threshold, and no flicker at a 60 s interval; the relay clock clamped for retention; 503 + Retry-After (seconds, floor, HTTP date); exponential backoff with jitter and its cap; timeouts, 404, non-JSON, off-contract bodies; pause/resume (no requests, the one in flight aborted, the interval kept); stop; `retryAfterMs` |
| `packages/engine/src/live/replay-source.test.ts` (5) | `(previous, this]` windows at a speed, time order, the end; determinism under pauses and a slow sink; whole-ms positions at speed 1.0005; reader failures retried; an empty fixture |
| `packages/engine/src/live/flight-store.test.ts` (10, native and wasm) | Column types; the INSERT round trip over two statements (nulls, quotes, `\|`, U+001F); dedup of re-reports; retention; rollback of a batch failing in its second INSERT statement; an absurd altitude stored as null; a fractional data clock; a re-report whose twin expires in the same batch; **properties: the same batch twice, or overlapping batches, give the same table; retention and dedup together equal the JS model** |
| `packages/engine/src/live/replay-gate.test.ts` (1, native and wasm) | **The gate** |
| `packages/engine/src/live/live-feed.test.ts` (6, native and wasm) | Through EngineSession: `not_implemented`, events to every connection, re-polls deduplicated, stop and restart keep rows, switching to a replay empties the table, setSource while stopped (`feed: null`), visibility across connections; one poll per 10 s through start/stop/setSource loops; a speed-1.0005 replay with every state and reply on the contract; a failed restart keeps the rows |
| `packages/engine/src/client/malformed-reply.test.ts` (1) | A reply that fails validation rejects its request with `bad_response` |
| `packages/engine/e2e` (+1, Chromium) | Replay over HTTP through the worker (71,595 rows), a poll of a stand-in endpoint, hidden, shown, stopped |
| `packages/app/src/live.test.ts` (5) | The commands over `engine.live` under the app's policy (AI start/switch refused); visibility only once engaged; restart; an ended replay is not replayed after a restart; unavailable without a feed |
| `apps/web` (+2) | `onVisibilityChange`; fixture URLs under the base, the endpoint at the root |

Totals after this branch: core 354, engine 319 passed and 16 skipped (both
projects), app 75, web 38, desktop 91, ui 229, datasets 24. Engine browser
tests: 10; web E2E: 8.

## Reproduce

```sh
pnpm --filter @glassgrid/engine exec vitest run src/live      # both drivers; the gate is replay-gate.test.ts
pnpm --filter @glassgrid/engine e2e                            # Chromium, includes the live-flights case
pnpm --filter @glassgrid/core test
pnpm --filter @glassgrid/app test
```
