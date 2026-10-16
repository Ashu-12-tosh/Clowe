import { env } from '../../env';
import type { AIProvider, AiCompleteInput } from './AIProvider';
import { MockAIProvider } from './MockAIProvider';
import { AnthropicAIProvider } from './AnthropicAIProvider';
import { GeminiAIProvider } from './GeminiAIProvider';

/**
 * Provider selection (same pattern as try-on):
 * - AI_PROVIDER=mock      → always mock
 * - AI_PROVIDER=gemini    → Gemini (requires GEMINI_API_KEY)
 * - AI_PROVIDER=anthropic → Claude (requires ANTHROPIC_API_KEY)
 * - AI_PROVIDER=auto      → Gemini when GEMINI_API_KEY is set, else Claude
 *   when ANTHROPIC_API_KEY is set, else mock. Adding a key switches every AI
 *   feature to real AI, zero code changes.
 */
function createAIProvider(): AIProvider {
  const p = env.AI_PROVIDER;
  if (p === 'gemini' || (p === 'auto' && env.GEMINI_API_KEY)) {
    if (!env.GEMINI_API_KEY) throw new Error('AI_PROVIDER=gemini requires GEMINI_API_KEY');
    return new GeminiAIProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  }
  if (p === 'anthropic' || (p === 'auto' && env.ANTHROPIC_API_KEY)) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
    return new AnthropicAIProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL);
  }
  return new MockAIProvider();
}

/** The provider itself: token counts with every answer (for the usage meter). */
export const rawAiProvider = createAIProvider();

/** What the features call: the answer's text. */
export const aiProvider = {
  name: rawAiProvider.name,
  model: rawAiProvider.model,
  async complete(input: AiCompleteInput): Promise<string> {
    return (await rawAiProvider.complete(input)).text;
  },
};
export type { AIProvider, AiTask, AiCompleteInput, AiResult } from './AIProvider';
