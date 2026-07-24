import { env } from '../../env';
import type { AIProvider } from './AIProvider';
import { MockAIProvider } from './MockAIProvider';
import { AnthropicAIProvider } from './AnthropicAIProvider';

/**
 * Provider selection (same pattern as try-on):
 * - AI_PROVIDER=mock      → always mock
 * - AI_PROVIDER=anthropic → Claude (requires ANTHROPIC_API_KEY)
 * - AI_PROVIDER=auto      → Claude when ANTHROPIC_API_KEY is set, else mock.
 *   Adding the key later switches every AI feature to real AI, zero code changes.
 */
function createAIProvider(): AIProvider {
  const wantReal =
    env.AI_PROVIDER === 'anthropic' || (env.AI_PROVIDER === 'auto' && !!env.ANTHROPIC_API_KEY);
  if (wantReal) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
    }
    return new AnthropicAIProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL);
  }
  return new MockAIProvider();
}

export const aiProvider = createAIProvider();
export type { AIProvider, AiTask } from './AIProvider';
