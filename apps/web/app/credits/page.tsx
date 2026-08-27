import { redirect } from 'next/navigation';

/** Credits now live inside the account shell; keep old links working. */
export default function CreditsRedirect() {
  redirect('/account/credits');
}
