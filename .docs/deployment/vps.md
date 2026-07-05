# Deploying Obelisk on a VPS

How to stand up Obelisk on a fresh Linux box as a production service —
internet-exposed over HTTPS, authenticated, observable, and recoverable. This is
the operator runbook for the LAB-49 production-hardening epic; someone with only
this page and box credentials should be able to follow it end to end.

Obelisk stays a **single self-hostable unit** (SCOPE.md hard boundary #3): one
Bun process + Postgres + Tab + Ollama, all in one `docker compose` stack, with
Caddy terminating TLS in front. No HA, no multi-instance — just one box, done
safely.

## 0. Prerequisites

- A small VPS. The sizing floor is what LAB-9 (stress test) validates; budget
  **~2 GB RAM** to start — Ollama's CPU embedding is the memory driver. Docker +
  Docker Compose v2 installed.
- A domain you control, with an **A record pointed at the box's IP** *before*
  first boot (Caddy needs it to solve the ACME challenge).

## 1. Firewall

Only Caddy is public. Everything else (app on `127.0.0.1:6060`, Postgres, Tab,
Ollama) is bound to loopback or the compose network and never exposed.

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP → Caddy (ACME challenge + HTTPS redirect)
ufw allow 443/tcp     # HTTPS → Caddy
ufw enable
```

## 2. Clone + configure

```bash
git clone <repo> /srv/obelisk && cd /srv/obelisk
cp .env.example .env
```

Edit `.env`:

- `POSTGRES_PASSWORD` — generate one: `openssl rand -hex 32`. **Required** by the
  production overlay; `up` fails fast without it.
- `OBELISK_DOMAIN` — the domain whose A record you pointed at the box.
- Review the rate-limit / body-cap / timeout knobs (sane defaults are applied if
  omitted). Leave `OBELISK_DEV_MODE` unset — it disables auth and the app refuses
  to boot with it on a non-loopback bind anyway.

## 3. First boot

```bash
# Base stack + TLS overlay. Caddy issues a Let's Encrypt cert for OBELISK_DOMAIN.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# One-time: pull the embedding model into the ollama volume.
docker compose exec ollama ollama pull nomic-embed-text
```

The app migrates the database on boot, then starts ingesting + embedding + serving.

Mint an API token:

```bash
docker compose exec app bun run scripts/create-token.ts my-consumer
# → prints the token ONCE. Store it; only its SHA-256 hash is kept.
```

Smoke-test over HTTPS:

```bash
curl https://$OBELISK_DOMAIN/healthz          # {"ok":true}
curl https://$OBELISK_DOMAIN/readyz           # component report; ok:true
curl -H "Authorization: Bearer $TOKEN" \
  -X POST https://$OBELISK_DOMAIN/xrpc/site.standard.document.getRecords -d '{"limit":1}'
```

## 4. Monitoring

- **Liveness** `GET /healthz` — 200 when the process is up (the compose
  healthcheck and any uptime monitor use this). Unauthenticated.
- **Readiness** `GET /readyz` — checks DB + ingester + embed worker + Ollama.
  Returns 200 while serving (**degraded** — e.g. Ollama down — still counts as
  ok, since only semantic search is affected), 503 only when a critical
  dependency (the DB) is out. Unauthenticated.
- **Metrics** `GET /metrics` — Prometheus text (records ingested, embed queue
  depth, ingester connected, etc.). **Authenticated** — scrape with a bearer
  token.
- **Logs** — structured JSON, one object per line: `docker compose logs -f app`.
  Set `OBELISK_LOG_LEVEL=debug` for more.

## 5. Backups

The Postgres volume is the only source of truth. Tab's sqlite re-syncs from the
network and needs no backup.

```bash
./scripts/backup.sh                       # pg_dump -Fc → ./backups, prunes to BACKUP_KEEP (14)
```

Schedule it from host cron and copy the dumps off-box:

```cron
0 3 * * *  cd /srv/obelisk && ./scripts/backup.sh >> /var/log/obelisk-backup.log 2>&1
```

Recovery:

```bash
docker compose stop app
./scripts/restore.sh backups/obelisk-<stamp>.dump   # --clean replace; prints row counts
docker compose start app                            # migrate-on-boot is a no-op
```

RPO is the last dump; anything newer re-ingests from the network idempotently
(rev-compare, so re-runs never duplicate). HNSW/GIN indexes rebuild during
restore — expect that to take a while on a large archive.

## 6. Upgrades

```bash
cd /srv/obelisk && git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build app
```

Migrations run on boot. Zero-downtime isn't a goal (single unit) — a brief
restart is fine.

**Rollback:** migrations are forward-only. To undo a bad release, check out the
previous tag and rebuild; if a *migration* must be undone, restore the most
recent pre-upgrade backup (§5).

## 7. Security notes

- **Auth** — bearer tokens, SHA-256-hashed at rest; the raw token is shown once
  at mint time. No timing leak (lookup is by hash).
- **Dev mode** — `OBELISK_DEV_MODE=true` disables auth entirely; the app
  **refuses to boot** with it on while bound to a non-loopback interface unless
  `OBELISK_ALLOW_INSECURE=true` is also set. Never enable it on this box.
- **Rate limiting + body caps + timeouts** — per-identity (token, else IP);
  defaults in `.env.example`. Caddy caps request bodies as defense-in-depth.
- **Webhook secrets** are stored plaintext in Postgres (required to compute the
  delivery HMAC). That's acceptable because the DB is never internet-exposed —
  only the app (loopback) and Caddy (public) are reachable. Keep it that way.
- **TLS** is Caddy (auto Let's Encrypt). Swapping it for nginx/Traefik only
  changes the proxy layer; the app is unaware.

## Component map

```
internet ──443──▶ Caddy ──▶ app:6060 ──▶ postgres:5432   (source of truth, backed up)
                (TLS)         │      └──▶ ollama:11434    (embeddings; down = degraded)
                             └──ws──▶ tab:2480            (network sync; sqlite regenerable)
```
