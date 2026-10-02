'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerProductDetail } from '@clowe/shared';
import { api } from '@/lib/api';
import ProductForm from '@/components/seller/ProductForm';

export default function EditProductPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = use(paramsPromise);
  const [product, setProduct] = useState<SellerProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api<SellerProductDetail>(`/api/seller/products/${params.id}`, { auth: true })
      .then(setProduct)
      .catch(() => setNotFound(true));
  }, [params.id]);

  if (notFound) {
    return (
      <div>
        <p className="text-sm text-gray-600">Product not found.</p>
        <Link href="/seller/products" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
          ← Back to products
        </Link>
      </div>
    );
  }

  if (!product) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold">Edit product</h1>
      <p className="mt-1 text-xs text-gray-500">
        Status: <span className="font-semibold">{product.status}</span>
        {product.status === 'REJECTED' && product.rejectionReason && (
          <span className="text-red-600"> — {product.rejectionReason}</span>
        )}
      </p>
      {product.status === 'APPROVED' && (
        // A live listing stays live while an edit is reviewed; say what that means here.
        <p className="mt-2 max-w-3xl rounded-lg bg-cream-100 px-3 py-2 text-xs leading-relaxed text-gray-700">
          {!product.revision &&
            'This listing is live. Price, stock and the other details save straight away. Changes to the title, descriptions, pictures, category, brand, specifications, video or new variants go to review, and buyers keep seeing the live listing until they are approved.'}
          {product.revision?.status === 'PENDING' &&
            `Your edits are waiting for review${product.revision.submittedAt ? ` since ${new Date(product.revision.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}. Buyers still see the approved listing; the form shows your edits.`}
          {product.revision?.status === 'DRAFT' &&
            'Your edits are saved as a draft and are not live. Submit them for review when they are ready.'}
          {product.revision?.status === 'REJECTED' && (
            <>
              <span className="font-semibold text-red-600">Your last edits were not approved</span>
              {product.revision.rejectionReason ? `: ${product.revision.rejectionReason}.` : '.'} Buyers still see
              the approved listing. Change the edits and submit again, or put them back as they were.
            </>
          )}
        </p>
      )}
      <div className="mt-5">
        <ProductForm initial={product} />
      </div>
    </div>
  );
}
