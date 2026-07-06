# Design: record verification (`verified_at`)

A workflow that decides whether an archived record is **authentic** — and so
worth surfacing in search/ranking. Passing sets `verified_at` on the record;
failing leaves it unverified. For Standard.site this means proving the record's
own website links back to it, but the engine must stay **lexicon-agnostic**
(SCOPE hard rule: derived-first, config-fallback, else don't build).

Status: **planning**. Proof spec + several decisions locked (below); a handful of
operational decisions still open. Not yet a Linear issue.

---

## The core tension

"Is this record worth surfacing" is inherently *semantic* — a generic engine
can't know what makes a `site.standard.publication` legit. Resolution, per the
reservoir principle:

- **Derived (any lexicon):** schema validity — does the record validate against
  its published lexicon? Generic, works for any NSID via the registry.
- **Config (per lexicon):** the external proof. The *engine* is agnostic; the
  *rules* live in `obelisk.config.ts`. Standard.site is one config entry, not
  hardcoded logic. A different publishing lexicon adds its own entry (or a new
  driver if its proof mechanism differs).
- **Neither available → `n/a`:** a collection with no verifier configured is
  *not-applicable*, **not** "unverified" — critical so it doesn't vanish from
  search.

So the thing to build is a **verifier-driver framework** (same shape as the
`EmbeddingProvider` driver), where each collection declares an ordered list of
checks.

---

## Confirmed proof spec (Standard.site)

The three cases collapse to one rule: **a record is verified when its own web
page carries a `<link>` whose `rel` is the record's collection NSID and whose
`href` is the record's exact DID at-uri.** Only the *page URL discovery* varies.

For record `R` (collection `C`, at-uri `U`):

1. **Resolve the page URL**
   - `doc` with `site` = URL → page = `site + path`  *(a "loose document")*
   - `doc` with `site` = at-uri → fetch that record (**must** be a `pub` /
     `site.standard.publication`), read `pub.url` (must be a valid URL), page =
     `pub.url + path`
   - `pub` → page = `pub.url`
2. **Fetch the page's HTML**, scan `<link>` tags.
3. **Require** `<link rel="{C}" href="{U}">` — exact at-uri match. For a
   doc-via-pub, a `rel="site.standard.publication"` link **may** also be present
   (href = the pub's at-uri); it's optional, but if present it must be correct
   *(open Q5)*.
4. All required links present + exact → set `verified_at`.

### Locked details

- **`rel`** is the literal bare NSID — `rel="site.standard.document"`, no prefix.
- **`href`** must be the **DID** at-uri (`at://did:plc:…/…`) — no handle-based
  URIs (records store DIDs; exact match needs the DID form).
- **Self-contained:** each record proves itself via its *own* link tag. A doc is
  **not** verified by inheriting the pub's verified status — the pub hop only
  exists to discover the URL. **No transitive trust.**
- **Path merge:** best practice is `pub.url` with **no trailing slash** +
  `doc.path` with a **leading slash**; the joiner must still merge defensively
  when those conventions aren't followed, and `pub.url` may itself carry a
  subpath.
- **Pub resolution is a write path:** when `doc.site` is an at-uri and we don't
  already have that pub archived, fetch it, **archive it, and emit events**
  (unless it's blocked/cold) — i.e. go through the normal `applyEvent` so
  block/cold are respected and consumers see it. The freshly-archived pub then
  becomes its **own** verification candidate (a cascade). Prefer our archived
  copy when we have it.
- **Rendering needs a headless browser** — link tags can be client-rendered.
  (Optimization to confirm: raw-fetch-first, headless only as fallback — Q on
  headless below.)

---

## Data model

`verified_at` is the headline field, but a *workflow* needs a queue, so mirror
`embed_status`:

- `verified_at timestamptz null` — set on pass.
- `verification_status` — `pending | verified | failed | n/a`. Drives the worker
  queue **and** distinguishes "no verifier configured" (`n/a`) from "verifier ran
  and failed" (`failed`).
- `verification_method` — which check passed (e.g. `html-link`).
- `verification_detail` — why it failed (couldn't fetch, no tag, href mismatch,
  invalid url, pub not found …) — surfaced in the console.
- `verify_attempts` — for backoff / give-up.

---

## Architecture

**Verifier drivers** (pluggable, config-wired):

- `schema` — validates the record against its lexicon (the registry). Baseline,
  fully generic.
- `html-link` — the Standard.site one, but generic and parameterized: resolve a
  page URL from a config-named field (optionally one hop through a referenced
  record to read *its* url field), fetch it, require a `<link rel href>` matching
  the record's collection + at-uri. Standard.site's rules become *params*, not
  code.

**Config shape** (sketch, `obelisk.config.ts`):

```ts
verification: {
  verifyBeforeEmbed: false,            // global: gate embedding on verification? (configurable, dev's call)
  collections: {
    'site.standard.document': {
      checks: [
        { kind: 'schema' },
        { kind: 'html-link',
          urlFrom: { field: 'site', pathField: 'path',
                     // when `site` is an at-uri, resolve that record + read its url:
                     resolve: { expectCollection: 'site.standard.publication', urlField: 'url' } },
          require: { rel: 'site.standard.document', href: 'self' },
          optional: [{ rel: 'site.standard.publication', href: 'resolved' }],
        },
      ],
      ttlHours: 168,
    },
    'site.standard.publication': {
      checks: [
        { kind: 'schema' },
        { kind: 'html-link', urlFrom: { field: 'url' },
          require: { rel: 'site.standard.publication', href: 'self' } },
      ],
      ttlHours: 168,
    },
  },
}
```

**Verification worker** — mirrors the embed worker: claims `pending`, runs the
collection's checks, sets `verified`/`failed`. It fetches external URLs, so it
needs:

- **SSRF guards** — the one real security surface. Block internal/loopback/link-
  local IPs, non-http(s) schemes, and re-check on each redirect hop. `pub.url` and
  `doc.site` are arbitrary user-controlled URLs.
- **Rate limiting + per-page timeout + a per-domain cache** — don't render the
  same host repeatedly.
- **Headless rendering as a pluggable driver** (the embed-offload situation
  again — Chromium won't fit the $6/1GB box next to Postgres). Options: a separate
  worker/box, a self-hosted browserless container, or a managed render API.

**Verify-before-embed** is a **config flag** (`verifyBeforeEmbed`), developer's
call. On → pipeline becomes ingest → verify → (if verified) embed, so semantic
search is verified-by-construction and no embeddings are spent on records that'll
never surface. Off → the two are orthogonal axes, gated at query time.

---

## Reuses (Obelisk already has these)

- `LexiconRegistry` — schema validation for the `schema` driver.
- `record_links` + link extraction — resolving `site`/at-uri references.
- The **worker pattern** (embed worker) — claim/process/retry/backoff loop.
- DID→PDS resolution + the `did_pds` cache — fetching referenced pubs.
- `applyEvent` — the write path for archiving a fetched pub (respects block/cold,
  emits events).
- The **event log** — the fetched-pub cascade is just more events.
- `/metrics` + health components — verification counters, queue depth.
- The **console** — status columns/filters, a verification queue, manual
  override + re-verify triggers (Q6).

---

## Open decisions (to finish planning)

Leanings noted; none locked.

1. **Staleness** — re-verify on a TTL? And if a site later drops the link tag,
   does it **un-verify** (clear `verified_at`), or stay verified once earned?
   *Lean: TTL re-verify, and un-verify if the proof vanishes.*
2. **Search gating** — hard-filter unverified out of search/feeds, or down-rank
   via the ranking system? Default, and an `includeUnverified` escape hatch for
   the console. *Lean: hard-filter with an escape hatch.*
3. **Cold records** — skip verification for cold DIDs (don't burn a headless
   render on something we won't surface), like we skip embedding? *Lean: yes,
   skip.*
4. **Retry policy** — transient (timeout/5xx) backs off + retries; permanent (no
   tag / wrong href) marks `failed` and stops. Attempt cap? Does the TTL
   re-verify also re-attempt `failed`, or only `verified`?
5. **Secondary pub link on a doc page** — optional, but if present with the
   **wrong** href, fail the doc or ignore it? *Lean: if present, must be correct.*
6. **Headless architecture** — where does rendering run (separate box /
   browserless container / managed API)? And confirm **raw-fetch-first,
   headless-only-fallback** — if the `<link>` tags are usually in the server-
   rendered `<head>`, a plain fetch catches most sites and cuts headless usage
   ~90%. *Lean: pluggable renderer driver + raw-first.*
7. **Operator override** — console action to manually verify/reject a record
   (like the blocklist) + a re-verify trigger + a verification-queue view.
