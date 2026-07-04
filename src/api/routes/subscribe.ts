import { streamSSE } from 'hono/streaming'
import type { ObeliskConfig } from '../../config'
import type { Db } from '../../db/client'
import type { XrpcContext } from '../xrpc/respond'
import { queryEvents } from './events'

const DEFAULT_POLL_MS = 1000
const MIN_POLL_MS = 25
const MAX_POLL_MS = 60_000

/**
 * Live event tail (LAB-45): SSE over the same filter core as `getEvents`. Replay
 * from `cursor` (0 = full history), then tail forward — one `event:` frame per
 * change with `id:` = its cursor (so a reconnect resumes via `Last-Event-ID` or an
 * explicit `cursor`), `ping` keepalives when caught up.
 *
 * Backpressure by construction: `writeSSE` awaits the socket, so a slow consumer
 * slows the loop rather than buffering — the anti-flood invariant the project was
 * built around. The loop ends when the client aborts.
 */
export function subscribeEvents(c: XrpcContext, db: Db, config: ObeliskConfig) {
  // Force ascending (chronological tail); carry every other getEvents filter through.
  const query: Record<string, string | undefined> = { ...c.req.query(), order: 'asc' }
  const pollMs = clampPoll(query.poll)
  // Resume from an explicit cursor, else the SSE reconnect header.
  const startCursor = query.cursor ?? c.req.header('Last-Event-ID')

  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => {
      aborted = true
    })

    let cursor = startCursor
    while (!aborted) {
      const result = await queryEvents(db, config, { ...query, cursor })
      if ('error' in result) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: result.error }) })
        return
      }

      for (const event of result.events) {
        const id = (event as { cursor: string }).cursor
        await stream.writeSSE({ event: 'event', id, data: JSON.stringify(event) })
      }
      if (result.cursor) cursor = result.cursor

      // Caught up → keepalive + wait before polling again. Pages that returned
      // events loop straight back to drain the rest of the backlog first.
      if (result.events.length === 0) {
        await stream.writeSSE({ event: 'ping', data: '' })
        await stream.sleep(pollMs)
      }
    }
  })
}

function clampPoll(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_POLL_MS)
  if (!Number.isFinite(n)) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(n)))
}
