'use client';

import ProductForm from '@/components/seller/ProductForm';
import { useSeller } from '@/components/seller/SellerContext';

export default function NewProductPage() {
  const { state } = useSeller();
  const notApproved = state.kind === 'ready' && state.profile.status !== 'APPROVED';

  return (
    <div>
      <h1 className="text-2xl font-bold">Add product</h1>
      {notApproved ? (
        <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          Your seller account is <span className="font-semibold">{state.profile.status}</span>. You
          can add products once the admin approves your account.
        </div>
      ) : (
        <div className="mt-5">
          <ProductForm />
        </div>
      )}
    </div>
  );
}
