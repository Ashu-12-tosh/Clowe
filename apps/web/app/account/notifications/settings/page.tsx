import { redirect } from 'next/navigation';

/** Preferences moved to the bare /notifications/settings page; keep old links working. */
export default function NotificationSettingsRedirect() {
  redirect('/notifications/settings');
}
