# Jetstream cutover and ingest resource work

Status of the 2026-08-16 session: why Tab was burning the box, what changed on
production, and what is built but not shipped.

---

## Outcome, read this first

**The Jetstream switch works and is verified.** Three separate repos delivered
`live: true` events hours after the cutover, with the relay bypassed
(`firehose_events_received` 0) and network I/O down from 318MB to 55MB. That
half of the problem is solved and the change stays on production.

**It did not achieve the goal.** The point was to downsize to a $5 box. Tab then
OOM-looped ~222 times: 31 boots in 30 minutes, kernel kills at ~508MiB, then at
~765MiB after the cap was raised. Three caps have now failed the same way
(256M → 512M → 768M), so the growth is unbounded and no cap holds it.

**The cause is resync, not the firehose.** Tab enumerates 589 repos, parses
their CARs, dies before draining the queue, restarts, and repeats — 44.6GB of
block reads doing the same work over and over. The CPU is that loop, not useful
throughput. This predates the switch and was masked by the firehose cost.

**So Tab cannot fit a $5 box** (1 vCPU / 1GB). Postgres, the app and Caddy total
~296MiB and idle under 3% CPU; they fit comfortably. Tab does not. Reaching the
goal means **removing Tab**, which is what the v2 driver below is for — not
tuning it further.

Next step when picking this up: capture a heap profile while Tab is near its
ceiling (`curl -s "localhost:2481/debug/pprof/heap?debug=1"`) to identify the
allocation. `TAB_OUTBOX_CAPACITY` (default 100,000 buffered events) is the
leading untested suspect.

Tuning applied and then reverted, for the record: `TAB_RESYNC_PARALLELISM` 2→1,
`GOMEMLIMIT` 400→600MiB, memory cap 512M→768M. None helped.
`TAB_JETSTREAM_URL` was kept.

---

## The problem

Tab was subscribed to the relay firehose (`relay1.us-east.bsky.network`) and
filtering on the **output** side, so it decoded every event on the network to
keep a handful.

Measured on production, 2026-08-16:

| metric | value |
|---|---|
| `tab_firehose_events_received_total` | 4,439 |
| `tab_firehose_events_processed_total` | 35 (0.8%) |
| CPU | 66.77% |
| Memory | 511.1MiB / 512MiB (99.81%) |
| Block I/O | 48.2GB read |
| Actual useful throughput | ~14.5k records/day, ~1 relevant event/min |

The `docker-compose.yml` comments record the OOM history this caused: 110
restarts at a 256M cap, `RELAY_IDENT_CACHE_SIZE` reduced from 2,000,000,
`TAB_RESYNC_PARALLELISM` cut to 2, `GOMEMLIMIT=400MiB` added, limit raised to
512M. Memory still sat pinned at the ceiling.

`GOMEMLIMIT` could never fix it: it bounds the Go heap, while the kernel kills
on anonymous RSS, which includes memory malloc'd outside the Go heap. Raising it
has never changed the outcome.

The firehose was assumed to be the cause. It was not — see the outcome section.
Removing it left the OOM loop intact.

---

## What changed on production

One line in `/srv/obelisk/docker-compose.yml`, `tab` service:

```yaml
      TAB_JETSTREAM_URL: wss://jetstream2.us-east.bsky.network
```

Tab has a built-in Jetstream consumer. Setting this **replaces the relay
entirely** and maps `TAB_COLLECTION_FILTERS` into server-side
`wantedCollections`, so filtering happens upstream.

Applied with both compose files:

```
cd /srv/obelisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d tab
```

### Immediate result

| | before | after |
|---|---|---|
| Memory | 511.1MiB (99.81%) | **84.22MiB (16.45%)** |
| Block I/O | 48.2GB read | 15.7MB |
| `firehose_events_received` | 4,439 | 0 (relay bypassed) |

The 84MiB reading was a freshly booted process, not a steady state — it climbed
back to the ceiling within minutes. The network and block I/O reductions are
real and permanent; the memory figure was not a fix.

### Verified before switching

Against live Jetstream, with concurrent subscriptions so all variants saw the
same traffic window:

- Tab speaks Jetstream **v1** (`/subscribe`, `wantedCollections`). No v2 markers
  in the binary (`subscribeEvents`, `network.bsky.jetstream` absent).
- Wildcards work: `site.standard.*` filters correctly, no foreign collections.
- The exact production pair (`site.standard.*` + `app.offprint.*`) delivers —
  repeated `wantedCollections` params OR together.
- `identity` / `account` events flow regardless of collection filters.
- Cursors are unix-microsecond timestamps and persist across restarts.

An earlier sequential test suggested the two-wildcard pair was broken. That was
traffic variance (~1 event/90s on these collections), disproved by running the
variants concurrently.

---

## Built locally, not shipped

Branch `claude/jetstream-v2-and-retention`, pushed. The retention commit
(`d104d6d`) was reverted — the event log backs `getEvents` and is history in its
own right, so an archive keeps it.

| commit | contents |
|---|---|
| `9e4d437` | Test DB defaults to the project's `DATABASE_URL` |
| `106b56f` | Jetstream **v2** ingest driver behind `INGEST_SOURCE` |

Typecheck clean, 365 tests pass.

**Test DB fix** — `test/helpers.ts` defaulted to `localhost:5432` with default
credentials while the compose Postgres is on 5433 with a password, so the entire
suite failed before any of this work. Now defaults to `DATABASE_URL` (Bun loads
`.env`) and always swaps the database name to `obelisk_test`.

**Jetstream v2 driver** (`src/ingest/jetstream.ts`) — native v2, parsed against
the real wire format captured from `jetstream.us-west.bsky.network`. Batching
extracted from the Tab ingester into `src/ingest/batch-applier.ts` so both
transports share it. Cursor persisted in a new `ingest_cursor` table **inside
the batch transaction**, so it can never lead applied data. Proven end to end
locally: 252 records on a cold start, then resumed from the stored cursor.

Default is `INGEST_SOURCE=tab`, so nothing changes until opted in.

**This is the path to the $5 box.** `TAB_JETSTREAM_URL` removed the firehose
cost but cannot remove Tab's footprint, and the footprint is what does not fit.
Keeping Tab means keeping ~500MiB+ of unbounded growth on a 1GB box.

The trade is real: Tab provides acked, indefinitely-redelivered delivery, where
Jetstream gives cursor resume bounded by retention. And there is a gap: Tab uses Light Rail
(`listReposByCollection`) to discover repos by collection, and Jetstream has no
equivalent, so dropping Tab loses historical discovery of dormant repos.

---

## Disk

Reclaimed during the session, live: ~11.4GB (8GB unused Ollama image, 3.4GB
build cache, dead console image + volumes). Took the box from 90% to roughly
65%.

Archive breakdown and growth:

| table | size |
|---|---|
| `records` | 7425 MB |
| `record_embeddings` | 3406 MB |
| `record_links` | 1576 MB |
| `events` | 1366 MB |
| `record_types` | 583 MB |

Steady-state growth is ~68MB/day, about **2GB/month / 24GB/year**. With pruning
deliberately off, disk is the only real scaling axis.

Plan: move `pgdata` to a DigitalOcean block volume (50GB ≈ $5/mo, resizable
upward), which gives roughly 17 months of headroom from 15.18GB. Sequence it
**after** the ingest work settles, and take the droplet destruction last, with
everything reversible until that final step. Note that droplet snapshots do
**not** include attached volumes, and that Docker must be ordered after the
mount or Postgres will initialise an empty database on the mount point.

---

## Open threads

- Heap profile Tab near its ceiling to identify the allocation; test
  `TAB_OUTBOX_CAPACITY` as the leading suspect.
- Decide whether to remove Tab (driver + a Light Rail discovery sweep) or accept
  a RAM tier rather than a $5 one.
- If memory stays low, `GOMEMLIMIT`, `RELAY_IDENT_CACHE_SIZE` and the 512M cap
  become removable rather than load-bearing.
- `2.7M` records landed in the 7 days before this session (vs ~14.5k/day
  steady). An enumeration/resync burst — worth understanding before sizing the
  volume, since a repeat adds ~7GB in days.
- Tab is v1-only; a v2 request would go to `fatfingers23`, Tab's author.
- `TAB_METRICS_LISTEN=:2481` is marked temporary in the compose comments for the
  OOM investigation. It has been genuinely useful — worth keeping.
