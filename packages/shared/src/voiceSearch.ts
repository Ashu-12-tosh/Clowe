// ---------------------------------------------------------------------------
// Voice search — what to tell someone when the browser's recogniser gives up.
//
// The Web Speech API reports why it failed, and the difference matters. Telling
// a shopper "voice search isn't available in this browser" because a packet was
// dropped teaches them to stop trying something that works; telling them to
// "try again" when their browser has removed the feature entirely teaches them
// nothing at all. So each code says something that is true of that code only.
//
// Brave is the case this was written for. It ships the API surface, because it
// is Chromium, but removes the recognition service behind it — so the button
// appears, the microphone permission is asked for, and then nothing arrives.
// ---------------------------------------------------------------------------

/**
 * Message per SpeechRecognitionErrorEvent.error, or null to stay quiet.
 *
 * Adding a code is one line here. Nothing else reads the raw code, so a browser
 * that turns out to report something unexpected — which is the open question
 * with Brave — is a single entry away from saying the right thing.
 */
export const VOICE_SEARCH_ERROR_MESSAGES: Record<string, string | null> = {
  /** The browser has the API but no recognition service behind it (Brave). */
  'service-not-allowed': "Voice search isn't available in this browser. Type your search instead.",
  /** Permission refused, or previously refused and remembered. */
  'not-allowed': 'Microphone access was blocked. Allow it in your browser settings to use voice search.',
  /** No input device at all. */
  'audio-capture': 'No microphone found. Plug one in, or type your search instead.',
  /** Recognition is a network service; this one is worth retrying. */
  network: "Couldn't reach the speech service. Check your connection and try again.",
  /** Heard nothing. Emphatically not a reason to say the browser is unsupported. */
  'no-speech': "Didn't catch that — try again.",
  /** The shopper or the page stopped it. They know; saying so would be noise. */
  aborted: null,
  'bad-grammar': 'Voice search had trouble with that. Type your search instead.',
  /**
   * Not a code the browser reports — ours, for when it reports nothing at all.
   * A recogniser can accept start(), take the microphone permission, and then
   * never call back: no result, no error, no end. Observed in headless Chrome,
   * and the likeliest shape of "it asks for the mic and then nothing happens".
   */
  timeout: 'Voice search stopped responding. Type your search instead.',
  'language-not-supported': 'Voice search does not support this language yet. Type your search instead.',
};

/** Said when the recogniser reports a code we have no specific line for. */
export const VOICE_SEARCH_FALLBACK_MESSAGE =
  "Voice search didn't work. Type your search instead.";

/**
 * What to show for a recogniser error; '' when the answer is to stay silent.
 *
 * An unknown code gets the general message rather than nothing, because the one
 * failure this replaces is the one where the shopper was told nothing at all.
 */
export function voiceSearchErrorMessage(code: string | undefined): string {
  if (!code) return VOICE_SEARCH_FALLBACK_MESSAGE;
  if (code in VOICE_SEARCH_ERROR_MESSAGES) {
    return VOICE_SEARCH_ERROR_MESSAGES[code] ?? '';
  }
  return VOICE_SEARCH_FALLBACK_MESSAGE;
}

/**
 * Whether to offer voice search at all.
 *
 * Brave is why this is not simply `hasRecognizer`. It ships the Web Speech API
 * surface — the constructor exists, start() is accepted, the microphone is
 * taken — and removes the recognition service behind it, reporting `network`
 * about half a second later (measured: Brave 1.96 on Chromium 154, raw API and
 * live site alike). A button that can never work is hidden, exactly as it is
 * where the API is absent.
 */
export function voiceSearchAvailable(env: { hasRecognizer: boolean; isBrave: boolean }): boolean {
  return env.hasRecognizer && !env.isBrave;
}

/** How a voice search attempt came to an end. */
export type VoiceSearchEnding =
  /** The recogniser reported a failure, with or without a code. */
  | { via: 'error'; code: string | undefined }
  /** The recogniser ended on its own, with no error. */
  | { via: 'end' }
  /** Our watchdog gave up on a recogniser that went quiet. */
  | { via: 'timeout' };

/**
 * What to tell the shopper when a voice search attempt ends; '' to say nothing.
 *
 * Two endings used to get this wrong, both measured in Chrome 154:
 *
 * - The recogniser can hear speech, fail to transcribe it, and end with no
 *   result and no error — speechstart, speechend, end. That is a legal
 *   sequence, and the shopper was told nothing at all. Having heard nothing,
 *   it now says so the same way `no-speech` does.
 * - Our watchdog can fire after interim results arrived. The transcript is
 *   searched either way, so "stopped responding" on top of a results page
 *   is wrong: from the shopper's side it worked.
 *
 * A shopper who pressed stop gets silence, whatever the recogniser did next.
 * They know they stopped it.
 */
export function voiceSearchEndMessage(
  ending: VoiceSearchEnding,
  ctx: { heard: boolean; stoppedByShopper: boolean },
): string {
  if (ctx.stoppedByShopper) return '';
  switch (ending.via) {
    case 'error':
      return voiceSearchErrorMessage(ending.code);
    case 'end':
      return ctx.heard ? '' : voiceSearchErrorMessage('no-speech');
    case 'timeout':
      return ctx.heard ? '' : voiceSearchErrorMessage('timeout');
  }
}
