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

## Status

🚧 **Exploring** — verdict pending.
