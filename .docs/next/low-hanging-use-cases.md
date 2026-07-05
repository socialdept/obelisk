# Backlog: low-hanging use cases

Use cases that are **mostly assembly** of primitives Obelisk already has (FTS +
vector index, link graph, event log, webhooks, audiences, feeds, `aggregate`).
Captured here, unfiled — promote to a Linear issue when picked up. All are
**read-only** (hard boundary #2 intact).

Ranked by value-per-effort. See the ranking/search/feed epic (LAB-37) for the
larger adjacent work; these are deliberately smaller and independent.

---

## 1. Similar-records / recommendations — `getSimilar` (effort: tiny)

**Idea:** `getSimilar?uri=at://…&limit=` → nearest-neighbour records by embedding.

**Reuses:** the pgvector `record_embeddings` + HNSW index that already power
`searchRecords?semantic`. The *only* difference: source the query vector from the
target record's **existing** embedding instead of an Ollama call — then the same
NN query, excluding the record itself (and optionally its own DID).

**Why it's cheap:** ~a dozen lines over the existing semantic path. Ships
**before** and independent of LAB-37.

**Value:** "related posts / related documents", near-duplicate detection, content
discovery — for both the search-engine and Standard.site/Offprint angles.

**Notes:** service plane, GET, query. Records with no embedding (`embed_status !=
done`) have no vector → return empty / 404-ish. Optional `collection` filter to
scope neighbours.

---

## 2. Query → RSS / JSON-Feed export (effort: tiny)

**Idea:** turn a saved feed / search / `getEvents` slice into an Atom / RSS /
JSON-Feed document. e.g. *"publication X's new documents as RSS."*

**Reuses:** `feeds` config, `searchRecords`, `getEvents` — no new query path. Just
a **serializer** over rows already returned.

**Why it's cheap:** a formatter, not a feature. Lexicon-generic if the field
mapping (title/link/date) comes from config/lexicon extraction, not hardcoded.

**Value:** big for the publishing use case — every publication/feed becomes a
subscribable RSS endpoint with zero consumer code.

**Scope tension:** RSS entries want author **handles**, not DIDs → bumps the
handle-resolution boundary (still out of scope). Options: emit DIDs and let the
consumer resolve, or revisit a small resolve-and-cache. Not a blocker.

---

## 3. Live event tail — SSE / WebSocket over `getEvents` (effort: moderate) — ✅ SHIPPED (LAB-45, SSE)

**Idea:** a streaming endpoint that **pushes** applied changes with the same
filters `getEvents` already takes (`collection`, `did`, `audience`, `feed`,
`link.*`, `record.*`), resumable from a cursor.

**Reuses:** the entire `getEvents` filter + cursor machinery. The only new part is
the **transport** (SSE tail / WS) instead of poll.

**Why it matters most:** turns Obelisk into an **app-specific filtered Jetstream**
— a consumer subscribes to exactly the slice of the firehose it cares about
without running its own relay/Tab consumer. This is the one that most changes what
Obelisk *is* to a downstream app.

**Notes:** stays read-only. Backpressure/slow-consumer handling is the real design
work; cursor replay + live tail hand-off (mirror the Tab `live:false→true`
cutover) is the tricky seam. Ties to LAB-9 (load) under fan-out.

---

## 4. Mention / reply / citation monitor (effort: tiny)

**Idea:** "notify me when anything links to this URI/DID" — a preset webhook
subscription scoped by an inbound-link filter.

**Reuses:** batched HMAC webhooks + `link.*` filters + the backlink graph. Mostly
**config over existing machinery**, not new code.

**Value:** notifications, "who cited my document", reply/mention tracking — without
the consumer polling.

---

## 5. Query → data export (CAR / JSON backup) (effort: moderate)

**Idea:** export a DID's records — or any `where`-filtered set — as a JSON bundle
or CAR for backup / migration / "own your data".

**Reuses:** `getRepo` backfill path, `getRecords`, `getFootprint`.

**New:** export serialization + streaming (large sets can't buffer in memory —
same lesson as the getRepo CAR reader).

**Value:** portability / backup story. Lower priority than 1–4; more plumbing.

---

## Cross-cutting

- **Handle resolution** recurs (RSS authors, similar-record display, export
  metadata). Same revisit question as LAB-37 — currently out of scope; consumers
  resolve DIDs. Not blocking any of the above.
- Everything here is read-only and lexicon-generic if field mappings stay in
  config/lexicon extraction. Don't hardcode Bluesky/Standard.site assumptions.
