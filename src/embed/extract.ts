import type { ReservoirConfig } from '../config'

/** Join a record's configured text fields into one embeddable document. */
export function extractText(
  config: ReservoirConfig,
  collection: string,
  record: Record<string, unknown>,
): string {
  const fields = config.collections[collection]?.textFields ?? []

  return fields
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n\n')
    .trim()
}
