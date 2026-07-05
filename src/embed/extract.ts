/** Join the named record fields' string values into one document. */
export function extractFields(record: Record<string, unknown>, fields: string[]): string {
  return fields
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n\n')
    .trim()
}
