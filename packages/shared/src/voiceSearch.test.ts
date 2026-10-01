import { describe, expect, it } from 'vitest';
import {
  VOICE_SEARCH_ERROR_MESSAGES,
  VOICE_SEARCH_FALLBACK_MESSAGE,
  voiceSearchErrorMessage,
} from './voiceSearch';

/**
 * These pin the distinction the messages exist for. Voice search used to fail
 * silently — the microphone was granted, recognition died, and the handler
 * swallowed it — so anything is an improvement on nothing. The risk now is the
 * opposite one: a single message for every code, which would tell someone their
 * browser is unsupported because a packet dropped.
 */
describe('voiceSearchErrorMessage', () => {
  it('says the browser cannot do it only when that is actually true', () => {
    expect(voiceSearchErrorMessage('service-not-allowed')).toMatch(/isn't available in this browser/);
    // The transient ones must not claim that, or a shopper stops trying
    // something that works perfectly well a second later.
    for (const transient of ['no-speech', 'network']) {
      expect(voiceSearchErrorMessage(transient)).not.toMatch(/available in this browser/);
    }
  });

  it('tells someone the retryable cases are retryable', () => {
    expect(voiceSearchErrorMessage('no-speech')).toMatch(/try again/i);
    expect(voiceSearchErrorMessage('network')).toMatch(/try again/i);
  });

  it('points a blocked microphone at the setting that unblocks it', () => {
    expect(voiceSearchErrorMessage('not-allowed')).toMatch(/browser settings/i);
  });

  it('covers a recogniser that never calls back at all', () => {
    // The failure mode that started this: start() is accepted, the microphone
    // permission is granted, and then no result, no error and no end ever
    // arrive. Nothing the browser reports covers it, so we report it ourselves.
    expect(voiceSearchErrorMessage('timeout')).toMatch(/stopped responding/i);
    expect(voiceSearchErrorMessage('timeout')).toMatch(/type/i);
  });

  it('stays quiet when the shopper stopped it themselves', () => {
    expect(voiceSearchErrorMessage('aborted')).toBe('');
  });

  it('says something rather than nothing for a code it has never seen', () => {
    // The whole point: an unrecognised failure must not become silence again.
    expect(voiceSearchErrorMessage('some-future-code')).toBe(VOICE_SEARCH_FALLBACK_MESSAGE);
    expect(voiceSearchErrorMessage(undefined)).toBe(VOICE_SEARCH_FALLBACK_MESSAGE);
    expect(voiceSearchErrorMessage('')).toBe(VOICE_SEARCH_FALLBACK_MESSAGE);
  });

  it('offers typing as the way out wherever voice is not going to work', () => {
    for (const code of ['service-not-allowed', 'audio-capture', 'language-not-supported']) {
      expect(voiceSearchErrorMessage(code)).toMatch(/type/i);
    }
    expect(VOICE_SEARCH_FALLBACK_MESSAGE).toMatch(/type/i);
  });

  it('keeps every message either useful or deliberately empty', () => {
    for (const [code, message] of Object.entries(VOICE_SEARCH_ERROR_MESSAGES)) {
      if (message === null) continue;
      expect(message.length, `${code} should say something substantial`).toBeGreaterThan(20);
    }
  });
});
