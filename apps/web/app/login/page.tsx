'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import LoginBackdrop from '@/components/LoginBackdrop';
import LegalCopyright from '@/components/LegalCopyright';
import LoginFlow, { type LoginFlowHandle, type LoginStep } from '@/components/auth/LoginFlow';
import { closeLogin } from '@/lib/returnTo';
import type { AuthTokensResponse, UserRole } from '@clowe/shared';
import { getStoredUser, saveSession } from '@/lib/api';
import BrandLogo from '@/components/BrandLogo';

// The shopper login: the brand panel, and the login and sign-up flow
// (components/auth/LoginFlow) on a card over the blurred storefront.

/** Admin/seller land on their dashboard; customers go straight to the home page. */
function dashboardFor(role: UserRole): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'SELLER') return '/seller';
  return '/';
}

export default function LoginPage() {
  const router = useRouter();
  const flow = useRef<LoginFlowHandle>(null);
  const [step, setStep] = useState<LoginStep>('identify');

  // Already signed in: this page is for signing in only.
  useEffect(() => {
    if (getStoredUser()) router.replace('/account');
  }, [router]);

  // The header's "Create Account" (/login?new=1) opens straight on the sign-up form.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') flow.current?.openSignup();
  }, []);

  // Esc leaves the login page (nothing typed is sent), like the X and the back arrow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLogin(router);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  function finish(data: AuthTokensResponse) {
    saveSession(data);
    router.push(dashboardFor(data.user.role));
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* ============ LEFT: brand panel ============ */}
      <aside className="sticky top-0 hidden h-screen shrink-0 bg-black lg:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/login-panel.jpg" alt="Clowe — Your Style, Our Intelligence" className="h-full w-auto select-none" draggable={false} />
      </aside>

      {/* ============ RIGHT: auth card over the blurred storefront ============ */}
      <main className="relative flex flex-1 flex-col bg-cream-50">
        <LoginBackdrop />

        {/* Mobile compact brand header */}
        <div className="relative z-10 bg-ink-950 px-5 py-4 text-center lg:hidden">
          <button
            type="button"
            onClick={() => closeLogin(router)}
            aria-label="Back"
            data-login-back
            className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-2xl leading-none text-brand-400 hover:bg-white/10"
          >
            ←
          </button>
          <BrandLogo tone="gold" height={30} className="mx-auto w-[118px]" />
          <p className="mt-1 text-[11px] text-brand-400/80">Your Style, Our Intelligence.</p>
        </div>

        {/* Top-right switch */}
        <div className="relative z-10 flex items-center justify-end gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <span className="hidden text-sm text-gray-500 sm:inline">{step === 'signup' ? 'Already have an account?' : 'New to Clowe?'}</span>
          <button
            type="button"
            onClick={() => (step === 'signup' ? flow.current?.backToLogin() : flow.current?.openSignup())}
            className="rounded-lg border-2 border-brand-600 px-4 py-1.5 text-sm font-bold text-brand-600 hover:bg-brand-50"
            data-login-switch
          >
            {step === 'signup' ? 'Log in' : 'Create Account'}
          </button>
        </div>

        <div className="relative z-10 flex flex-1 items-start justify-center px-4 py-5 sm:items-center sm:py-10">
          <div className="relative w-full max-w-md rounded-3xl border border-gray-100 bg-white p-5 shadow-xl sm:p-9">
            <button
              type="button"
              onClick={() => closeLogin(router)}
              aria-label="Close"
              title="Close (Esc)"
              data-login-close
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none text-gray-400 hover:bg-gray-100 hover:text-ink-900"
            >
              ✕
            </button>
            <LoginFlow variant="shopper" ref={flow} onSignedIn={finish} onStepChange={setStep} />
          </div>
        </div>

        <LegalCopyright className="pb-5 text-center text-xs text-gray-400" />
      </main>
    </div>
  );
}
