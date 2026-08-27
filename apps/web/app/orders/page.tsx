import { redirect } from 'next/navigation';

/** Orders live inside the account shell; keep old links working. */
export default function OrdersRedirect() {
  redirect('/account/orders');
}
