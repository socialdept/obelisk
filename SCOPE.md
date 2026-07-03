# Scope

What Obelisk is, what it will become, and what it refuses to be. When a
feature idea shows up, it gets tested against this file before it gets an
issue.

## Mission

A **self-hostable, lexicon-generic, queryable archive** of AT Protocol
records. Applications (first consumer: Offprint) point it at collections,
then query and subscribe over an authenticated HTTP API. App-specific
behavior lives in **config and data** (collection lists, audiences, record
matchers, feed definitions) — never in Obelisk code.

Reference point for the shape we're aiming at:
[slices](https://tangled.org/slices.network/slices) — "host your own
AppView" — minus the write path, plus search/vectors/webhooks/link-graph.

## Hard boundaries

1. **Lexicon-generic, always.** Behavior derives from published lexicon
   schemas; where derivation can't work, there's a config extension point a
   third party could fill; otherwise the feature doesn't ship. Standard.site
   is default config, not a code assumption. (See README "Design principle".)
2. **Read-only.** Obelisk archives and serves the network — it never
   writes records to PDSes. Write paths belong to the consuming app (e.g.
   Offprint via `socialdept/atp-client`). No OAuth-as-a-user, no CRUD.
3. **Single self-hostable unit.** One Bun process + Postgres + Tab. Features
   that require additional always-on infrastructure need an exceptional
   justification.

## API planes

Two request planes, split by one invariant:

> In the **collection plane**, `{collection}` is always the collection of the
> records being *returned / counted / searched*.

1. **Collection plane** — `/xrpc/{collection}.{verb}`, where `{collection}` is
   the archived collection being queried (it borrows that lexicon's own NSID,
   owned by whoever authored it). Verbs: `getRecords`, `getRecord`,
   `countRecords`, `searchRecords`. All queries; write verbs return
   `MethodNotImplemented`.
2. **Service plane** — `/xrpc/social.dept.obelisk.{verb}` for Obelisk's own
   operations that span collections or concern the archive itself (authority =
   owned domain `dept.social`). Following atproto's own split, it has both
   **queries (GET)** — `getEvents`, `getTypes`, `getType`, `getLinks`,
   `getBacklinks`, `getNetworkBacklinks`, `getFootprint`, plus management
   list/get — and **procedures (POST)** — `createWebhook`/`updateWebhook`/…,
   `createAudience`/…, `addWatchedDid`/… Keyed by `uri`/params, not by a
   collection in the method name.

Anything that breaks the invariant (spans collections, or is about the archive)
lives in the service plane — never jammed into `{collection}.{verb}`.

**There is no REST plane.** The entire HTTP surface is XRPC. Management is
expressed as service-plane **procedures**, not CRUD routes. Procedures mutate
Obelisk's *own* Postgres only — this never writes to a PDS, so hard boundary #2
holds; the collection plane's write verbs stay `MethodNotImplemented`.

## In scope — shipped

- Sync (Tab, ack-batched, idempotent, soft deletes) and the permanent archive
- Query API: records, `record.<path>`/`link.<path>` filters, FTS, semantic
  search, internal links/backlinks, cached Constellation network backlinks
- Type inventory + lexicon registry (`getTypes`), lexicon-derived extraction
- Event log + cursor pull API (`getEvents`: `since`/`until` time bounds, `asc`/`desc`
  ordering — "when did publications we maintain change their records"), batched HMAC webhooks
- Audiences (backlink / outlink / collection / static) and following feeds
- Backfill progress (`getBackfillStatus`, LAB-34) — read off the event log via
  Tab's `live:false→true` cutover; drain-based `complete`. No `%`-of-network:
  no atproto service exposes a per-collection count (`reposTotal` stays null).
- DID-scoped backfill (`scripts/backfill-repo.ts`, LAB-28) — one-shot full-repo
  import via `com.atproto.sync.getRepo`, every collection, through the existing
  `applyEvent` path (`@atcute/repo` CAR reader, Bun-native). Idempotent via the
  commit `rev`; stamps `watched_dids.snapshot_at`. The footprint-audit primitive.
- Dev mode, bearer-token auth

## In scope — now (closes the stated consumer needs)

- **XRPC surface, REST retired** (LAB-33) — the whole HTTP API is atproto-shaped
  XRPC; `/api/v1` is gone. Collection plane
  `/xrpc/{collection}.getRecords|getRecord|countRecords|searchRecords` with a
  `where` filter DSL (`eq`/`contains`/`in`, record + system fields), `sortBy`,
  cursor pagination. Service plane `social.dept.obelisk.*` (authority = owned
  domain `dept.social`) carries archive queries **and** management procedures
  (webhooks/audiences/watched-dids as POST procedures — mutating Obelisk's own
  DB, never a PDS).
- **Generic aggregation/stats endpoints** — counts and group-bys over
  records/links/events with the same filter vocabulary (interaction counts,
  subscriber growth, activity over time). `countRecords` + `where` covers the
  record-counting slice of this.

## In scope — phase 2 (roadmap, sequenced after real usage)

- Audience combinators, `active`/threshold kinds, 2-hop graph audiences
  (LAB-21–24) — the recommendation/counting roadmap
- Event backfill endpoint (LAB-18), webhook 413 handling (LAB-19),
  GIN-indexed JSON filters (LAB-11)
- VPS stress test + minimum-viable-box verdict (LAB-9)

## Out of scope

- **Write operations of any kind** (see hard boundary 2)
- **App-specific endpoints or logic** — if a feature can't be expressed
  generically, the consuming app builds it on top of the query API
- **The Laravel consumer package** (LAB-17) — separate deliverable, its own
  repo, tracked in Labs
- **UI/admin frontend** — API-first; hosting a browsing UI is a different
  project
- **Identity/handle resolution as a product feature** — store DIDs; consumers
  resolve handles (revisit only if a consumer need makes it unavoidable)
- **Being an AppView SDK platform** (slices' lexicon-authoring + SDK
  generation) — Obelisk consumes lexicons, it doesn't author them

## How to use this file

New idea → which bucket? If "out of scope," it doesn't get an issue. If
"phase 2," it gets an issue but not a start date. If it fits "now," it must
name the consumer need it closes. Scope changes edit this file first, in the
same commit as the decision.
