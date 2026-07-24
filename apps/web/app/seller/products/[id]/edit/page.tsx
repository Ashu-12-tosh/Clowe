'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerProductDetail } from '@clowe/shared';
import { api } from '@/lib/api';
import ProductForm from '@/components/seller/ProductForm';

export default function EditProductPage({ params }: { params: { id: string } }) {
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
      <div className="mt-5">
        <ProductForm initial={product} />
      </div>
    </div>
  );
}
