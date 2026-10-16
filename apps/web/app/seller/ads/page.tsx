import { redirect } from 'next/navigation';

// Ads are booked from Advertising now (owner's Batch 2).
export default function SellerAdsMoved() {
  redirect('/seller/advertising');
}
