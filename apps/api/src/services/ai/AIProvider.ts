export type AiTask =
  | 'product-description'
  | 'review-summary'
  | 'search-intent'
  | 'support-chat'
  | 'seller-assistant'
  | 'marketing'
  | 'ai-search'
  | 'compare-summary'
  | 'recommendations';

export interface AiCompleteInput {
  /** Which feature is calling — lets the mock provider answer sensibly. */
  task: AiTask;
  system: string;
  user: string;
  maxTokens: number;
  /** Ask for a JSON reply (providers that support it enforce it). */
  json?: boolean;
}

export interface AiResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Single abstraction behind every AI feature (descriptions, review summaries,
 * search, support chat, compare, recommendations, marketing).
 * Implementations: MockAIProvider (dev, free), GeminiAIProvider,
 * AnthropicAIProvider. Callers go through the metered wrapper (./index),
 * which adds the budget, the per-user limits and the usage log.
 */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  complete(input: AiCompleteInput): Promise<AiResult>;
}
