import { redirect } from 'next/navigation';

/** Notifications live inside the account shell; keep old links working. */
export default function NotificationsRedirect() {
  redirect('/account/notifications');
}
