import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtPanel } from './DesignedArt';

const classes = (html: string) => (html.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

describe('ArtPanel', () => {
  it('stays where its caller puts it: no `relative` beside an `absolute`', () => {
    const placed = classes(renderToStaticMarkup(<ArtPanel icon="🛍️" className="absolute inset-y-3 right-3 hidden w-2/5 sm:flex" />));
    expect(placed).toContain('absolute');
    expect(placed).not.toContain('relative');
  });

  it('anchors its own decoration when the caller does not position it', () => {
    expect(classes(renderToStaticMarkup(<ArtPanel icon="📱" className="h-72 w-full" />))).toContain('relative');
  });
});
