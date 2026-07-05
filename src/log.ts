/**
 * Minimal structured logger (LAB-54): one JSON object per line to stdout
 * (warn/error to stderr), so a VPS deployment's `docker compose logs` is
 * machine-parseable. Dependency-free — fits the single-unit boundary. Level is
 * set by OBELISK_LOG_LEVEL (debug|info|warn|error), default info.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const raw = process.env.OBELISK_LOG_LEVEL as LogLevel | undefined
  return RANK[raw && raw in RANK ? raw : 'info']
}

type Fields = Record<string, unknown>

/** Flatten an Error into serializable fields; pass anything else through. */
function normalize(fields?: Fields): Fields {
  if (!fields) return {}
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v
  }
  return out
}

function emit(level: LogLevel, component: string, msg: string, fields?: Fields): void {
  if (RANK[level] < threshold()) return
  const line = JSON.stringify({ time: new Date().toISOString(), level, component, msg, ...normalize(fields) })
  if (level === 'warn' || level === 'error') console.error(line)
  else console.log(line)
}

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
}

/** A logger bound to a component name (e.g. `logger('ingester')`). */
export function logger(component: string): Logger {
  return {
    debug: (msg, fields) => emit('debug', component, msg, fields),
    info: (msg, fields) => emit('info', component, msg, fields),
    warn: (msg, fields) => emit('warn', component, msg, fields),
    error: (msg, fields) => emit('error', component, msg, fields),
  }
}
