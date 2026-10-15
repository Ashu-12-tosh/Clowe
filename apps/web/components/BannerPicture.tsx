/**
 * A banner's image, with its phone version served below 640px when there is
 * one: the browser downloads only the one it shows.
 */
export const PHONE_MEDIA = '(max-width: 639px)';

export default function BannerPicture({
  src,
  mobileSrc,
  alt,
  className,
  loading = 'lazy',
}: {
  src: string;
  mobileSrc?: string | null;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
}) {
  return (
    <picture>
      {mobileSrc && <source media={PHONE_MEDIA} srcSet={mobileSrc} />}
      <img src={src} alt={alt} loading={loading} className={className} />
    </picture>
  );
}
