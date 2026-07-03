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

## Status

✅ **Viable** (2026-07-02) — the full pipeline works end to end against the live network:

- Backfilled **14.5k+ records** across all four Standard.site collections in minutes, no webhook flood — Tab's ack-window websocket + in-process micro-batching (200 events/tx) gives backpressure by construction
- Restart mid-backfill: zero duplicate records (rev-compare idempotency absorbed 93 redelivered events in testing)
- Keyword + semantic search return sensible results (`q=atproto` → "Deconstructing atproto Blog Storage"); embeddings drain on CPU Ollama
- Internal link graph extracted at ingest (16k+ links); most-linked publication showed 200 archive backlinks; Constellation integration confirmed cached + serve-stale

**Caveats / follow-ups:** `@atproto/tap`'s TapChannel doesn't run under Bun (uses `ws` streams) — replaced with a ~200-line native WebSocket consumer, wire protocol is trivial. Some publishers store document bodies as rich block content (e.g. `blog.pckt.content`) rather than `textContent`, so only title/description get indexed for those — needs per-lexicon extractors. Stress test on a $5/mo VPS still pending.
