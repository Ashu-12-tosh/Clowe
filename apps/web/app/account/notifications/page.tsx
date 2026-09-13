import { redirect } from 'next/navigation';

/** The feed moved out of the account shell to /notifications; keep old links working. */
export default function AccountNotificationsRedirect() {
  redirect('/notifications');
}
