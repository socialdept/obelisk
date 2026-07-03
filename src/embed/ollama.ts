export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  /** Embed one or more inputs in a single request. Returns one vector per input. */
  async embed(inputs: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: inputs }),
    })

    if (!response.ok) {
      throw new Error(`ollama embed failed: ${response.status} ${await response.text()}`)
    }

    const body = (await response.json()) as { embeddings: number[][] }
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length) {
      throw new Error(`ollama returned ${body.embeddings?.length ?? 0} embeddings for ${inputs.length} inputs`)
    }

    return body.embeddings
  }
}
