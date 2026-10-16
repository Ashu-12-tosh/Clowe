import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AiCompleteInput, AiResult } from './AIProvider';

/**
 * Real AI via the Claude API (official SDK). Activated automatically when
 * ANTHROPIC_API_KEY is set (AI_PROVIDER=auto).
 */
export class AnthropicAIProvider implements AIProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(input: AiCompleteInput): Promise<AiResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!text) throw new Error(`AI returned no text (stop_reason: ${response.stop_reason})`);
    return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
}
