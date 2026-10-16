import type { AIProvider, AiCompleteInput, AiResult } from './AIProvider';

/**
 * Gemini through Google's Generative Language REST API (generateContent).
 * The key travels in the x-goog-api-key header, never in the URL, so it can
 * never end up in a log line.
 */
export class GeminiAIProvider implements AIProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs = 20_000,
  ) {}

  async complete(input: AiCompleteInput): Promise<AiResult> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: input.user }] }],
        generationConfig: {
          maxOutputTokens: input.maxTokens,
          temperature: 0.3,
          ...(input.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as GeminiResponse | null;
    if (!res.ok || !body) {
      throw new Error(`Gemini ${res.status}: ${body?.error?.message?.slice(0, 200) ?? 'no body'}`);
    }
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    const usage = body.usageMetadata ?? {};
    const result: AiResult = {
      text,
      inputTokens: usage.promptTokenCount ?? 0,
      // Thinking tokens are billed as output.
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    };
    if (!text) throw Object.assign(new Error(`Gemini returned no text (${body.candidates?.[0]?.finishReason ?? 'no candidate'})`), { usage: result });
    return result;
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}
