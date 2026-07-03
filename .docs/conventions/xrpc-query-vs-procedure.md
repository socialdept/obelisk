# XRPC convention: queries vs procedures

Obelisk has **no REST plane**. Every HTTP method is an XRPC verb under one of two
planes (see [SCOPE.md](../../SCOPE.md#api-planes)). When adding a method, decide
plane first, then kind.

## Plane

- **Collection plane** `/xrpc/{collection}.{verb}` — the method NSID *is* the
  archived collection being returned/counted/searched. Only for per-collection
  record reads.
- **Service plane** `/xrpc/social.dept.obelisk.{verb}` — anything that spans
  collections or is about the archive itself. Everything else.

## Kind (follows atproto's own `query`/`procedure` split)

| Kind | HTTP | Params | Use for |
|---|---|---|---|
| **query** | GET | query string | reads — never mutates |
| **procedure** | POST | JSON body | mutations against Obelisk's *own* Postgres |

Naming is atproto-style verbs: `getX` / `listX`-style for queries, `createX` /
`updateX` / `deleteX` / `addX` / `removeX` for procedures.

## Boundary rule (do not cross)

Procedures mutate **only Obelisk's own database** (subscriptions, audiences,
watched DIDs, cursors). They **never** write records to a PDS — that's hard
boundary #2. The collection plane's `createRecord`/`updateRecord`/`deleteRecord`
stay `MethodNotImplemented` forever.

## How to add one

1. Write the logic as a plain function returning `ManageResult<T>`
   (`{ data } | { error, message, status }`) — see `src/webhooks/manage.ts`,
   `src/audiences/manage.ts`, `src/api/routes/watched.ts`. Keep it framework-free
   so it's unit-testable and reusable.
2. Add a `case` in `src/api/xrpc/service.ts`:
   - query → read `c.req.query(...)`, call the fn, `respond(c, …)`.
   - procedure → `respondFromBody(c, (body) => fn(...))` (parses the POST JSON).
3. `respond()` maps `{ error, message, status }` to an atproto `{error, message}`
   body with the right HTTP status (`400` InvalidRequest, `404` NotFound, `409`
   AlreadyExists). Success responses are wrapped in a named key
   (`{ webhook }`, `{ audience }`, `{ watchedDid }`) or a list key
   (`{ webhooks: [...] }`).
4. Add a test hitting `/xrpc/social.dept.obelisk.{verb}` and update the README
   query/procedure tables.
