// ---------------------------------------------------------------------------
// The return window in copy.
//
// Help articles, FAQ answers and policy pages never spell out a number of
// days: they carry RETURN_WINDOW_TOKEN, and the page that shows them fills it
// from the platform setting. Changing the setting changes every page.
// ---------------------------------------------------------------------------

export const RETURN_WINDOW_TOKEN = '{{returnWindow}}';

/**
 * "5 days", "1 day". With no setting to hand (still loading, or unreadable)
 * a phrase that is never wrong, rather than a number that might be.
 */
export function returnWindowPhrase(days: number | null | undefined): string {
  if (days == null) return 'the return window shown on the product page';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Put the window into every token in `text`. */
export function fillReturnWindow(text: string, days: number | null | undefined): string {
  return text.split(RETURN_WINDOW_TOKEN).join(returnWindowPhrase(days));
}
