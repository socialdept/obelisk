# Reservoir

A self-hosted archive of AT Protocol records with keyword and vector search.

## What

Reservoir syncs configurable AT Protocol collections from the network (via [Tab](https://tangled.org/pds.dad/tab), a [Tap](https://docs.bsky.app/blog/introducing-tap) fork), holds a permanent archive of every record it sees, and exposes an authenticated HTTP API for querying:

- Records by DID, collection, or rkey
- Full-text keyword search over record content
- Semantic vector search (Ollama embeddings + pgvector)
- Relationship and backlink queries between indexed records
- Network-wide backlinks via [Constellation](https://constellation.microcosm.blue) (cached)

Deletions on the network become soft deletes — the archive remembers, queries respect deletion by default.

## Why

**The question this POC answers:** can Tab + a single Bun app + pgvector deliver a safe, queryable, semantically searchable AT Protocol archive?

A previous attempt using Tap's webhook delivery flooded the receiving app during backfill (hundreds of requests/sec). Reservoir consumes Tab's acknowledged websocket directly with in-process batching — backpressure by construction.

## How

- **Bun + TypeScript**, single process: ingester + embedding worker + HTTP API
- **Tab** (docker) for sync — multiple signal collections, ack-based websocket
- **Postgres 17 + pgvector** via Drizzle ORM
- **Ollama** (`nomic-embed-text`) for embeddings
- **Hono** API with bearer token auth

Target collections (configurable in `reservoir.config.ts`): `site.standard.document`, `site.standard.publication`, `site.standard.graph.subscription`, `site.standard.graph.recommend`.

## Running it

```bash
docker compose up -d          # postgres (pgvector) + tab
cp .env.example .env
ollama pull nomic-embed-text  # embedding model, runs on CPU
bun install
bun run start                 # migrates, then: ingester + embed worker + API on :3000
```

Mint a token and query:

```bash
TOKEN=$(bun run scripts/create-token.ts cli)
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/v1/records?collection=site.standard.document&limit=5"
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/v1/search?q=atproto"
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/v1/search/semantic?q=decentralized+publishing"
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/v1/records/{did}/{collection}/{rkey}/links"
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/v1/records/{did}/{collection}/{rkey}/backlinks"
curl -H "Authorization: Bearer $TOKEN" "localhost:3000/api/v1/records/{did}/{collection}/{rkey}/backlinks/network"
```

Useful flags: `include_deleted=1` (see soft-deleted records), `cursor` (pagination), `collection`/`did`/`path` filters on search and backlinks.

## API

| Endpoint | What it does |
|---|---|
| `GET /api/v1/records` | List/filter archived records |
| `GET /api/v1/records/:did/:collection/:rkey` | Fetch one record |
| `GET /api/v1/search?q=` | Weighted full-text search (title > description > body) |
| `GET /api/v1/search/semantic?q=` | Vector search over chunked content (pgvector HNSW) |
| `GET /api/v1/records/…/links` | Outgoing AT Proto references extracted from the record |
| `GET /api/v1/records/…/backlinks` | Records in the archive that reference this one |
| `GET /api/v1/records/…/backlinks/network` | Network-wide backlinks via Constellation (cached, serve-stale) |
| `GET /api/v1/types` | Inventory of `$type` values observed in the archive, by path, with counts |
| `GET /api/v1/types/:nsid` | Usage + resolved lexicon schema + derived text fields + observed union members |
| `GET /api/v1/events` | Cursor-paged change log — poll it to react to new/updated/deleted records |
| `/api/v1/webhooks` CRUD | Batched push subscriptions over the event log (HMAC-signed) |

### Filtering by record content

Any endpoint that returns records accepts `record.<path>=<value>` params matching against the record JSON:

```bash
# all documents whose content block is Offprint's
curl … "localhost:3000/api/v1/records?record.content.\$type=app.offprint.content"
# semantic search within that slice
curl … "localhost:3000/api/v1/search/semantic?q=ai+filmmaking&record.content.\$type=app.offprint.content"
```

Use `GET /api/v1/types` to discover which `$type` values exist before filtering.

### Consuming changes (Laravel etc.)

**Pull:** `GET /api/v1/events?cursor=<last-seen>&collection=…&include_record=1` returns applied changes in order with a resumable cursor — poll it from a scheduled job, persist the cursor, replay any time by rewinding it. The log only contains *applied* changes (redelivered/stale sync events never appear), so consumers see no duplicates.

**Push:** create a webhook subscription and reservoir delivers the same events as batched, HMAC-signed POSTs — full batch immediately, partial batch at most once per `max_wait_ms`, so your endpoint is never flooded:

```bash
curl -X POST … "localhost:3000/api/v1/webhooks" -d '{
  "name": "my-laravel-app",
  "url": "http://laravel.test/hooks/reservoir",
  "collections": ["site.standard.document"],
  "record_matchers": { "content.$type": "app.offprint.content" },
  "max_events": 200, "max_wait_ms": 5000,
  "from_cursor": "start"
}'   # → returns the signing secret ONCE — store it
```

Verify with `hash_equals('sha256='.hash_hmac('sha256', $body, $secret), $sigHeader)`. Delivery is at-least-once with per-subscription cursor: failures back off exponentially and never advance the cursor, `PATCH {"cursor": N}` rewinds for replay, `POST /webhooks/:id/test` sends a synthetic signed event.

### Dev mode

`RESERVOIR_DEV_MODE=true` disables API auth entirely (loud warning at boot). Local development only.

## Status

✅ **Viable** (2026-07-02) — the full pipeline works end to end against the live network:

- Backfilled **14.5k+ records** across all four Standard.site collections in minutes, no webhook flood — Tab's ack-window websocket + in-process micro-batching (200 events/tx) gives backpressure by construction
- Restart mid-backfill: zero duplicate records (rev-compare idempotency absorbed 93 redelivered events in testing)
- Keyword + semantic search return sensible results (`q=atproto` → "Deconstructing atproto Blog Storage"); embeddings drain on CPU Ollama
- Internal link graph extracted at ingest (16k+ links); most-linked publication showed 200 archive backlinks; Constellation integration confirmed cached + serve-stale

**Caveats / follow-ups:** `@atproto/tap`'s TapChannel doesn't run under Bun (uses `ws` streams) — replaced with a ~200-line native WebSocket consumer, wire protocol is trivial. Some publishers store document bodies as rich block content (e.g. `blog.pckt.content`) rather than `textContent`, so only title/description get FTS/embedded for those — the type inventory + lexicon registry (`/api/v1/types/:nsid`) already derives the extraction map (observed union members + their text fields); wiring it into the embed pipeline is LAB-10. Batched webhooks (LAB-15), dynamic audiences (LAB-16), Laravel package (LAB-17), and the $5/mo VPS stress test (LAB-9) are tracked in Linear.
