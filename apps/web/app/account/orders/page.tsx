import { redirect } from 'next/navigation';

/** The orders list moved out of the account shell to /orders; keep old links working. */
export default function AccountOrdersRedirect() {
  redirect('/orders');
}
