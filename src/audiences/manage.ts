import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { audiences, type AudienceDefinition, type AudienceRow } from '../db/schema'
import { findAudience, isMember, listMembers, validateDefinition } from './definition'
import { conflict, invalid, notFound, type ManageResult } from '../webhooks/manage'

export async function listAudiences(db: Db): Promise<AudienceRow[]> {
  return db.select().from(audiences)
}

export async function getAudience(db: Db, name: string | undefined): Promise<ManageResult<object>> {
  if (!name) return invalid('name is required')
  const audience = await findAudience(db, name)
  if (!audience) return notFound('audience not found')
  return { data: { audience } }
}

export async function createAudience(
  db: Db,
  input: { name?: string; definition?: AudienceDefinition },
): Promise<ManageResult<object>> {
  if (!input.name || !input.definition) return invalid('name and definition are required')

  const problem = validateDefinition(input.definition)
  if (problem) return invalid(problem)

  const inserted = await db
    .insert(audiences)
    .values({ name: input.name, definition: input.definition })
    .returning()
    .catch(() => null)
  if (!inserted) return conflict('name already exists')

  return { data: { audience: inserted[0]! } }
}

export async function updateAudience(
  db: Db,
  input: { name?: string; definition?: AudienceDefinition },
): Promise<ManageResult<object>> {
  if (!input.name) return invalid('name is required')
  const audience = await findAudience(db, input.name)
  if (!audience) return notFound('audience not found')

  if (!input.definition) return invalid('definition is required')
  const problem = validateDefinition(input.definition)
  if (problem) return invalid(problem)

  const updated = await db
    .update(audiences)
    .set({ definition: input.definition })
    .where(eq(audiences.id, audience.id))
    .returning()
  return { data: { audience: updated[0]! } }
}

export async function deleteAudience(db: Db, name: string | undefined): Promise<ManageResult<{ deleted: true }>> {
  if (!name) return invalid('name is required')
  const audience = await findAudience(db, name)
  if (!audience) return notFound('audience not found')

  await db.delete(audiences).where(eq(audiences.id, audience.id))
  return { data: { deleted: true } }
}

export async function audienceMembers(
  db: Db,
  name: string | undefined,
  opts: { limit?: number; offset?: number } = {},
): Promise<ManageResult<{ name: string; members: string[]; limit: number; offset: number }>> {
  if (!name) return invalid('name is required')
  const audience = await findAudience(db, name)
  if (!audience) return notFound('audience not found')

  const limit = Math.min(opts.limit ?? 100, 1000)
  const offset = Math.max(opts.offset ?? 0, 0)
  const members = await listMembers(db, audience.definition, limit, offset)
  return { data: { name: audience.name, members, limit, offset } }
}

export async function checkMember(
  db: Db,
  name: string | undefined,
  did: string | undefined,
): Promise<ManageResult<{ name: string; did: string; member: boolean }>> {
  if (!name || !did) return invalid('name and did are required')
  const audience = await findAudience(db, name)
  if (!audience) return notFound('audience not found')

  const member = await isMember(db, audience.definition, did)
  return { data: { name: audience.name, did, member } }
}

