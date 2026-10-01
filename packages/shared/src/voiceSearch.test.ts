import { describe, expect, it } from 'vitest';
import {
  VOICE_SEARCH_ERROR_MESSAGES,
  VOICE_SEARCH_FALLBACK_MESSAGE,
  transcriptFromResults,
  voiceSearchAvailable,
  voiceSearchEndMessage,
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

describe('voiceSearchAvailable', () => {
  it('offers voice search where the browser has a recogniser', () => {
    expect(voiceSearchAvailable({ hasRecognizer: true, isBrave: false })).toBe(true);
  });

  it('hides it where there is no recogniser at all', () => {
    expect(voiceSearchAvailable({ hasRecognizer: false, isBrave: false })).toBe(false);
  });

  it('hides it in Brave even though the recogniser is there', () => {
    // Brave has the constructor and takes the microphone, then reports
    // `network` because the service behind the API has been removed. The
    // recogniser existing is exactly what makes this case easy to get wrong.
    expect(voiceSearchAvailable({ hasRecognizer: true, isBrave: true })).toBe(false);
  });
});

describe('voiceSearchEndMessage', () => {
  const quiet = { heard: false, stoppedByShopper: false };
  const heard = { heard: true, stoppedByShopper: false };
  const stopped = { heard: false, stoppedByShopper: true };

  it('says it missed them when the recogniser ends having heard nothing', () => {
    // Chrome: speechstart, speechend, end — no result and no error. This used
    // to show nothing at all.
    expect(voiceSearchEndMessage({ via: 'end' }, quiet)).toBe("Didn't catch that — try again.");
  });

  it('says nothing when it ends with something heard — that is the success path', () => {
    expect(voiceSearchEndMessage({ via: 'end' }, heard)).toBe('');
  });

  it('says nothing when the watchdog fires with a transcript in hand', () => {
    // The transcript is searched; telling them it "stopped responding" on top
    // of their results would be wrong.
    expect(voiceSearchEndMessage({ via: 'timeout' }, heard)).toBe('');
  });

  it('still reports a recogniser that went quiet having heard nothing', () => {
    expect(voiceSearchEndMessage({ via: 'timeout' }, quiet)).toMatch(/stopped responding/i);
  });

  it('stays silent whenever the shopper pressed stop', () => {
    expect(voiceSearchEndMessage({ via: 'end' }, stopped)).toBe('');
    expect(voiceSearchEndMessage({ via: 'timeout' }, stopped)).toBe('');
    expect(voiceSearchEndMessage({ via: 'error', code: 'no-speech' }, stopped)).toBe('');
  });

  it('leaves error codes saying what they said before', () => {
    // `network` is right in Chrome and Edge, where the service exists.
    expect(voiceSearchEndMessage({ via: 'error', code: 'network' }, quiet)).toBe(
      voiceSearchErrorMessage('network'),
    );
    expect(voiceSearchEndMessage({ via: 'error', code: 'aborted' }, quiet)).toBe('');
    expect(voiceSearchEndMessage({ via: 'error', code: undefined }, quiet)).toBe(
      VOICE_SEARCH_FALLBACK_MESSAGE,
    );
  });
});

describe('transcriptFromResults', () => {
  /** Segments as the recogniser delivers them: each holds its alternatives. */
  const results = (...segments: string[][]) =>
    segments.map((alts) => alts.map((transcript) => ({ transcript })));

  it('joins the segments Chrome splits an unfinished phrase into', () => {
    // Recorded from Chrome 154: the settled start, then the rest with its own
    // leading space. Reading only the first segment searched "Best mobile under".
    expect(transcriptFromResults(results(['Best mobile under'], [' 23000']))).toBe('Best mobile under 23000');
    expect(transcriptFromResults(results(['Samsung phone under'], [' 15000']))).toBe('Samsung phone under 15000');
  });

  it('returns a final result, a single segment, as it is', () => {
    expect(transcriptFromResults(results(['best phone under 25k']))).toBe('best phone under 25k');
  });

  it('uses only the top alternative of each segment', () => {
    expect(transcriptFromResults(results(['Best mobile under', 'Best moment under'], [' 23000', ' 2300']))).toBe(
      'Best mobile under 23000',
    );
  });

  it('collapses spacing and trims', () => {
    expect(transcriptFromResults(results(['  boat '], ['  earbuds  ']))).toBe('boat earbuds');
  });

  it('is empty when nothing has been heard', () => {
    expect(transcriptFromResults([])).toBe('');
    expect(transcriptFromResults(results([''], ['   ']))).toBe('');
    expect(transcriptFromResults([[]])).toBe('');
  });
});
