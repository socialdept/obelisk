# Jetstream cutover and ingest resource work

Status of the 2026-08-16 session: why Tab was burning the box, what changed on
production, what is built but not shipped, and what still needs verifying.
Written mid-flight — the production switch is applied but **not yet verified**,
because Bluesky went down during the verification window.

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

`GOMEMLIMIT` could never fix it: it bounds the Go heap, but RSS was inflated by
SQLite's off-heap page cache via CGO, which the Go GC does not manage. The
firehose working set was the actual cause.

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

The memory drop is the OOM cause identified. CPU was still 61% when last
sampled, but that was the post-boot enumeration/resync burst (589 repos, CAR
parsing), not firehose decode — network I/O was only 12.3MB. **CPU needs
re-measuring at steady state.**

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

## Not yet verified

`tab_jetstream_events_processed_total` was **0** (52 received) when Bluesky went
down. A low processed/received ratio is normal — Tab only processes events from
enumerated repos, and the firehose baseline was 35/4,439 — but zero is also what
a broken tracking path looks like.

Jetstream confirmed dead at the time from an independent probe: 0 messages in
25s on `app.bsky.feed.post`, which had returned 499 in 25s an hour earlier. So
the reading is confounded by the outage, not by configuration.

### Verification to run once Bluesky recovers

Publish or update an article (local dev against an existing session is fine —
the record lands in a real repo), then:

```
curl -s localhost:2481/metrics | grep -E "tab_jetstream_events_(received|processed)_total"
docker exec -i obelisk-postgres-1 psql -U obelisk -d obelisk -c "SELECT count(*) FROM records;"
docker stats --no-stream obelisk-tab-1
docker inspect obelisk-tab-1 --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
```

Pass: `processed` moves off zero, `records` advances past **3,056,913**, CPU
well below 66%, `RestartCount` stable.

Fail: `received` climbs while `processed` stays 0 after a known-tracked repo
publishes. That means the enumerated repo set did not carry over — roll back.

### Rollback

Remove `TAB_JETSTREAM_URL`, `docker compose … up -d tab`. The firehose cursor
persists in the `tabdata` volume, so the relay resumes where it stopped —
**valid for roughly 72 hours** (relay backfill window), and only while that
volume exists. Do not delete `tabdata`.

---

## Built locally, not shipped

Branch `claude/jetstream-v2-and-retention`, three commits, **not pushed**.

| commit | contents |
|---|---|
| `9e4d437` | Test DB defaults to the project's `DATABASE_URL` |
| `106b56f` | Jetstream **v2** ingest driver behind `INGEST_SOURCE` |
| `d104d6d` | Opt-in event-log retention, disabled by default |

Typecheck clean, 374 tests pass.

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

This is **not** the fix for the production box — `TAB_JETSTREAM_URL` is, and it
is better, because Tab still sits in front of Obelisk providing acked delivery
and redelivery. The driver matters for two other reasons: Tab is v1-only and v1
will eventually retire, and the driver is the path for anyone who wants Obelisk
without running Tab at all. It also has a real gap: Tab uses Light Rail
(`listReposByCollection`) to discover repos by collection, and Jetstream has no
equivalent, so dropping Tab loses historical discovery of dormant repos.

**Event-log retention** (`src/db/retention.ts`, `scripts/prune-events.ts`) —
opt-in via `EVENTS_RETENTION_DAYS`, **default 0 = disabled, and should stay
disabled here.** The event log backs `getEvents`, which is queryable by
since/until/collection/did/action, so it is history in its own right, not a
delivery buffer. It exists for deployments using Obelisk as a pure delivery
relay. Deletes only what every webhook subscription has been delivered past AND
that is older than the floor; the age floor protects `getEvents` pull consumers
whose cursors live in their own database.

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

- Verify `processed` once Bluesky recovers (above). Everything else is blocked
  on this.
- Re-measure steady-state CPU after the enumeration burst finishes.
- If memory stays low, `GOMEMLIMIT`, `RELAY_IDENT_CACHE_SIZE` and the 512M cap
  become removable rather than load-bearing.
- `2.7M` records landed in the 7 days before this session (vs ~14.5k/day
  steady). An enumeration/resync burst — worth understanding before sizing the
  volume, since a repeat adds ~7GB in days.
- Tab is v1-only; a v2 request would go to `fatfingers23`, Tab's author.
- `TAB_METRICS_LISTEN=:2481` is marked temporary in the compose comments for the
  OOM investigation. It has been genuinely useful — worth keeping.
