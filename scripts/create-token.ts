import { loadEnv } from '../src/config'
import { hashToken } from '../src/api/auth'
import { createDb } from '../src/db/client'
import { apiTokens } from '../src/db/schema'

const name = process.argv[2]
if (!name) {
  console.error('usage: bun run scripts/create-token.ts <name>')
  process.exit(1)
}

const env = loadEnv()
const { db, client } = createDb(env.databaseUrl)

const token = `rsv_${Bun.randomUUIDv7('hex')}${crypto.randomUUID().replaceAll('-', '')}`
await db.insert(apiTokens).values({ name, tokenHash: hashToken(token) })
await client.end()

// Only the token goes to stdout so it can be captured: TOKEN=$(bun run scripts/create-token.ts cli)
console.error(`created token "${name}" — shown once, store it safely:`)
console.log(token)
