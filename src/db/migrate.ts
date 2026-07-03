import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(import.meta.dir, '../../drizzle')

export async function migrate(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })

  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied = new Set((await sql`SELECT name FROM _migrations`).map((r) => r.name as string))

  for (const file of files) {
    if (applied.has(file)) continue

    const statements = await Bun.file(join(MIGRATIONS_DIR, file)).text()
    await sql.begin(async (tx) => {
      await tx.unsafe(statements)
      await tx`INSERT INTO _migrations (name) VALUES (${file})`
    })
    console.log(`applied ${file}`)
  }

  await sql.end()
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  await migrate(databaseUrl)
  console.log('migrations up to date')
}
