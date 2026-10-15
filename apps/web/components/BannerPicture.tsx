import { imageAt, imageSrcSet } from '@clowe/shared';

/**
 * A banner's image, with its phone version served below 640px when there is
 * one: the browser downloads only the one it shows, at the width it needs
 * (uploads are stored at 320/800/1600/2000 px).
 */
export const PHONE_MEDIA = '(max-width: 639px)';

export default function BannerPicture({
  src,
  mobileSrc,
  alt,
  className,
  loading = 'lazy',
  sizes = '100vw',
}: {
  src: string;
  mobileSrc?: string | null;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  /** The CSS width the image is shown at, so the browser picks the right copy. */
  sizes?: string;
}) {
  return (
    <picture>
      {mobileSrc && <source media={PHONE_MEDIA} srcSet={imageSrcSet(mobileSrc) ?? mobileSrc} sizes="100vw" />}
      <img
        src={imageAt(src, 1600)}
        srcSet={imageSrcSet(src)}
        sizes={sizes}
        alt={alt}
        loading={loading}
        className={className}
      />
    </picture>
  );
}
