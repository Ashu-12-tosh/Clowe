/**
 * Designed stand-ins for pictures that have not been uploaded yet: banners,
 * promo tiles and category tiles render these instead of an empty box (and
 * instead of the stock photos the demo data used). Pure CSS in the theme's
 * ink, gold and cream, with an icon — nothing to load, nothing to break. An
 * image uploaded in admin replaces them.
 */

/** The faint gold grid the panels sit on. */
const GRID = {
  backgroundImage:
    'linear-gradient(rgba(212,175,55,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(212,175,55,0.08) 1px, transparent 1px)',
  backgroundSize: '28px 28px',
};

/** A banner-sized art block: ink ground, gold glow, the icon in a gold ring, a caption. */
export function ArtPanel({
  icon,
  caption,
  className = '',
}: {
  icon: string;
  caption?: string | null;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`relative flex items-center justify-center overflow-hidden rounded-2xl bg-ink-950 ${className}`}
      style={GRID}
    >
      <span className="absolute -right-10 -top-10 h-48 w-48 rounded-full bg-brand-400/25 blur-3xl" />
      <span className="absolute -bottom-12 -left-8 h-40 w-40 rounded-full bg-brand-600/20 blur-3xl" />
      <span className="absolute right-8 top-8 h-16 w-16 rounded-full border border-brand-400/30" />
      <span className="absolute bottom-10 left-10 h-6 w-6 rotate-45 border border-brand-400/40" />
      <div className="relative flex flex-col items-center gap-4 px-6 text-center">
        <span className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-brand-400/70 bg-white/5 text-5xl shadow-[0_0_40px_rgba(212,175,55,0.25)]">
          {icon}
        </span>
        {caption && (
          <span className="font-display text-xl font-bold uppercase tracking-[0.2em] text-brand-400">{caption}</span>
        )}
      </div>
    </div>
  );
}

/** A large, faint icon in a tile's corner — the decoration a tile without a photo carries. */
export function TileMark({ icon, tone = 'dark' }: { icon: string; tone?: 'dark' | 'light' }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={tone === 'dark' ? GRID : undefined}>
      <span
        className={`absolute -bottom-4 -right-2 select-none text-8xl transition duration-300 group-hover:scale-110 ${
          tone === 'dark' ? 'opacity-25' : 'opacity-20'
        }`}
      >
        {icon}
      </span>
      <span
        className={`absolute -right-8 -top-8 h-28 w-28 rounded-full blur-2xl ${
          tone === 'dark' ? 'bg-brand-400/25' : 'bg-brand-400/30'
        }`}
      />
    </span>
  );
}

/** A category's tile face: its icon, or else its initials, on a gold-washed square. */
export function CategoryGlyph({ icon, name, size = 'md' }: { icon?: string | null; name: string; size?: 'md' | 'sm' }) {
  if (icon) return <span className={size === 'md' ? 'text-3xl' : 'text-2xl'}>{icon}</span>;
  const initials = name
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span className={`font-display font-bold text-brand-600 ${size === 'md' ? 'text-xl' : 'text-base'}`}>{initials}</span>
  );
}
