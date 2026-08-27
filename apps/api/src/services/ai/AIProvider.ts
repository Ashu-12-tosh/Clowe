export type AiTask =
  | 'product-description'
  | 'review-summary'
  | 'search-intent'
  | 'support-chat'
  | 'seller-assistant';

export interface AiCompleteInput {
  /** Which feature is calling — lets the mock provider answer sensibly. */
  task: AiTask;
  system: string;
  user: string;
  maxTokens: number;
}

/**
 * Single abstraction behind every AI feature (descriptions, review summaries,
 * voice-search parsing, support chat).
 * Implementations: MockAIProvider (dev, free), AnthropicAIProvider (Claude).
 */
export interface AIProvider {
  readonly name: string;
  complete(input: AiCompleteInput): Promise<string>;
}
