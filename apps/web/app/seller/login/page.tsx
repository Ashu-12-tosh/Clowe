'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthTokensResponse, SellerProfileInfo } from '@clowe/shared';
import LoginFlow from '@/components/auth/LoginFlow';
import { api, ApiRequestError, saveSession } from '@/lib/api';
import { useSeller } from '@/components/seller/SellerContext';

/**
 * Seller login: the same flow as the shopper login (phone number or email,
 * then the PIN; "Forgot PIN?" by OTP to the registered phone), then only a
 * seller goes on to the dashboard — anyone else is offered registration.
 */
export default function SellerLoginPage() {
  const router = useRouter();
  const { reload } = useSeller();
  const [noShop, setNoShop] = useState<string | null>(null);

  async function enterDashboard(data: AuthTokensResponse) {
    saveSession(data);
    try {
      await api<SellerProfileInfo>('/api/seller/profile', { auth: true, quiet: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SELLER_PROFILE_REQUIRED') {
        setNoShop(data.user.phone);
        return;
      }
      throw err;
    }
    reload();
    // Deep links (e.g. a scanned label QR) send the seller back where they started.
    const next = new URLSearchParams(window.location.search).get('next');
    router.push(next && next.startsWith('/seller/') ? next : '/seller');
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-10">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">Seller Panel</p>
      {noShop ? (
        <div className="mt-2 space-y-4">
          <h1 className="text-3xl font-bold tracking-tight text-brand-900">No shop yet</h1>
          <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-5" data-no-seller>
            <p className="text-sm text-gray-700">
              <span className="font-semibold">+91 {noShop}</span> has no seller account yet.
            </p>
            <Link
              href="/seller/register"
              className="block w-full rounded-lg bg-brand-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-700"
            >
              Register your shop →
            </Link>
            <p className="text-center text-xs text-gray-500">
              Here to shop?{' '}
              <Link href="/" className="font-semibold text-brand-600 hover:underline">
                Continue to Clowe
              </Link>
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-1">
          <LoginFlow variant="seller" onSignedIn={enterDashboard} />
          <p className="mt-6 text-center text-xs text-gray-500">
            New to selling?{' '}
            <Link href="/sell" className="font-semibold text-brand-600 hover:underline">
              See why sellers choose Clowe →
            </Link>
          </p>
        </div>
      )}
    </main>
  );
}
