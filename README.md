# Obelisk

> **Social Dept. Obelisk** — a self-hostable archive of AT Protocol records with keyword and vector search. A monument of records built to outlast the network: it keeps what the network deletes.

## What

Obelisk syncs configurable AT Protocol collections from the network (via [Tab](https://tangled.org/pds.dad/tab), a [Tap](https://docs.bsky.app/blog/introducing-tap) fork), holds a permanent archive of every record it sees, and exposes an authenticated HTTP API for querying:

- Records by DID, collection, or rkey
- Full-text keyword search over record content
- Semantic vector search (Ollama embeddings + pgvector)
- Relationship and backlink queries between indexed records
- Network-wide backlinks via [Constellation](https://constellation.microcosm.blue) (cached)

Deletions on the network become soft deletes — the archive remembers, queries respect deletion by default.

## Why

**The question this POC answers:** can Tab + a single Bun app + pgvector deliver a safe, queryable, semantically searchable AT Protocol archive?

A previous attempt using Tap's webhook delivery flooded the receiving app during backfill (hundreds of requests/sec). Obelisk consumes Tab's acknowledged websocket directly with in-process batching — backpressure by construction.

> Scope, boundaries, and the feature roadmap live in [SCOPE.md](./SCOPE.md) — new ideas get tested against it before they get issues.

## Design principle

**Generalized to any lexicon, always.** Behavior is derived from published lexicon schemas wherever possible (the registry resolves any NSID from the network); where derivation can't work, there's a config extension point anyone can fill (`obelisk.config.ts` — collections, field overrides, following semantics). Features that would require hardcoding a specific lexicon don't ship. Standard.site collections are the *default config*, not assumptions in code.

In practice: the collections config is just a list of NSIDs. Title fields, prose fields, and rich-content locations are read from each collection's own lexicon (`titleFields`/`textFields`/`richContentFields` exist as per-collection overrides for unpublished or wrong lexicons). Full-text search runs over worker-materialized `extracted_title` (weight A) + `extracted_text` (weight C) — no record-shape assumptions in SQL. `scripts/extract-all.ts` re-extracts the whole archive after extraction-rule changes (fast, no re-embedding).

## How

- **Bun + TypeScript**, single process: ingester + embedding worker + HTTP API
- **Tab** (docker) for sync — multiple signal collections, ack-based websocket
- **Postgres 17 + pgvector** via Drizzle ORM
- **Ollama** (`nomic-embed-text`) for embeddings — or an **OpenAI-compatible API** (pluggable, see below)
- **Hono** API with bearer token auth

Target collections (configurable in `obelisk.config.ts`): `site.standard.document`, `site.standard.publication`, `site.standard.graph.subscription`, `site.standard.graph.recommend`.

## Running it

```bash
docker compose up -d          # postgres (pgvector) + tab
cp .env.example .env
ollama pull nomic-embed-text  # embedding model, runs on CPU
bun install
bun run start                 # migrates, then: ingester + embed worker + API on :6060
```

Mint a token and query:

```bash
TOKEN=$(bun run scripts/create-token.ts cli)
A="Authorization: Bearer $TOKEN"
curl -X POST -H "$A" "localhost:6060/xrpc/site.standard.document.getRecords" -d '{"limit": 5}'
curl -X POST -H "$A" "localhost:6060/xrpc/site.standard.document.searchRecords" -d '{"q": "atproto"}'
curl -X POST -H "$A" "localhost:6060/xrpc/site.standard.document.searchRecords" -d '{"q": "decentralized publishing", "semantic": true}'
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getLinks?uri=at://{did}/{collection}/{rkey}"
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getBacklinks?uri=at://{did}/{collection}/{rkey}"
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getNetworkBacklinks?uri=at://{did}/{collection}/{rkey}"
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getFootprint?did={did}&includeDeleted=1"
```

Everything is XRPC — there is no REST plane. Useful flags: `includeDeleted` (see soft-deleted records), `cursor` (pagination), `collection`/`did`/`path` filters on backlinks.

## API

Obelisk's entire HTTP surface is atproto-shaped XRPC — **there is no REST plane.** Two planes, split by one invariant: *in the collection plane, `{collection}` is always the collection of the records being returned/counted/searched.* Anything that spans collections or is about the archive itself lives in the service plane. (Full rule in [SCOPE.md](./SCOPE.md#api-planes).)

Following atproto's own `query`/`procedure` split: **queries are GET** (reads), **procedures are POST** (mutations against Obelisk's own Postgres — never a PDS, so hard boundary #2 holds). The collection plane is all queries; the service plane has both.

### Collection plane — `/xrpc/{collection}.{verb}`

The method NSID *is* the archived collection you're querying:

```bash
# list with filters + sorting (slices-style where DSL: eq / neq / contains / in / nin)
curl -X POST "localhost:6060/xrpc/site.standard.document.getRecords" -d '{
  "where": { "content.$type": { "eq": "app.offprint.content" } },
  "sortBy": [{ "field": "indexedAt", "direction": "desc" }],
  "limit": 20
}'

curl "localhost:6060/xrpc/site.standard.document.getRecord?uri=at://…"
curl -X POST "localhost:6060/xrpc/site.standard.document.countRecords" -d '{"where": {…}}'
curl -X POST "localhost:6060/xrpc/site.standard.document.searchRecords" -d '{"q": "atproto", "semantic": true}'
# hybrid: RRF-fuse keyword + vector into one ranked list (mode: fts | semantic | hybrid)
curl -X POST "localhost:6060/xrpc/site.standard.document.searchRecords" -d '{"q": "atproto", "mode": "hybrid"}'
# keyword search ordered by a named ranking profile instead of raw ts_rank
curl -X POST "localhost:6060/xrpc/site.standard.document.searchRecords" -d '{"q": "atproto", "ranking": "relevant-fresh"}'
```

`where` supports record fields (dot paths like `content.$type`, resolved against the record body — **not** prefixed with `value`), system fields (`did`, `collection`, `rkey`, `uri`, `cid`, `rev`, `lang`, `indexedAt`), and the special `json` field (whole-record search). System fields win on a name clash; prefix with `record.` (e.g. `record.did`) to force a JSON-path lookup and reach a record whose own body carries a `did`/`uri`/… key. Record-path `eq`/`in` compile to jsonb **containment** (`@>`) served by a single GIN index (LAB-11), so they stay index scans at scale; pass an array value to `eq` to match array membership (`tags: {eq: ["x"]}`). `contains` (substring) stays an extract-text `ILIKE` fallback. **Negation** — `neq` / `nin` (LAB-46) — excludes matches server-side (e.g. `did: {nin: [...]}` to mute a spammer with correct pagination/counts); it includes rows where the field is NULL/absent (null-safe) and isn't GIN-indexable (a scan — fine for a bounded exclusion list). Responses use atproto conventions (`{uri, cid, did, collection, value, indexedAt}`, `{error, message}` errors). Write verbs return `MethodNotImplemented` — Obelisk is a read-only archive.

#### Ranking profiles (LAB-37)

`searchRecords` accepts a `ranking: "<profile>"` to order by a configured score instead of raw relevance. A profile (in `obelisk.config.ts` under `rankings`) is a **linear weighted sum** of signals — `score = Σ weightᵢ · transformᵢ(signalᵢ)`:

- `relevance` — the FTS/vector match quality (contributes **0** when there's no `q`, so the same profile ranks a search box and a chrono-less feed);
- `interactions` — inbound-link popularity per a config `{collection, path, weight}` link spec, read from the `interaction_counts` rollup (maintained live off the ingest path, scoped to the specs your profiles reference; counts only non-deleted sources). Rebuild/repair with `bun run scripts/rebuild-interactions.ts`. Where each collection's counts come from is resolved per `interactionSources` (LAB-40): **local** when we consume the collection and it's backfilled, else **Constellation** network backlinks (fetched via the cached client into the same rollup); `overrides` pin a source;
- `recency` — `exp` half-life decay over `indexedAt` or a `record.<path>` timestamp.

Results carry a per-row `score` and a compound `(score, id)` cursor that carries its own `now` anchor, so ranked pagination stays stable as the clock (and later, counts) move. Unknown profile → `InvalidRequest`. Ranking, like everything else, is **config, not code** — no lexicon baked in.

FTS is **per-language** (LAB-43): each record's content language is detected on ingest (from its own `langs`/`lang` field) and stored as `lang`, and the `searchable` index tokenizes with that language's Postgres config — falling back to `english` when unset (existing behavior) and `simple` (unstemmed) for a detected-but-unsupported language, so non-English text is never mis-stemmed. `lang` is a filterable/facetable system field.

`searchRecords` also takes `highlight: true` — each result gains a `ts_headline` `highlight` excerpt with `<mark>`-wrapped matches — and `facets: ["collection", "did", …]` — group counts over the same keyword predicate + filters, returned as `{facets: {field: [{value, count}]}}` alongside `records` (one round-trip for a results list + filter sidebar; facet fields resolve through the same `where` DSL). Both work across modes.

`searchRecords` takes a `mode` (`fts` default / `semantic` / `hybrid`). **`hybrid`** (LAB-41) runs both the keyword and vector retrievers and fuses them with Reciprocal Rank Fusion (`Σ 1/(60 + rankᵢ)`) — rank-based, so no `ts_rank`-vs-distance scale tuning — surfacing a doc strong in *either* leg. Hybrid composes with a `ranking` profile: the fused relevance feeds the `relevance` signal, so recency/interactions layer on top (with no profile, it's relevance-only). `where`/collection filters apply to both legs. (`semantic` + `ranking` alone is still deferred — use `hybrid`.)

### Service plane — `/xrpc/social.dept.obelisk.{verb}`

Obelisk's own cross-collection / archive operations, under the owned authority `social.dept.obelisk` (domain `dept.social`). All error bodies are atproto `{error, message}`.

**Queries (GET):**

| Method | What it does |
|---|---|
| `getEvents` | Cursor-paged change log — filters `cursor`, `since`, `until`, `order` (`asc`/`desc`), `collection`, `did`, `action`, `audience`, `feed`, `link.*`, `record.*`, `include_record` |
| `subscribeEvents` | **SSE live tail** of the change log — same filters as `getEvents`, replay from `cursor` (0 = all history) then push new events (`event:` frames, `id:` = cursor, resumable via `Last-Event-ID`). Obelisk as a filtered firehose; backpressure by construction |
| `getTypes?collection=&path=` | Inventory of `$type` values observed in the archive, by path, with counts |
| `getType?nsid=` | Usage + resolved lexicon schema + derived text fields + observed union members |
| `getLinks?uri=` | Outgoing AT Proto references extracted from a record |
| `getBacklinks?uri=&collection=&path=` | Records in the archive that reference a target |
| `getNetworkBacklinks?uri=&collection=&path=&count=` | Network-wide backlinks via Constellation (cached, serve-stale) |
| `getFootprint?did=&includeDeleted=&cursor=&limit=` | Everything for a DID across every collection: counts-by-collection (with deleted breakdown) + a unified timeline |
| `aggregate?source=&groupBy=&aggregate=&since=&until=&orderBy=&limit=` | Grouped counts over `records` (default) / `events` / `links`. `groupBy` (comma-separated) accepts a source field, a `record.<path>`, or a time bucket `<timeDim>:<hour\|day\|week\|month\|year>`; `aggregate` is `count` (default) or `count_distinct:<field>`. Returns `{groups: [{key, count}]}`. POST the same shape with a `where` body for the full filter DSL |
| `getRankedFeed?collection=&feed=&audience=&ranking=&cursor=&limit=` | A ranked **feed skeleton**: records filtered by feed / audience / `where` / `link.*`, ordered by a `ranking` profile (chrono when omitted). Returns `{feed: [{post: uri}], cursor}` — the app.bsky `getFeedSkeleton` shape. **Not public**: served authenticated; the consuming app relays it into its own feed generator. POST for a `where` body |
| `getBackfillStatus?collection=&window=` | Backfill progress for a collection (omit `collection` for all) — records archived, repos seen/caught-up, backfill vs live ingest rate, and a drain-based `complete` flag |
| `getWebhooks` / `getWebhook?id=` | List / fetch push subscriptions |
| `getAudiences` / `getAudience?name=` | List / fetch query-defined DID sets |
| `getAudienceMembers?name=&limit=&offset=` / `checkAudienceMember?name=&did=` | Resolve members / test membership |
| `getWatchedDids?active=` / `getWatchedDid?did=` | List / fetch the "who am I auditing" set |
| `getBlockedDids` | List the DID deny-list — repos Obelisk refuses to archive |
| `getBlockedPdses` | List the PDS deny-list — wildcard patterns whose repos are never archived |

**Procedures (POST, JSON body — mutate Obelisk's own DB, never a PDS):**

| Method | Body | What it does |
|---|---|---|
| `createWebhook` | `{name, url, …}` | Create a batched HMAC-signed subscription; returns the secret **once** |
| `updateWebhook` / `deleteWebhook` / `testWebhook` | `{id, …}` | Update / remove / send a signed synthetic event |
| `createAudience` / `updateAudience` | `{name, definition}` | Create / redefine a DID set |
| `deleteAudience` | `{name}` | Remove |
| `addWatchedDid` | `{did, note?, collections?}` | Watch a DID across *all* collections; best-effort enrolls it in the footprint Tab (`/repos/add`, backfill + forward capture). The table is the source of truth. |
| `updateWatchedDid` | `{did, note?, collections?, active?}` | Reactivate re-enrolls; deactivate un-enrolls |
| `removeWatchedDid` | `{did}` | Un-watch + un-enroll |
| `addBlockedDid` | `{did, note?, purge?, force?}` | **Deny-list a repo** — its events arrive from Tab but are never archived (in-memory skip, effective immediately). `purge` soft-deletes its existing records; `purge+force` hard-deletes them (cascades). Returns `{blocked, purged, mode}`. Complements query-time `nin` (per-consumer mute) with a global archive-side block |
| `removeBlockedDid` | `{did}` | Un-block (does not restore purged records) |
| `addBlockedPds` | `{pattern, note?}` | **Deny-list a PDS** by wildcard pattern (`https://*.pds.host`). Events carry only the DID, so each DID's PDS is resolved (via its DID doc, cached in `did_pds` on a TTL) and matched; matches are never archived. Future-block only; resolution failure → archived. Effective immediately |
| `removeBlockedPds` | `{pattern}` | Remove a PDS pattern |
| `addColdDid` | `{did, note?}` | **Cold-storage a repo** (LAB-68) — still ingested, indexed, and keyword-searchable, but never embedded (no CPU/$ spent on vectors). Retroactive: existing records are flagged `cold` + `embed_status='skipped'` and their embeddings purged to reclaim vector storage. Returns `{cold, cooled, embeddingsPurged}` |
| `removeColdDid` | `{did}` | Un-cool — clears the flag and re-queues the repo's records for embedding. Returns `{warmed, requeued}` |
| `addColdPds` | `{pattern, note?}` | **Cold-storage a PDS** by wildcard pattern (like `addBlockedPds`, resolved via `did_pds`). Forward-only: cools *new/changed* records from a matching PDS; already-archived records aren't retroactively swept |
| `removeColdPds` | `{pattern}` | Remove a cold PDS pattern |
| `getColdDids` / `getColdPdses` | — | List the cold DID / PDS entries |
| `backfillEvents` | `{collection?, did?, where?, includeDeleted?}` | Seed synthetic `create` (or `delete`) events for archived records that predate the event log, so a `cursor=start` consumer sees them. Idempotent (`NOT EXISTS` guard); `live:false` marks them historical. Returns `{seeded}` |
| `backfillRepo` | `{did, all?}` | **Re-index a repo** from its PDS (`getRepo`) — recover records the live sync missed (e.g. what a blocklist dropped). Runs in the background (returns `{did, status, scope}` immediately). Scoped to `collectionFilters` by default; `all:true` imports every collection. Idempotent, and cold-aware (a cold repo lands unembedded). One backfill per DID at a time |
| `getRepoBackfills` | — | `{running: [did…]}` — repos currently being re-indexed |

```bash
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getEvents?cursor=0&collection=site.standard.document"
curl -N -H "$A" "localhost:6060/xrpc/social.dept.obelisk.subscribeEvents?cursor=0&collection=site.standard.document"  # live SSE tail
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.backfillEvents" -d '{"collection": "site.standard.document"}'
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.backfillRepo" -d '{"did": "did:plc:…"}'          # re-index, configured collections only
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.backfillRepo" -d '{"did": "did:plc:…", "all": true}'  # whole repo
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getFootprint?did=did:plc:…&includeDeleted=1"
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getBackfillStatus?collection=site.standard.document"
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.aggregate?groupBy=collection"
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.aggregate?source=events&groupBy=createdAt:day&since=2026-01-01T00:00:00Z"
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.aggregate" -d '{"source": "links", "groupBy": "targetCollection", "where": {"did": {"eq": "did:plc:…"}}}'
curl -H "$A" "localhost:6060/xrpc/social.dept.obelisk.getRankedFeed?feed=following:did:plc:…&collection=site.standard.document&ranking=relevant-fresh"
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.addWatchedDid" -d '{"did": "did:plc:…"}'
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.addBlockedDid" -d '{"did": "did:plc:spammer", "purge": true}'
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.addBlockedPds" -d '{"pattern": "https://*.pds.host"}'
curl -X POST -H "$A" "localhost:6060/xrpc/social.dept.obelisk.addColdDid" -d '{"did": "did:plc:highvolume", "note": "archive only"}'
```

**Cold storage vs. blocking.** A *blocked* DID/PDS is dropped — its events never land. A *cold* DID/PDS is fully archived and keyword-searchable, it just skips embedding to save CPU/$. `searchRecords` **hides cold records by default** (pass `includeCold: true` to surface them); semantic search excludes them intrinsically (no embeddings). Browsing (`getRecords`) is unaffected — an explicit `did`/`uri` query still returns everything.

### Backfill progress

`getBackfillStatus` reads progress straight off the event log — no stored job state. Tab is the oracle: it marks historical records `live:false` and flips to `live:true` at the cutover, so a high `backfillRatePerSec` means history is still importing and a drained (zero) rate means the backfill is done (`complete: true`). You also get `recordsArchived`, `reposSeen`, `reposCaughtUp` (repos that reached the live stream), and `liveRatePerSec`.

There is **no `%`-of-network** — `reposTotal` is always `null`. No atproto service exposes a per-collection record or repo count (Constellation only counts *backlinks to* a target; `site.standard.document` is a link source, so it's uncountable there), and Tab's tracked-repo count isn't wired yet. `complete` is inferred from the historical stream draining, which is robust to quiet repos but also reads a stalled ingester (Tab down) as done — check `lastHistoricalEventAt` to disambiguate.

### DID-scoped backfill / re-index (on demand)

Re-index a DID's repo — recover records the live sync missed, e.g. what a blocklist dropped — by fetching `com.atproto.sync.getRepo` and replaying its records through the normal ingest path. Available as the `backfillRepo` XRPC procedure (runs in the background, one per DID) or the CLI:

```bash
bun run scripts/backfill-repo.ts did:plc:…          # configured collections only (default)
bun run scripts/backfill-repo.ts did:plc:… --all    # every collection in the repo
```

**Scoped by default.** Backfill goes straight to the PDS, so it bypasses Tab's `TAB_COLLECTION_FILTERS`; to avoid dragging in a repo's unrelated collections (all its `app.bsky.*` likes/follows/posts) it filters to `config.collectionFilters` (e.g. `site.standard.*`) — pass `--all` / `{all:true}` to import the whole repo. It also **bypasses the blocklist** (that's the point — it recovers a repo you'd previously blocked) but **honors the cold lists**, so re-importing a cold repo lands its records unembedded.

Every record is stamped with the repo's commit `rev`, so the import is **idempotent** (re-run = no-op) and a newer live event always wins over the snapshot — a forward delete is never resurrected. Records land `embed_status='pending'` (or `skipped` if cold); the running app's embed worker fills embeddings for the ones with prose.

**getRepo-less hosts.** Bridge PDSes (e.g. `atproto.brid.gy`) and relays don't implement `com.atproto.sync.getRepo` — they answer **501**. Backfill detects this and transparently falls back to paging **`com.atproto.repo.listRecords` per collection** (collections discovered via `describeRepo`, or the configured set if that's unavailable too). Records imported this way carry no commit `rev` (there's no CAR); idempotency then rests on the `(did, collection, rkey)` uniqueness + cid comparison. This is what makes reindexing bridged `site.standard.*` repos work.

**Whole-PDS reindex.** To recover every repo on a host (e.g. what a PDS blocklist dropped), enumerate the PDS's repos via `com.atproto.sync.listRepos` and reindex each — no relay needed:

```bash
bun run scripts/backfill-pds.ts https://pds.example.com                            # configured collections
bun run scripts/backfill-pds.ts https://pds.example.com --all                      # every collection
bun run scripts/backfill-pds.ts https://pds.example.com --cold                     # archive, never embed
bun run scripts/backfill-pds.ts https://pds.example.com --cold --note "a bridge"   # …with a note on each cold entry
bun run scripts/backfill-pds.ts https://pds.example.com --skip 635                 # resume after an interruption
```

**`--skip <n>`** resumes a sweep — `listRepos` is stably ordered, so it fast-skips the first n repos. The printed `[index]` counts skipped repos, so if a long run dies at `[635]`, re-run with `--skip 635` to pick up at `[636]`. For long sweeps, run it detached (`tmux`, or `docker compose exec -d`) so an SSH drop doesn't kill it.

Runs **sequentially** (one repo at a time — a 1GB box can't stream thousands of CARs at once), scoped + cold-aware like `backfill-repo`. One failing repo is logged and skipped; the sweep continues. Idempotent, so re-running after an interruption is safe (it re-scans but re-applies nothing already current).

**`--cold`** cools the host as it imports: records land unembedded, and every DID that actually contributed records is added to the cold list (with `--note`, if given) so it stays cold — DIDs with nothing we keep aren't cooled, so a bridge's thousands of empty repos don't clutter the list. This is the one-shot "archive this whole PDS, don't spend embeddings on it" path. If the DID is in `watched_dids`, `snapshot_at` is stamped on success (the "deleted coverage starts here" bound `getFootprint` reports). The CAR is **streamed** and parsed incrementally with `@atcute/repo`'s `fromStream` (Bun-native; `@atproto/repo` pulls a `@noble/hashes` export Bun can't resolve), so memory stays bounded regardless of repo size — a large DID won't OOM a small box (LAB-57). The commit `rev` comes from a cheap `com.atproto.sync.getLatestCommit` call, since the streamed reader consumes the commit block internally.

### Filtering by record content

Collection-plane queries filter against record JSON via the `where` DSL (dot paths like `content.$type`):

```bash
# all documents whose content block is Offprint's
curl -X POST -H "$A" "localhost:6060/xrpc/site.standard.document.getRecords" \
  -d '{"where": {"content.$type": {"eq": "app.offprint.content"}}}'
# semantic search within that slice
curl -X POST -H "$A" "localhost:6060/xrpc/site.standard.document.searchRecords" \
  -d '{"q": "ai filmmaking", "semantic": true, "where": {"content.$type": {"eq": "app.offprint.content"}}}'
```

Use `getTypes` to discover which `$type` values exist before filtering.

### Consuming changes (Laravel etc.)

**Pull:** `getEvents?cursor=<last-seen>&collection=…&include_record=1` returns applied changes in order with a resumable cursor — poll it from a scheduled job, persist the cursor, replay any time by rewinding it. The log only contains *applied* changes (redelivered/stale sync events never appear), so consumers see no duplicates.

**Push:** create a webhook subscription and Obelisk delivers the same events as batched, HMAC-signed POSTs — full batch immediately, partial batch at most once per `max_wait_ms`, so your endpoint is never flooded:

```bash
curl -X POST … "localhost:6060/xrpc/social.dept.obelisk.createWebhook" -d '{
  "name": "my-laravel-app",
  "url": "http://laravel.test/hooks/obelisk",
  "collections": ["site.standard.document"],
  "record_matchers": { "content.$type": "app.offprint.content" },
  "max_events": 200, "max_wait_ms": 5000,
  "from_cursor": "start"
}'   # → returns the signing secret ONCE — store it
```

Verify with `hash_equals('sha256='.hash_hmac('sha256', $body, $secret), $sigHeader)`. Delivery is at-least-once with per-subscription cursor: failures back off exponentially and never advance the cursor, `updateWebhook {"id": N, "cursor": M}` rewinds for replay, `testWebhook {"id": N}` sends a synthetic signed event.

### Audiences

An audience is a **query over the archive**, not a list you maintain — membership updates itself as the network changes (someone deleting their subscription record drops out automatically). Use `audience=<name>` on `getEvents` or in a webhook subscription to scope delivery to member DIDs.

```bash
# everyone subscribed to your publication — zero bookkeeping, ever
curl -X POST … "localhost:6060/xrpc/social.dept.obelisk.createAudience" -d '{
  "name": "my-subscribers",
  "definition": { "kind": "backlink", "target": "at://did:plc:…/site.standard.publication/self",
                  "collection": "site.standard.graph.subscription", "path": "publication" }
}'
```

Definition kinds: `backlink` (DIDs with records linking to a target), `outlink` (DIDs a user's records link to — e.g. everyone X follows), `collection` (DIDs with records in a collection, optionally matching `record.<path>` values), `static` (explicit DID list, escape hatch). Introspect via `getAudienceMembers?name=` and `checkAudienceMember?name=&did=`.

### Feeds

Link-based filters on `getEvents` (and webhook subscriptions via the `feed` field):

```bash
# personalized following feed: docs from every publication this user subscribes to
curl … "localhost:6060/xrpc/social.dept.obelisk.getEvents?feed=following:did:plc:xyz&collection=site.standard.document"

# records linking to an exact target at a path
curl … "localhost:6060/xrpc/social.dept.obelisk.getEvents?link.site=at://did:plc:…/site.standard.publication/self"
```

Following semantics (which collection/link path expresses "following") are configurable in `obelisk.config.ts` under `feeds.following` — not hardcoded to Standard.site.

### Dev mode

`OBELISK_DEV_MODE=true` disables API auth entirely (loud warning at boot). Local development only. Boot **refuses** it when the server binds a non-loopback interface unless `OBELISK_ALLOW_INSECURE=true`.

## Backups

The Postgres volume is Obelisk's only source of truth — an archive with no backup is a contradiction. Tab's sqlite state is regenerable (it re-syncs) and doesn't need backing up.

```bash
./scripts/backup.sh                       # timestamped pg_dump -Fc → ./backups, prunes to BACKUP_KEEP (14)
./scripts/restore.sh backups/<file>.dump  # stop app first: docker compose stop app
```

Schedule the backup from host cron (`0 3 * * * cd /srv/obelisk && ./scripts/backup.sh`), and copy `./backups` off-box. Restore recovers to the last dump; anything newer re-ingests from the network idempotently. See the [deployment runbook](.docs/deployment/vps.md) for the full procedure.

## Embedding backend

Embeddings come from a **pluggable provider** (`EMBEDDING_PROVIDER`), so the same archive runs on a beefy box or a $6 VPS:

- **`ollama`** (default) — local CPU inference (`nomic-embed-text`, 768-dim). Zero external deps, but on a 1-vCPU box it saturates the core, so the embed backlog drains slowly.
- **`openai`** — offloads embeddings to an OpenAI-compatible API (`text-embedding-3-small`, requested at 768-dim to match the column). The single vCPU goes idle, RAM frees up (~500 MB), and the backlog drains in parallel. Costs pennies for this corpus. Set `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL` for a compatible endpoint).

Both write the same `vector(768)` column, but their vectors aren't cross-compatible — **switching providers means re-embedding** for coherent semantic search:

```bash
# reset and let the worker rebuild embeddings with the new provider
docker compose exec postgres psql -U obelisk -d obelisk \
  -c "UPDATE records SET embed_status='pending' WHERE embed_status IN ('done','failed')"
```

Keyword (FTS) search is unaffected either way — only vector/semantic search depends on the provider.

## Production (VPS)

Obelisk runs as a **single self-hostable unit** behind Caddy for TLS. The whole stack — Postgres, Tab, Ollama, and the app — comes up with one command; Caddy issues a Let's Encrypt cert for `OBELISK_DOMAIN` and reverse-proxies to the app (bound to loopback, never directly exposed).

```bash
cp .env.example .env          # set POSTGRES_PASSWORD (openssl rand -hex 32) + OBELISK_DOMAIN
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec app bun run scripts/create-token.ts my-consumer   # token shown once
```

Hardened for internet exposure: bearer-token auth (dev-mode refuses to boot on a public bind), per-identity **rate limiting** + request-body caps + timeouts, `/healthz` + `/readyz` probes and authenticated `/metrics`, structured JSON logs, graceful degradation when Ollama/Constellation blip, and scripted `pg_dump`/restore. Full step-by-step (firewall, DNS, monitoring, upgrades, rollback, security notes) in the **[deployment runbook](.docs/deployment/vps.md)**.

## Status

✅ **Viable** (2026-07-02) — the full pipeline works end to end against the live network:

- Backfilled **14.5k+ records** across all four Standard.site collections in minutes, no webhook flood — Tab's ack-window websocket + in-process micro-batching (200 events/tx) gives backpressure by construction
- Restart mid-backfill: zero duplicate records (rev-compare idempotency absorbed 93 redelivered events in testing)
- Keyword + semantic search return sensible results (`q=atproto` → "Deconstructing atproto Blog Storage"); embeddings drain on CPU Ollama
- Internal link graph extracted at ingest (16k+ links); most-linked publication showed 200 archive backlinks; Constellation integration confirmed cached + serve-stale

**Caveats / follow-ups:** `@atproto/tap`'s TapChannel doesn't run under Bun (uses `ws` streams) — replaced with a ~200-line native WebSocket consumer, wire protocol is trivial. Rich-block document bodies (leaflet, pckt, logue, WordPress-HTML, markdown variants) are extracted via lexicon-derived text keys with a default-key fallback, stored in `records.extracted_text`, and included in FTS + embeddings — extraction happens in the embed worker, so search coverage for a record lags its ingestion by queue depth. Laravel package (LAB-17) and the $5/mo VPS stress test (LAB-9) are tracked in Linear, along with audience expansion (outlink/following feeds, combinators, thresholds).
