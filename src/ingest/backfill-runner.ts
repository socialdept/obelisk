import type { ObeliskConfig } from '../config'
import type { Db } from '../db/client'
import { logger } from '../log'
import { invalid, type ManageResult } from '../webhooks/manage'
import { backfillRepo, collectionFilter, type BackfillDeps } from './backfill'
import type { ColdList, ColdPdsList } from './cold'

const log = logger('backfill-runner')

interface TriggerInput {
  did?: string
  /** Import every collection in the repo, not just the configured filter set. */
  all?: boolean
}

/**
 * Fire-and-forget repo re-index (LAB-68 follow-up). Wraps `backfillRepo` so an
 * operator can reindex a repo over XRPC without holding the request open for a
 * whole-repo stream. One backfill per DID at a time (an in-flight guard drops a
 * duplicate trigger); progress is observed via record counts / `getFootprint`.
 *
 * Scoped to the configured collections by default (so re-importing an unblocked
 * repo doesn't drag in its unrelated collections) and cold-aware (a cold repo's
 * re-imported records aren't embedded), reusing the shared in-memory cold lists.
 */
export class RepoBackfiller {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly db: Db,
    private readonly config: ObeliskConfig,
    private readonly coldList: ColdList,
    private readonly coldPdsList: ColdPdsList,
    /** Injectable for tests; defaults to the real network-backed backfill. */
    private readonly run: typeof backfillRepo = backfillRepo,
  ) {}

  running(): string[] {
    return [...this.inFlight]
  }

  /** Validate + kick off in the background. Returns immediately. */
  trigger(input: TriggerInput): ManageResult<object> {
    const did = input.did
    if (!did || !did.startsWith('did:')) return invalid('a valid did is required')
    if (this.inFlight.has(did)) return { data: { did, status: 'already-running' } }

    const scope = input.all ? 'all' : 'configured'
    this.inFlight.add(did)
    void this.execute(did, input.all ?? false)
    return { data: { did, status: 'started', scope } }
  }

  private async execute(did: string, all: boolean): Promise<void> {
    try {
      // Pre-resolve the DID's PDS so the cold-PDS check is synchronous, matching
      // the live ingester's decision exactly.
      await this.coldPdsList.ensureDecided([did])
      const deps: BackfillDeps = {
        applyOptions: { coldDid: (d) => this.coldList.has(d) || this.coldPdsList.isCold(d) },
        ...(all ? {} : { collections: collectionFilter(this.config) }),
      }
      const result = await this.run(this.db, this.config, did, deps)
      log.info(
        `reindexed ${did}: ${result.applied} applied, ${result.skipped} skipped, ${result.filtered} filtered (rev ${result.rev})`,
      )
    } catch (err) {
      log.error(`reindex ${did} failed: ${(err as Error).message}`)
    } finally {
      this.inFlight.delete(did)
    }
  }
}
