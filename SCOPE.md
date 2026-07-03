# Scope

What reservoir is, what it will become, and what it refuses to be. When a
feature idea shows up, it gets tested against this file before it gets an
issue.

## Mission

A **self-hostable, lexicon-generic, queryable archive** of AT Protocol
records. Applications (first consumer: Offprint) point it at collections,
then query and subscribe over an authenticated HTTP API. App-specific
behavior lives in **config and data** (collection lists, audiences, record
matchers, feed definitions) — never in reservoir code.

Reference point for the shape we're aiming at:
[slices](https://tangled.org/slices.network/slices) — "host your own
AppView" — minus the write path, plus search/vectors/webhooks/link-graph.

## Hard boundaries

1. **Lexicon-generic, always.** Behavior derives from published lexicon
   schemas; where derivation can't work, there's a config extension point a
   third party could fill; otherwise the feature doesn't ship. Standard.site
   is default config, not a code assumption. (See README "Design principle".)
2. **Read-only.** Reservoir archives and serves the network — it never
   writes records to PDSes. Write paths belong to the consuming app (e.g.
   Offprint via `socialdept/atp-client`). No OAuth-as-a-user, no CRUD.
3. **Single self-hostable unit.** One Bun process + Postgres + Tab. Features
   that require additional always-on infrastructure need an exceptional
   justification.

## In scope — shipped

- Sync (Tab, ack-batched, idempotent, soft deletes) and the permanent archive
- Query API: records, `record.<path>`/`link.<path>` filters, FTS, semantic
  search, internal links/backlinks, cached Constellation network backlinks
- Type inventory + lexicon registry (`/types`), lexicon-derived extraction
- Event log + cursor pull API, batched HMAC webhooks
- Audiences (backlink / outlink / collection / static) and following feeds
- Dev mode, bearer-token auth

## In scope — now (closes the stated consumer needs)

- **XRPC query surface** — atproto-shaped API:
  `/xrpc/{collection}.getRecords|getRecord|countRecords|searchRecords` where
  `{collection}` is the archived collection being queried (e.g.
  `/xrpc/site.standard.document.getRecords`), with a `where` filter DSL
  (`eq`/`contains`/`in`, record + system fields), `sortBy`, cursor
  pagination, and standard atproto error bodies. Read-only verbs only.
  Service-level endpoints (events/webhooks/audiences) keep `/api/v1` until a
  reservoir NSID namespace is chosen.
- **Time-range filters + ordering on `/events`** (`since`/`until`, desc) —
  "when did publications we maintain change their records"
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
  generation) — reservoir consumes lexicons, it doesn't author them

## How to use this file

New idea → which bucket? If "out of scope," it doesn't get an issue. If
"phase 2," it gets an issue but not a start date. If it fits "now," it must
name the consumer need it closes. Scope changes edit this file first, in the
same commit as the decision.
