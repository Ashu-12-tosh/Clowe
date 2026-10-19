'use client';

import { useRef } from 'react';
import { applyDigitInput } from '@/lib/digitInput';

/**
 * Individual digit boxes (PIN/OTP): numeric keyboard, auto-advance,
 * backspace navigation, and a whole code autofilled, pasted or typed into
 * any box lands in all of them (see applyDigitInput).
 */
export default function DigitBoxes({
  length,
  value,
  onChange,
  masked = false,
  autoFocus = false,
  onComplete,
  label,
  name,
  oneTimeCode = false,
  disabled = false,
}: {
  length: number;
  value: string;
  onChange: (v: string) => void;
  masked?: boolean;
  autoFocus?: boolean;
  onComplete?: (v: string) => void;
  /** Read by screen readers for the row ("New PIN", "OTP"). */
  label: string;
  /** data-digits on the row, for tests and the page's own lookups. */
  name?: string;
  /** An SMS code: lets the phone offer it from the message. */
  oneTimeCode?: boolean;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  function take(index: number, typed: string, before: string) {
    const r = applyDigitInput(value, index, typed, length, before);
    onChange(r.value);
    if (r.value.length === length && r.value !== value) onComplete?.(r.value);
    if (typed.replace(/\D/g, '')) refs.current[r.focus]?.focus();
  }

  return (
    <div className="flex justify-center gap-2" role="group" aria-label={label} data-digits={name}>
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type={masked ? 'password' : 'text'}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={i === 0 ? length : 1}
          autoComplete={i === 0 ? (oneTimeCode ? 'one-time-code' : 'off') : 'off'}
          aria-label={`${label} digit ${i + 1}`}
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          value={value[i] ?? ''}
          onChange={(e) => take(i, e.target.value, value[i] ?? '')}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            take(i, e.clipboardData.getData('text'), '');
          }}
          className="h-12 w-11 rounded-xl border border-gray-300 bg-white text-center text-lg font-bold text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-100 disabled:bg-gray-50"
        />
      ))}
    </div>
  );
}
