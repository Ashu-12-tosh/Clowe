import { redirect } from 'next/navigation';

/** Order details live inside the account shell now. */
export default async function OrderDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/account/orders/${id}`);
}
