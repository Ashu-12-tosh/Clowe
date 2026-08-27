import { redirect } from 'next/navigation';

/** Order details live inside the account shell now. */
export default function OrderDetailRedirect({ params }: { params: { id: string } }) {
  redirect(`/account/orders/${params.id}`);
}
