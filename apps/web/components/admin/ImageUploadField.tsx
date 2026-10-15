'use client';

import { useId, useState } from 'react';
import { IMAGE_UPLOAD_MAX_BYTES, sizeHint, type ImageSize } from '@clowe/shared';
import { uploadImages } from '@/lib/api';
import { toast } from '@/lib/toast';
import FieldError from '@/components/FieldError';
import Spinner from '@/components/Spinner';

const input = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/**
 * An image for a banner or tile: "Upload image" (the same upload and storage
 * as product images), or an image URL pasted in instead. Shows the image in
 * the shape of its slot, and the size to upload for it.
 */
export default function ImageUploadField({
  label,
  value,
  onChange,
  size,
  name,
  error,
  note,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  /** The size to upload: drives the hint and the preview's shape. */
  size: ImageSize;
  /** Matches the API field, so a validation error lands here. */
  name?: string;
  error?: string;
  /** One more line under the hint, e.g. what the image is used for. */
  note?: string;
}) {
  const id = useId();
  const [uploading, setUploading] = useState(false);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file || uploading) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error('Not uploaded: use a JPG, PNG or WebP image');
      return;
    }
    if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
      toast.error(`Not uploaded: ${(file.size / 1024 / 1024).toFixed(1)} MB is over the 5 MB limit`);
      return;
    }
    setUploading(true);
    try {
      const [url] = await uploadImages([file]);
      if (url) {
        onChange(url);
        toast.success('Image uploaded — save to keep it');
      }
    } catch {
      // The API client has already said why.
    } finally {
      setUploading(false);
    }
  }

  return (
    <div data-field={name} className="min-w-0">
      <p className="text-xs font-semibold text-gray-700">{label}</p>
      <div className="mt-1 flex flex-wrap items-start gap-3">
        <div
          className="flex w-40 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-gray-300 bg-cream-50 text-[11px] text-gray-400"
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            'No image'
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <label
              htmlFor={id}
              aria-busy={uploading}
              className={`inline-flex cursor-pointer items-center rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 ${
                uploading ? 'pointer-events-none opacity-60' : ''
              }`}
            >
              {uploading ? (
                <>
                  <Spinner className="mr-1" />
                  Uploading…
                </>
              ) : value ? (
                'Replace image'
              ) : (
                'Upload image'
              )}
            </label>
            <input
              id={id}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              disabled={uploading}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = '';
              }}
            />
            {value && (
              <button
                type="button"
                onClick={() => onChange('')}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              >
                Remove
              </button>
            )}
          </div>
          <input
            value={value}
            name={name}
            onChange={(e) => onChange(e.target.value)}
            placeholder="…or paste an image URL (optional)"
            className={input}
          />
          <p className="text-[11px] text-gray-500">
            Recommended {sizeHint(size)} · JPG, PNG or WebP, up to 5 MB
            {note ? ` · ${note}` : ''}
          </p>
          <FieldError message={error} name={name} />
        </div>
      </div>
    </div>
  );
}
