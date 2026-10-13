'use client';

import type { LoginMethod } from '@/lib/loginMethod';

/**
 * "Login with PIN" or "Get OTP" — two equal choices, offered for every number
 * (the page never checks whether the number has an account or a PIN). The
 * one this device used last is preselected: marked, and what Enter does in
 * the number field. Nothing is sent until one is chosen, so no OTP goes out
 * unless the person asks for it.
 */
export default function LoginMethodChoice({
  disabled,
  preselected,
  busy,
  onPin,
  onOtp,
}: {
  disabled: boolean;
  preselected: LoginMethod | null;
  /** Which choice is working, to show it is. */
  busy: LoginMethod | null;
  onPin: () => void;
  onOtp: () => void;
}) {
  const option = (method: LoginMethod, label: string, hint: string, onClick: () => void) => {
    const chosen = preselected === method;
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy !== null}
        aria-pressed={chosen}
        data-login-method={method}
        className={`relative flex flex-col items-center justify-center rounded-xl border-2 px-3 py-3 text-sm font-bold transition disabled:opacity-50 ${
          chosen ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-300 bg-white text-ink-900 hover:border-brand-600'
        }`}
      >
        {chosen && (
          <span className="absolute -top-2 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Last used
          </span>
        )}
        <span>{busy === method ? 'Please wait…' : label}</span>
        <span className="mt-0.5 text-[11px] font-normal text-gray-500">{hint}</span>
      </button>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-3" role="group" aria-label="How do you want to log in?">
      {option('pin', 'Login with PIN', 'Your 4-digit PIN', onPin)}
      {option('otp', 'Get OTP', 'A code by SMS', onOtp)}
    </div>
  );
}
