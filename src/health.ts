import { sql } from 'drizzle-orm'
import type { Db } from './db/client'

/**
 * Readiness + metrics (LAB-54). `up` = healthy, `degraded` = serving but a
 * non-critical dependency is impaired (e.g. Ollama down → semantic search
 * unavailable, archive fine), `down` = a critical dependency (the DB) is out.
 */
export type Health = 'up' | 'degraded' | 'down'

export interface ComponentStatus {
  status: Health
  [key: string]: unknown
}

/** Live component snapshots, supplied by the boot process (workers, Ollama). */
export interface HealthProviders {
  ingester?: () => ComponentStatus
  embedWorker?: () => ComponentStatus
  webhookWorker?: () => ComponentStatus
  ollama?: () => ComponentStatus | Promise<ComponentStatus>
}

export interface ReadyReport {
  /** false only when a critical dependency is down (→ 503). Degraded stays ok. */
  ok: boolean
  degraded: boolean
  components: Record<string, ComponentStatus>
}

export async function readyReport(db: Db, providers: HealthProviders = {}): Promise<ReadyReport> {
  const components: Record<string, ComponentStatus> = {}

  // The DB is the one hard dependency — if it's down, we're not ready.
  try {
    await db.execute(sql`SELECT 1`)
    components.db = { status: 'up' }
  } catch (err) {
    components.db = { status: 'down', error: err instanceof Error ? err.message : String(err) }
  }

  // Embed queue depth is a useful gauge and cheap; skip silently if the DB is out.
  if (components.db?.status === 'up') {
    try {
      const rows = await db.execute<{ pending: string; failed: string }>(sql`
        SELECT count(*) FILTER (WHERE embed_status = 'pending') AS pending,
               count(*) FILTER (WHERE embed_status = 'failed') AS failed
        FROM records
      `)
      components.embedQueue = {
        status: 'up',
        pending: Number(rows[0]?.pending ?? 0),
        failed: Number(rows[0]?.failed ?? 0),
      }
    } catch {
      // non-fatal — the gauge is best-effort
    }
  }

  if (providers.ingester) components.ingester = providers.ingester()
  if (providers.embedWorker) components.embedWorker = providers.embedWorker()
  if (providers.webhookWorker) components.webhookWorker = providers.webhookWorker()
  if (providers.ollama) components.ollama = await providers.ollama()

  const statuses = Object.values(components).map((c) => c.status)
  return {
    ok: !statuses.includes('down'),
    degraded: statuses.includes('degraded'),
    components,
  }
}

/** Prometheus text-format exposition derived from a readiness report. */
export function metricsText(report: ReadyReport): string {
  const lines: string[] = []
  const gauge = (name: string, value: number, help: string) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`)
  }
  const bit = (b: boolean) => (b ? 1 : 0)

  gauge('obelisk_ready', bit(report.ok), 'Whether the service is ready (no critical dependency down)')
  gauge('obelisk_degraded', bit(report.degraded), 'Whether a non-critical dependency is impaired')

  const c = report.components
  gauge('obelisk_db_up', bit(c.db?.status === 'up'), 'Database reachable')

  if (c.embedQueue) {
    gauge('obelisk_embed_pending', Number(c.embedQueue.pending ?? 0), 'Records awaiting embedding')
    gauge('obelisk_embed_failed', Number(c.embedQueue.failed ?? 0), 'Records that exhausted embed attempts')
  }
  if (c.ingester) {
    gauge('obelisk_ingester_connected', bit(Boolean(c.ingester.connected)), 'Ingester websocket connected to Tab')
    gauge('obelisk_ingester_applied', Number(c.ingester.applied ?? 0), 'Records applied by the ingester')
    gauge('obelisk_ingester_skipped', Number(c.ingester.skipped ?? 0), 'Events skipped by the ingester')
    gauge('obelisk_ingester_pending', Number(c.ingester.pending ?? 0), 'Events buffered in the ingester')
  }
  if (c.ollama) gauge('obelisk_ollama_up', bit(c.ollama.status === 'up'), 'Ollama embedding backend reachable')

  return lines.join('\n') + '\n'
}
