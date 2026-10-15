'use client';

import type { BannerImageModeValue } from '@clowe/shared';
import FieldError from '@/components/FieldError';

/**
 * Designed (our headline and buttons, the image beside or behind them) or
 * full image (the image is the banner: its text and buttons baked in, the
 * whole thing one link, nothing drawn on top). A full image needs alt text.
 */
export default function BannerModeFields({
  mode,
  onMode,
  altText,
  onAltText,
  altError,
  linkHint,
}: {
  mode: BannerImageModeValue;
  onMode: (mode: BannerImageModeValue) => void;
  altText: string;
  onAltText: (text: string) => void;
  altError?: string;
  /** Where a full-image banner leads, e.g. "the button link below". */
  linkHint: string;
}) {
  const option = (value: BannerImageModeValue, title: string, text: string) => (
    <label
      className={`flex flex-1 cursor-pointer items-start gap-2 rounded-xl border p-3 text-xs ${
        mode === value ? 'border-brand-600 bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <input
        type="radio"
        name="imageMode"
        value={value}
        checked={mode === value}
        onChange={() => onMode(value)}
        className="mt-0.5 accent-[#B8860B]"
      />
      <span>
        <span className="block font-semibold text-ink-900">{title}</span>
        <span className="text-gray-500">{text}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-2" data-field="imageMode">
      <p className="text-xs font-semibold text-gray-700">Banner type</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {option('DESIGNED', 'Designed', 'Our headline and buttons, with your picture beside or behind them.')}
        {option(
          'FULL_IMAGE',
          'Full image',
          `Your image is the whole banner — text and buttons baked in. The banner is one link (${linkHint}); our headline and buttons are not drawn.`,
        )}
      </div>
      {mode === 'FULL_IMAGE' && (
        <div data-field="altText">
          <label className="text-xs font-semibold text-gray-700">Alt text * — what the image says</label>
          <input
            value={altText}
            name="altText"
            onChange={(e) => onAltText(e.target.value)}
            maxLength={200}
            placeholder="e.g. Diwali sale — up to 60% off on ethnic wear. Shop now."
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            Read aloud to shoppers using a screen reader instead of the image, so write the words on the banner.
          </p>
          <FieldError message={altError} />
        </div>
      )}
    </div>
  );
}
