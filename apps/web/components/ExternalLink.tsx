import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { safeHref } from '@clowe/shared';

/**
 * A link whose address someone else supplied: a seller's social profile, a
 * return photo, a tracking page. The address is checked again here, with the
 * same allow-list the API validates against, so a value stored before that
 * check existed — or one that slipped past it — renders as plain content
 * instead of a link that could run script. Opens in a new tab, unlinked from
 * this one.
 *
 * Every <a> with a computed href goes through this component; lint enforces
 * it (apps/web/.eslintrc.json).
 */
export function ExternalLink({
  href,
  children,
  fallback,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string | null | undefined;
  children: ReactNode;
  /** What to render when the address is refused. Defaults to the children, unlinked. */
  fallback?: ReactNode;
}) {
  const safe = safeHref(href);
  if (!safe) return <>{fallback === undefined ? children : fallback}</>;
  return (
    // eslint-disable-next-line no-restricted-syntax -- the one sink: `safe` passed safeHref above
    <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
