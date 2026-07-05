export type FetchFn = typeof fetch

export interface EnrollResult {
  /** false when no footprint Tab is configured, or the call failed (best-effort). */
  enrolled: boolean
  error?: string
}

/**
 * Manages the DID set of a footprint Tab instance running in dynamic
 * (`/repos/add`) mode. Adding a DID makes Tab fetch the full repo via
 * com.atproto.sync.getRepo (backfill, live:false) and then forward-capture new
 * commits (live:true) — both flow through the existing ingest path (LAB-28/29).
 *
 * Enrollment is BEST-EFFORT: the `watched_dids` table is the source of truth,
 * and LAB-29's boot reconcile re-syncs Tab from it. A failed or unconfigured
 * enrollment must never block recording a DID as watched.
 *
 * No-op when `baseUrl` is unset — the footprint Tab isn't running yet (this
 * repo ships the archive Tab; the footprint service lands with LAB-29).
 */
export class TabAdmin {
  private warnedUnconfigured = false

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl)
  }

  addRepos(dids: string[]): Promise<EnrollResult> {
    return this.post('/repos/add', dids)
  }

  removeRepos(dids: string[]): Promise<EnrollResult> {
    return this.post('/repos/remove', dids)
  }

  private async post(path: string, dids: string[]): Promise<EnrollResult> {
    if (dids.length === 0) return { enrolled: false }
    if (!this.baseUrl) {
      if (!this.warnedUnconfigured) {
        console.warn(
          `tab-admin: TAB_FOOTPRINT_ADMIN_URL unset — watched DIDs recorded but not enrolled in Tab (LAB-29 reconcile will enroll)`,
        )
        this.warnedUnconfigured = true
      }
      return { enrolled: false }
    }

    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dids }),
      })
      if (!res.ok) return { enrolled: false, error: `tab ${path} → HTTP ${res.status}` }
      return { enrolled: true }
    } catch (err) {
      return { enrolled: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
