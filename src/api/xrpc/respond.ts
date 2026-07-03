import type { Context } from 'hono'

export type XrpcContext = Context

/** atproto-style error body: { error, message }. Shared by both XRPC planes. */
export function xrpcError(
  c: XrpcContext,
  status: 400 | 404 | 500 | 501 | 502,
  error: string,
  message: string,
) {
  return c.json({ error, message }, status)
}
