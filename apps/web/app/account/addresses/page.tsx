'use client';

import { useEffect, useState } from 'react';
import {
  ADDRESS_LABELS,
  ADDRESS_LABEL_TEXT,
  addressUpsertSchema,
  type AddressInfo,
  type AddressLabel,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { MapPinIcon, PlusIcon } from '@/components/cart/CartIcons';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

export default function AddressesPage() {
  const [addresses, setAddresses] = useState<AddressInfo[] | null>(null);
  const [editing, setEditing] = useState<AddressInfo | 'new' | null>(null);
  const [label, setLabel] = useState<AddressLabel>('HOME');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AddressInfo[]>('/api/addresses', { auth: true })
      .then(setAddresses)
      .catch(() => setAddresses([]));
  }, []);

  function startEdit(address: AddressInfo | 'new') {
    setError('');
    setEditing(address);
    setLabel(address === 'new' ? 'HOME' : address.label);
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const raw = Object.fromEntries(
      [...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''),
    );
    const parsed = addressUpsertSchema.safeParse({
      ...raw,
      label,
      isDefault: raw.isDefault === 'on',
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.')}: ${issue.message}`);
      return;
    }
    setBusy(true);
    try {
      if (editing === 'new') {
        const created = await api<AddressInfo>('/api/addresses', {
          body: parsed.data,
          auth: true,
        });
        // A new default demotes the others, so re-read rather than splice.
        setAddresses((prev) =>
          parsed.data.isDefault
            ? [created, ...(prev ?? []).map((a) => ({ ...a, isDefault: false }))]
            : [created, ...(prev ?? [])],
        );
      } else if (editing) {
        const updated = await api<AddressInfo>(`/api/addresses/${editing.id}`, {
          method: 'PUT',
          body: parsed.data,
          auth: true,
        });
        setAddresses((prev) =>
          (prev ?? []).map((a) =>
            a.id === updated.id
              ? updated
              : updated.isDefault
                ? { ...a, isDefault: false }
                : a,
          ),
        );
      }
      setEditing(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the address');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this address?')) return;
    setError('');
    try {
      await api(`/api/addresses/${id}`, { method: 'DELETE', auth: true });
      setAddresses((prev) => (prev ?? []).filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete the address');
    }
  }

  const current = editing === 'new' ? null : editing;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">My Addresses</h1>
          <p className="mt-1 text-sm text-gray-500">
            Saved addresses show up at checkout — the default one is picked automatically.
          </p>
        </div>
        {!editing && (
          <button
            onClick={() => startEdit('new')}
            className="flex items-center gap-1.5 rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800"
          >
            <PlusIcon className="h-4 w-4" />
            Add Address
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {editing && (
        <form
          onSubmit={(e) => void save(e)}
          className="grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2"
        >
          <h2 className="text-base font-bold text-ink-900 sm:col-span-2">
            {editing === 'new' ? 'Add a new address' : 'Edit address'}
          </h2>
          <div className="flex gap-2 sm:col-span-2">
            {ADDRESS_LABELS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setLabel(value)}
                className={`rounded-lg border px-4 py-1.5 text-xs font-bold uppercase tracking-wide transition ${
                  label === value
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-gray-300 text-gray-500 hover:border-gray-400'
                }`}
              >
                {ADDRESS_LABEL_TEXT[value]}
              </button>
            ))}
          </div>
          <input name="name" defaultValue={current?.name} placeholder="Full name *" className={field} required />
          <input
            name="phone"
            defaultValue={current?.phone}
            placeholder="10-digit phone *"
            className={field}
            required
            maxLength={10}
          />
          <input
            name="line1"
            defaultValue={current?.line1}
            placeholder="House no, street *"
            className={`sm:col-span-2 ${field}`}
            required
          />
          <input
            name="line2"
            defaultValue={current?.line2 ?? ''}
            placeholder="Area, locality"
            className={`sm:col-span-2 ${field}`}
          />
          <input name="landmark" defaultValue={current?.landmark ?? ''} placeholder="Landmark" className={field} />
          <input
            name="pincode"
            defaultValue={current?.pincode}
            placeholder="Pincode *"
            className={field}
            required
            maxLength={6}
          />
          <input name="city" defaultValue={current?.city} placeholder="City *" className={field} required />
          <input name="state" defaultValue={current?.state} placeholder="State *" className={field} required />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600 sm:col-span-2">
            <input
              type="checkbox"
              name="isDefault"
              defaultChecked={current?.isDefault ?? false}
              className="h-4 w-4 accent-brand-600"
            />
            Make this my default address
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button
              disabled={busy}
              className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save address'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-600"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {addresses === null ? (
        <div className="h-40 animate-pulse rounded-2xl bg-cream-100" />
      ) : addresses.length === 0 && !editing ? (
        <div className="rounded-2xl border border-gray-100 bg-white py-12 text-center">
          <span className="text-4xl">📍</span>
          <p className="mt-3 text-sm text-gray-500">No addresses saved yet.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {addresses.map((address) => (
            <div
              key={address.id}
              className={`rounded-2xl border p-4 ${
                address.isDefault ? 'border-brand-600 bg-brand-50/30' : 'border-gray-100 bg-white'
              }`}
            >
              <p className="flex items-center gap-1.5 text-sm font-bold text-ink-900">
                <MapPinIcon className="h-4 w-4 text-gray-500" />
                {ADDRESS_LABEL_TEXT[address.label]}
                {address.isDefault && (
                  <span className="ml-1.5 rounded bg-cream-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600">
                    Default
                  </span>
                )}
              </p>
              <p className="mt-2 text-sm font-semibold text-ink-900">{address.name}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                {address.line1}
                {address.line2 ? `, ${address.line2}` : ''}
                {address.landmark ? `, ${address.landmark}` : ''}
                <br />
                {address.city}, {address.state} - {address.pincode}
              </p>
              <p className="mt-1 text-xs text-gray-500">+91 {address.phone}</p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => startEdit(address)}
                  className="rounded-lg border border-gray-300 px-4 py-1.5 text-xs font-bold text-ink-900 transition hover:bg-cream-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => void remove(address.id)}
                  className="rounded-lg border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-red-300 hover:text-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
