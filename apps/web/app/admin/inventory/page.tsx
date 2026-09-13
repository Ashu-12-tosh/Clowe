'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IMPORT_COLUMNS,
  IMPORT_MODES,
  IMPORT_MODE_LABELS,
  INVENTORY_SORT_OPTIONS,
  INVENTORY_SORT_OPTION_LABELS,
  INVENTORY_TABS,
  INVENTORY_TAB_LABELS,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABELS,
  STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  type AdminInventorySummary,
  type ImportMode,
  type InventoryFilterOptions,
  type InventoryImportResult,
  type InventorySortOption,
  type InventoryStockPage,
  type InventoryStockRow,
  type InventoryTab,
  type MovementPage,
  type MovementType,
  type PurchaseOrderRow,
  type StockStatusValue,
  type SupplierRow,
  type TransferRow,
  type WarehouseRow,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BarList, DonutChart, LineChart } from '@/components/charts/Charts';

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<StockStatusValue, string> = {
  IN_STOCK: 'bg-green-100 text-green-700',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-700',
  OVERSTOCK: 'bg-blue-100 text-blue-700',
};

const STATUS_BAR: Record<StockStatusValue, string> = {
  IN_STOCK: 'bg-green-500',
  LOW_STOCK: 'bg-yellow-500',
  OUT_OF_STOCK: 'bg-red-500',
  OVERSTOCK: 'bg-blue-500',
};

const MOVEMENT_STYLES: Record<MovementType, string> = {
  RECEIPT: 'bg-green-100 text-green-700',
  DISPATCH: 'bg-blue-100 text-blue-700',
  TRANSFER: 'bg-purple-100 text-purple-700',
  ADJUSTMENT: 'bg-orange-100 text-orange-700',
  RETURN: 'bg-gray-100 text-gray-600',
};

const TONE_STYLES: Record<string, string> = {
  GOOD: 'text-green-600',
  INFO: 'text-blue-600',
  WARN: 'text-yellow-600',
  BAD: 'text-red-600',
};

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function shortMoney(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 10000000) return `₹${(rupees / 10000000).toFixed(1)}Cr`;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${Math.round(rupees / 1000)}K`;
  return `₹${Math.round(rupees)}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: string;
  label: string;
  value: string;
  hint?: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cream-100 text-base">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p
            className={`mt-0.5 truncate font-display text-lg font-bold ${
              tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-yellow-600' : 'text-ink-900'
            }`}
          >
            {value}
          </p>
        </div>
      </div>
      {hint && <p className="mt-2 truncate text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className={`max-h-[88vh] w-full overflow-y-auto rounded-2xl bg-white p-5 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-ink-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-xl leading-none text-gray-400 hover:text-ink-900"
          >
            ×
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';
const labelClass = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminInventoryPage() {
  const [tab, setTab] = useState<InventoryTab>('OVERVIEW');
  const [summary, setSummary] = useState<AdminInventorySummary | null>(null);
  const [options, setOptions] = useState<InventoryFilterOptions | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The overview table owns the rows; selection lives here so the header's
  // Bulk Actions menu can act on whatever is ticked below.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stockQueryString, setStockQueryString] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [openMenu, setOpenMenu] = useState<'EXPORT' | 'BULK' | null>(null);
  const [modal, setModal] = useState<'RECEIVE' | 'IMPORT' | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        api<AdminInventorySummary>('/api/admin/inventory/summary', { auth: true }),
        api<InventoryFilterOptions>('/api/admin/inventory/meta/options', { auth: true }),
      ]);
      setSummary(s);
      setOptions(o);
      setError('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not load inventory (are you admin?)',
      );
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 5000);
  }, []);

  /** Reload the summary and tell the overview table to re-fetch its page. */
  const refreshAll = useCallback(async () => {
    setReloadToken((t) => t + 1);
    await loadSummary();
  }, [loadSummary]);

  async function runBulk(action: 'SET_REORDER' | 'MARK_COUNTED' | 'ADJUST') {
    setOpenMenu(null);
    const body: Record<string, unknown> = { locationIds: [...selected], action };

    if (action === 'SET_REORDER') {
      const value = window.prompt('Reorder level for the selected rows:', '10');
      if (value === null) return;
      if (!/^\d+$/.test(value.trim())) {
        flash('Reorder level must be a whole number.');
        return;
      }
      body.reorderLevel = Number(value.trim());
    }
    if (action === 'ADJUST') {
      const value = window.prompt('Set every selected row to this counted quantity:', '0');
      if (value === null) return;
      if (!/^\d+$/.test(value.trim())) {
        flash('Quantity must be a whole number.');
        return;
      }
      const reason = window.prompt('Reason for the adjustment:', 'Bulk cycle count');
      if (reason === null) return;
      if (reason.trim().length < 3) {
        flash('Give a reason of at least 3 characters.');
        return;
      }
      body.newQuantity = Number(value.trim());
      body.reason = reason.trim();
    }

    try {
      const result = await api<{ updated: number; skipped: { reason: string }[] }>(
        '/api/admin/inventory/stock/bulk',
        { method: 'POST', auth: true, body },
      );
      flash(
        `${result.updated} row(s) updated${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}.`,
      );
      setSelected(new Set());
      await refreshAll();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not apply that.');
    }
  }

  return (
    <div className="pb-10" onClick={() => setOpenMenu(null)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">
            Inventory &amp; Warehouse Management
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Track stock across warehouses, move it, and see every change that made it move.
          </p>
        </div>

        {/* Action bar --------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setOpenMenu(openMenu === 'EXPORT' ? null : 'EXPORT')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              ⭳ Export Report ▾
            </button>
            {openMenu === 'EXPORT' && (
              <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                {[
                  {
                    label: 'Inventory (current filters)',
                    hint: 'Every row the overview table is showing',
                    href: `/api/admin/inventory/stock/export?${stockQueryString}`,
                    file: 'inventory.csv',
                  },
                  {
                    label: 'Stock movements',
                    hint: 'The full ledger — receipts, dispatch, transfers',
                    href: '/api/admin/inventory/movements/export',
                    file: 'stock-movements.csv',
                  },
                  {
                    label: 'Warehouse summary',
                    hint: 'One row per warehouse with units and value',
                    href: '/api/admin/inventory/warehouses/export',
                    file: 'warehouses.csv',
                  },
                ].map((item) => (
                  <button
                    key={item.file}
                    onClick={() => {
                      setOpenMenu(null);
                      void downloadFile(item.href, item.file);
                    }}
                    className="block w-full px-3 py-2 text-left hover:bg-cream-50"
                  >
                    <span className="block text-xs font-semibold text-ink-900">{item.label}</span>
                    <span className="block text-[11px] text-gray-400">{item.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => setModal('IMPORT')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ⭱ Import Inventory
          </button>

          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setOpenMenu(openMenu === 'BULK' ? null : 'BULK')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              ▤ Bulk Actions{selected.size > 0 ? ` (${selected.size})` : ''} ▾
            </button>
            {openMenu === 'BULK' && (
              <div className="absolute right-0 z-30 mt-1 w-80 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                {selected.size === 0 ? (
                  <p className="px-3 py-3 text-[11px] text-gray-500">
                    Tick rows in the Inventory Overview table first — bulk actions apply to the
                    selection.
                  </p>
                ) : (
                  [
                    {
                      key: 'SET_REORDER' as const,
                      label: 'Set reorder level',
                      hint: 'Changes when low-stock alerts fire',
                    },
                    {
                      key: 'MARK_COUNTED' as const,
                      label: 'Mark counted (matches system)',
                      hint: 'Records a clean cycle count against stock accuracy',
                    },
                    {
                      key: 'ADJUST' as const,
                      label: 'Adjust to a counted quantity',
                      hint: 'Writes an adjustment per row, with your reason',
                    },
                  ].map((item) => (
                    <button
                      key={item.key}
                      onClick={() => void runBulk(item.key)}
                      className="block w-full px-3 py-2 text-left hover:bg-cream-50"
                    >
                      <span className="block text-xs font-semibold text-ink-900">{item.label}</span>
                      <span className="block text-[11px] text-gray-400">{item.hint}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => setModal('RECEIVE')}
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-700"
          >
            + Add Stock / Receive
          </button>

          <button
            onClick={() => void refreshAll()}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      {/* KPIs -------------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {summary ? (
          <>
            <KpiCard
              icon="🏷"
              label="Total SKUs"
              value={num(summary.kpis.totalSkus)}
              hint={`${num(summary.valueByWarehouse.length)} warehouses`}
            />
            <KpiCard
              icon="📦"
              label="Total inventory"
              value={num(summary.kpis.totalUnits)}
              hint="units on the shelf"
            />
            <KpiCard
              icon="💰"
              label="Inventory value"
              value={formatPaise(summary.kpis.inventoryValuePaise)}
              hint="at current selling price"
            />
            <KpiCard
              icon="⚠"
              label="Low stock"
              value={num(summary.kpis.lowStockItems)}
              hint="at or below reorder level"
              tone={summary.kpis.lowStockItems > 0 ? 'warn' : undefined}
            />
            <KpiCard
              icon="⛔"
              label="Out of stock"
              value={num(summary.kpis.outOfStockItems)}
              hint="listed but unbuyable"
              tone={summary.kpis.outOfStockItems > 0 ? 'bad' : undefined}
            />
            <KpiCard
              icon="📚"
              label="Overstock"
              value={num(summary.kpis.overstockItems)}
              hint="10× reorder level or more"
            />
            <KpiCard
              icon="🎯"
              label="Stock accuracy"
              value={
                summary.kpis.stockAccuracyPercent === null
                  ? '—'
                  : `${summary.kpis.stockAccuracyPercent}%`
              }
              hint={
                summary.kpis.countedLocations === 0
                  ? 'nothing counted yet'
                  : `${num(summary.kpis.countedLocations)} locations counted`
              }
            />
          </>
        ) : (
          Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* Tabs -------------------------------------------------------------- */}
      <div className="mt-5 flex gap-1 overflow-x-auto border-b border-gray-200">
        {INVENTORY_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-xs font-semibold ${
              tab === t
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-ink-900'
            }`}
          >
            {INVENTORY_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === 'OVERVIEW' && summary && options && (
          <OverviewTab
            summary={summary}
            options={options}
            onChanged={loadSummary}
            flash={flash}
            selected={selected}
            setSelected={setSelected}
            onQueryChange={setStockQueryString}
            reloadToken={reloadToken}
          />
        )}
        {tab === 'WAREHOUSES' && <WarehousesTab onChanged={loadSummary} flash={flash} />}
        {tab === 'MOVEMENTS' && options && <MovementsTab options={options} />}
        {tab === 'ADJUSTMENTS' && <AdjustmentsTab />}
        {tab === 'SUPPLIERS' && <SuppliersTab flash={flash} />}
        {tab === 'PURCHASE_ORDERS' && options && (
          <PurchaseOrdersTab options={options} onChanged={loadSummary} flash={flash} />
        )}
      </div>

      {modal === 'RECEIVE' && options && (
        <AddStockModal
          options={options}
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            flash(message);
            await refreshAll();
          }}
        />
      )}
      {modal === 'IMPORT' && options && (
        <ImportModal
          options={options}
          onClose={() => setModal(null)}
          onDone={async (message) => {
            setModal(null);
            flash(message);
            await refreshAll();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  summary,
  options,
  onChanged,
  flash,
  selected,
  setSelected,
  onQueryChange,
  reloadToken,
}: {
  summary: AdminInventorySummary;
  options: InventoryFilterOptions;
  onChanged: () => Promise<void>;
  flash: (m: string) => void;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  /** Reported upwards so the header's Export uses the same filters. */
  onQueryChange: (query: string) => void;
  reloadToken: number;
}) {
  const [page, setPage] = useState<InventoryStockPage | null>(null);
  const [q, setQ] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [sellerId, setSellerId] = useState('');
  const [status, setStatus] = useState<'ALL' | StockStatusValue>('ALL');
  const [sort, setSort] = useState<InventorySortOption>('STOCK_LOW');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adjusting, setAdjusting] = useState<InventoryStockRow | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      status,
      sort,
      page: String(pageNo),
      pageSize: String(pageSize),
    });
    if (q.trim()) params.set('q', q.trim());
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (categoryId) params.set('categoryId', categoryId);
    if (brandId) params.set('brandId', brandId);
    if (sellerId) params.set('sellerId', sellerId);
    return params.toString();
  }, [q, warehouseId, categoryId, brandId, sellerId, status, sort, pageNo, pageSize]);

  const load = useCallback(async () => {
    setPage(await api<InventoryStockPage>(`/api/admin/inventory/stock?${query}`, { auth: true }));
  }, [query]);

  useEffect(() => {
    void load();
    // reloadToken changes when something outside this tab moved stock.
  }, [load, reloadToken]);

  useEffect(() => {
    onQueryChange(query);
  }, [query, onQueryChange]);

  // Any filter change invalidates the page number.
  useEffect(() => {
    setPageNo(1);
    setSelected(new Set());
  }, [q, warehouseId, categoryId, brandId, sellerId, status, sort, pageSize, setSelected]);

  const rows = page?.rows ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.locationId));

  async function runBulk(action: 'SET_REORDER' | 'MARK_COUNTED', reorderLevel?: number) {
    setBusy(true);
    try {
      const result = await api<{ updated: number }>('/api/admin/inventory/stock/bulk', {
        method: 'POST',
        auth: true,
        body: { locationIds: [...selected], action, reorderLevel },
      });
      flash(`${result.updated} row(s) updated.`);
      setSelected(new Set());
      await load();
      await onChanged();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not apply that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-4">
      <div className="space-y-4 xl:col-span-3">
        {/* Live strip -------------------------------------------------- */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            {
              label: 'Total warehouses',
              value: num(summary.strip.activeWarehouses),
              hint: 'Active',
            },
            {
              label: 'Stock in transit',
              value: num(summary.strip.unitsInTransit),
              hint: 'On PO or transfer',
            },
            {
              label: "Today's receipts",
              value: num(summary.strip.receiptsToday),
              hint: 'Units received',
            },
            {
              label: "Today's dispatch",
              value: num(summary.strip.dispatchToday),
              hint: 'Units shipped',
            },
            {
              label: 'Pending transfers',
              value: num(summary.strip.pendingTransfers),
              hint: 'Awaiting dispatch',
            },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border border-gray-100 bg-white p-3">
              <p className="text-[11px] font-medium text-gray-500">{s.label}</p>
              <p className="mt-0.5 font-display text-lg font-bold text-ink-900">{s.value}</p>
              <p className="text-[11px] text-gray-400">{s.hint}</p>
            </div>
          ))}
        </div>

        {/* Filters ----------------------------------------------------- */}
        <div className="flex flex-wrap gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by SKU or product…"
            className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs outline-none focus:border-brand-600"
          />
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
          >
            <option value="">All categories</option>
            {options.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
          >
            <option value="">All warehouses</option>
            {options.warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
          >
            <option value="">All brands</option>
            {options.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'ALL' | StockStatusValue)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
          >
            <option value="ALL">All stock status</option>
            {STOCK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STOCK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <select
            value={sellerId}
            onChange={(e) => setSellerId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
          >
            <option value="">All sellers</option>
            {options.sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as InventorySortOption)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
          >
            {INVENTORY_SORT_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {INVENTORY_SORT_OPTION_LABELS[s]}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              downloadFile(`/api/admin/inventory/stock/export?${query}`, 'inventory.csv')
            }
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            ⭳ Export
          </button>
        </div>

        {/* Bulk bar ---------------------------------------------------- */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-cream-50 px-3 py-2 text-xs">
            <span className="font-semibold text-ink-900">{selected.size} selected</span>
            <button
              disabled={busy}
              onClick={() => {
                const value = window.prompt('Set reorder level for the selected rows:', '10');
                if (value === null) return;
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed < 0) {
                  flash('Reorder level must be a whole number.');
                  return;
                }
                void runBulk('SET_REORDER', parsed);
              }}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              Set reorder level
            </button>
            <button
              disabled={busy}
              onClick={() => void runBulk('MARK_COUNTED')}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              Mark counted (matches system)
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="ml-auto text-gray-500 hover:text-ink-900"
            >
              Clear
            </button>
          </div>
        )}

        {/* Table ------------------------------------------------------- */}
        <section className="rounded-2xl border border-gray-100 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(rows.map((r) => r.locationId)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">SKU</th>
                  <th className="px-3 py-2.5 font-semibold">Product</th>
                  <th className="px-3 py-2.5 font-semibold">Category</th>
                  <th className="px-3 py-2.5 font-semibold">Warehouse</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Available</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Reserved</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Incoming</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Stock level</th>
                  <th className="px-3 py-2.5 font-semibold">Last updated</th>
                  <th className="px-3 py-2.5 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // Bar is filled against 2× the reorder level: at the line the
                  // bar is half full, which reads as "time to order".
                  const ceiling = Math.max(r.reorderLevel * 2, r.available, 1);
                  return (
                    <tr key={r.locationId} className="border-t border-gray-100 hover:bg-cream-50">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(r.locationId)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.locationId);
                            else next.delete(r.locationId);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-2.5 font-mono text-brand-600">{r.sku}</td>
                      <td className="max-w-56 px-3 py-2.5">
                        <p className="truncate font-medium text-ink-900">{r.title}</p>
                        <p className="truncate text-[11px] text-gray-400">
                          {r.label ? ` · ` : ''}{r.sellerName}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">{r.categoryName}</td>
                      <td className="px-3 py-2.5 text-gray-600">{r.warehouseName}</td>
                      <td className="px-3 py-2.5 text-right font-semibold text-ink-900">
                        {num(r.available)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-600">{num(r.reserved)}</td>
                      <td className="px-3 py-2.5 text-right text-gray-600">{num(r.incoming)}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[r.status]}`}
                        >
                          {r.statusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-cream-100">
                          <div
                            className={`h-full rounded-full ${STATUS_BAR[r.status]}`}
                            style={{ width: `${Math.min(100, (r.available / ceiling) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-0.5 text-[10px] text-gray-400">
                          reorder at {num(r.reorderLevel)}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                        {r.lastMovementAt ? when(r.lastMovementAt) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => setAdjusting(r)}
                          className="rounded-lg border border-gray-300 px-2 py-1 font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          Adjust
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-gray-500">
                      Nothing matches those filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {page && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
              <span>
                Showing {rows.length === 0 ? 0 : (page.page - 1) * page.pageSize + 1}–
                {(page.page - 1) * page.pageSize + rows.length} of {num(page.total)} rows
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page.page <= 1}
                  onClick={() => setPageNo(page.page - 1)}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
                >
                  ‹
                </button>
                <span className="font-semibold text-ink-900">
                  {page.page} / {page.totalPages}
                </span>
                <button
                  disabled={page.page >= page.totalPages}
                  onClick={() => setPageNo(page.page + 1)}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
                >
                  ›
                </button>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="rounded-lg border border-gray-300 px-2 py-1"
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n} / page
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </section>

        {/* Bottom charts ----------------------------------------------- */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Inventory value" subtitle="Last 30 days, rebuilt from the ledger">
            <LineChart
              points={summary.valueTrend.map((t) => ({ date: t.date, value: t.valuePaise }))}
              format={shortMoney}
              height={150}
            />
          </Panel>

          <Panel title="Stock status distribution" subtitle="Every SKU-warehouse row">
            <DonutChart
              slices={summary.statusBreakdown}
              total={summary.statusBreakdown.reduce((sum, s) => sum + s.count, 0)}
              totalLabel="ROWS"
              size={120}
            />
          </Panel>

          <Panel title="Top categories by value" subtitle="Stock on hand">
            <BarList
              numbered
              items={summary.topCategories.map((c) => ({
                key: c.id,
                label: c.name,
                percent: c.share,
                value: formatPaise(c.valuePaise),
                hint: `${num(c.units)} units`,
              }))}
            />
          </Panel>
        </div>

        <Panel title="Stock movement" subtitle="Units this month, by type">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['Receipts', summary.movementTotals.receipts, '📥'],
              ['Dispatch', summary.movementTotals.dispatch, '📤'],
              ['Transfers', summary.movementTotals.transfers, '🔁'],
              ['Adjustments', summary.movementTotals.adjustments, '✎'],
            ].map(([label, value, icon]) => (
              <div key={String(label)} className="rounded-xl border border-gray-100 p-3">
                <p className="text-[11px] text-gray-500">
                  {icon as string} {label as string}
                </p>
                <p className="mt-0.5 font-display text-lg font-bold text-ink-900">
                  {num(value as number)}
                </p>
                <p className="text-[11px] text-gray-400">units</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* Sidebar ------------------------------------------------------- */}
      <div className="space-y-4">
        <Panel title="Inventory value by warehouse">
          <DonutChart
            slices={summary.valueByWarehouse.map((w) => ({
              key: w.id,
              label: w.name,
              count: w.units,
              share: w.share,
            }))}
            total={summary.kpis.totalUnits}
            totalLabel="UNITS"
            size={120}
          />
          <ul className="mt-3 space-y-1 text-[11px]">
            {summary.valueByWarehouse.map((w) => (
              <li key={w.id} className="flex justify-between gap-2">
                <span className="truncate text-gray-500">{w.code}</span>
                <span className="font-semibold text-ink-900">{formatPaise(w.valuePaise)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Stock status summary">
          <div className="grid grid-cols-2 gap-2">
            {STOCK_STATUSES.map((s) => {
              const row = summary.statusBreakdown.find((b) => b.key === s);
              return (
                <div key={s} className={`rounded-xl px-3 py-2 ${STATUS_STYLES[s]}`}>
                  <p className="text-[11px] font-semibold">{STOCK_STATUS_LABELS[s]}</p>
                  <p className="font-display text-base font-bold">{num(row?.count ?? 0)}</p>
                  <p className="text-[10px] opacity-80">({row?.share ?? 0}%)</p>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Low stock alerts" subtitle="At or below reorder level">
          <ul className="space-y-2 text-xs">
            {summary.lowStockAlerts.map((a) => (
              <li key={a.locationId} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-900">{a.title}</p>
                  <p className="truncate text-[11px] text-gray-400">
                    {a.warehouseName} · reorder at {a.reorderLevel}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-semibold text-yellow-800">
                  {num(a.available)} left
                </span>
              </li>
            ))}
            {summary.lowStockAlerts.length === 0 && (
              <li className="text-gray-400">Nothing below its reorder level.</li>
            )}
          </ul>
        </Panel>

        <Panel title="Stock accuracy" subtitle="Cycle counts vs the system">
          {summary.accuracy.accuracyPercent === null ? (
            <p className="text-xs text-gray-500">
              No location has been counted yet, so there is no accuracy figure to show. Count a few
              rows from the table (select them and use &ldquo;Mark counted&rdquo;, or adjust one to
              the figure on the shelf) and it starts here.
            </p>
          ) : (
            <>
              <p className="font-display text-2xl font-bold text-ink-900">
                {summary.accuracy.accuracyPercent}%
              </p>
              <p className="text-[11px] text-gray-400">of counted locations matched exactly</p>
            </>
          )}
          <dl className="mt-3 space-y-1.5 text-xs">
            {[
              ['Matched', summary.accuracy.matched, 'text-green-600'],
              ['Mismatched', summary.accuracy.mismatched, 'text-red-600'],
              ['Not counted', summary.accuracy.notCounted, 'text-gray-500'],
            ].map(([label, value, cls]) => (
              <div key={String(label)} className="flex justify-between">
                <dt className="text-gray-500">{label as string}</dt>
                <dd className={`font-semibold ${cls as string}`}>{num(value as number)}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel title="Recent stock movements">
          <ul className="space-y-2 text-xs">
            {summary.recentMovements.map((m) => (
              <li key={m.id} className="flex items-start gap-2">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${MOVEMENT_STYLES[m.type]}`}
                >
                  {m.typeLabel}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ink-900">{m.title}</p>
                  <p className="truncate text-[11px] text-gray-400">
                    {m.fromWarehouse ?? m.toWarehouse} · {when(m.createdAt)}
                  </p>
                </div>
                <span className="shrink-0 font-semibold text-ink-900">{num(m.quantity)}</span>
              </li>
            ))}
            {summary.recentMovements.length === 0 && (
              <li className="text-gray-400">No movements recorded yet.</li>
            )}
          </ul>
        </Panel>

        <Panel title="Inventory insights" subtitle="Read straight off the numbers above">
          <ul className="space-y-2.5 text-xs">
            {summary.insights.map((i) => (
              <li key={i.key}>
                <p className={`font-semibold ${TONE_STYLES[i.tone]}`}>● {i.title}</p>
                <p className="mt-0.5 text-[11px] text-gray-500">{i.detail}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {adjusting && (
        <AdjustModal
          row={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={async (message) => {
            setAdjusting(null);
            flash(message);
            await load();
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Stock / Receive — a receipt with no purchase order behind it
// ---------------------------------------------------------------------------

function AddStockModal({
  options,
  onClose,
  onDone,
}: {
  options: InventoryFilterOptions;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const activeWarehouses = options.warehouses.filter((w) => w.isActive);
  const [warehouseId, setWarehouseId] = useState(activeWarehouses[0]?.id ?? '');
  const [reason, setReason] = useState('Stock received from supplier');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<{ variant: VariantHit; quantity: number }[]>([]);
  const [openPos, setOpenPos] = useState<PurchaseOrderRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Receiving against a PO keeps the paperwork straight, so surface any that
  // are waiting rather than letting an admin double-book the same delivery.
  useEffect(() => {
    void (async () => {
      try {
        const all = await api<PurchaseOrderRow[]>('/api/admin/inventory/purchase-orders', {
          auth: true,
        });
        setOpenPos(all.filter((po) => ['ORDERED', 'PARTIAL'].includes(po.status)));
      } catch {
        setOpenPos([]);
      }
    })();
  }, []);

  const totalUnits = lines.reduce((sum, l) => sum + l.quantity, 0);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ units: number; warehouseName: string }>(
        '/api/admin/inventory/stock/receive',
        {
          method: 'POST',
          auth: true,
          body: {
            warehouseId,
            reason,
            reference,
            lines: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity })),
          },
        },
      );
      await onDone(`${num(result.units)} unit(s) received into ${result.warehouseName}.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not receive that stock.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add stock / receive" onClose={onClose} wide>
      {openPos.length > 0 && (
        <div className="rounded-xl border border-yellow-300 bg-yellow-50 px-3 py-2 text-[11px] text-yellow-800">
          {openPos.length} purchase order(s) are still open (
          {openPos
            .slice(0, 3)
            .map((po) => po.poNumber)
            .join(', ')}
          {openPos.length > 3 ? '…' : ''}). If this delivery is against one of them, receive it from
          the <strong>Purchase Orders</strong> tab instead so the PO closes out.
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Receive into</label>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className={`${inputClass} mt-1`}
          >
            {activeWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Reference (optional)</label>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Invoice or challan number"
            className={`${inputClass} mt-1`}
          />
        </div>
      </div>

      <div className="mt-3">
        <label className={labelClass}>Reason</label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${inputClass} mt-1`}
        />
      </div>

      <div className="mt-4">
        <label className={labelClass}>Add stock</label>
        <div className="mt-1">
          <VariantPicker
            warehouseId={warehouseId}
            onPick={(v) =>
              setLines((ls) =>
                ls.some((l) => l.variant.id === v.id) ? ls : [...ls, { variant: v, quantity: 1 }],
              )
            }
          />
        </div>
      </div>

      {lines.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-semibold">SKU</th>
              <th className="py-1 font-semibold">Product</th>
              <th className="py-1 text-right font-semibold">Here now</th>
              <th className="py-1 text-right font-semibold">Receiving</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.variant.id} className="border-t border-gray-100">
                <td className="py-1.5 font-mono text-brand-600">{l.variant.sku}</td>
                <td className="max-w-52 truncate py-1.5">
                  {l.variant.title}
                  <span className="text-gray-400">
                    {' '}
                    {[l.variant.size, l.variant.color].filter(Boolean).length ? ` · ${[l.variant.size, l.variant.color].filter(Boolean).join(' / ')}` : ''}
                  </span>
                </td>
                <td className="py-1.5 text-right text-gray-500">{num(l.variant.atWarehouse)}</td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    min={1}
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, quantity: Number(e.target.value) } : x,
                        ),
                      )
                    }
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-right"
                  />
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex items-center justify-end gap-3">
        <span className="text-xs text-gray-500">
          Receiving <strong className="text-ink-900">{num(totalUnits)}</strong> unit(s)
        </span>
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={
            busy ||
            lines.length === 0 ||
            !warehouseId ||
            reason.trim().length < 3 ||
            lines.some((l) => l.quantity < 1)
          }
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Receiving…' : 'Receive stock'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import Inventory — a CSV keyed by SKU + warehouse code
// ---------------------------------------------------------------------------

interface ParsedImportRow {
  line: number;
  sku: string;
  warehouseCode: string;
  quantity?: number;
  reorderLevel?: number;
  error?: string;
}

/** Minimal CSV reader: handles quoted cells and escaped double quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function ImportModal({
  options,
  onClose,
  onDone,
}: {
  options: InventoryFilterOptions;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<ParsedImportRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<ImportMode>('SET');
  const [reason, setReason] = useState('Inventory import');
  const [isCount, setIsCount] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InventoryImportResult | null>(null);

  const knownCodes = useMemo(
    () => new Set(options.warehouses.map((w) => w.code.toUpperCase())),
    [options.warehouses],
  );

  function readFile(file: File) {
    setError('');
    setResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const table = parseCsv(String(reader.result ?? ''));
      if (table.length < 2) {
        setError('That file has a header but no rows.');
        setRows(null);
        return;
      }
      const header = table[0]!.map((h) => h.trim().toLowerCase());
      const col = (name: string) => header.findIndex((h) => h === name.toLowerCase());
      const skuAt = col('sku');
      const whAt = col('warehouse code');
      const qtyAt = col('quantity');
      const reorderAt = col('reorder level');

      if (skuAt < 0 || whAt < 0) {
        setError(`The header must include ${IMPORT_COLUMNS.slice(0, 2).join(' and ')}.`);
        setRows(null);
        return;
      }

      const parsed: ParsedImportRow[] = table.slice(1).map((cells, i) => {
        const sku = (cells[skuAt] ?? '').trim();
        const warehouseCode = (cells[whAt] ?? '').trim().toUpperCase();
        const rawQty = qtyAt >= 0 ? (cells[qtyAt] ?? '').trim() : '';
        const rawReorder = reorderAt >= 0 ? (cells[reorderAt] ?? '').trim() : '';

        const row: ParsedImportRow = { line: i + 2, sku, warehouseCode };
        if (!sku) row.error = 'Missing SKU';
        else if (!warehouseCode) row.error = 'Missing warehouse code';
        else if (!knownCodes.has(warehouseCode)) row.error = `Unknown warehouse ${warehouseCode}`;

        if (rawQty) {
          if (!/^\d+$/.test(rawQty)) row.error ??= 'Quantity must be a whole number';
          else row.quantity = Number(rawQty);
        }
        if (rawReorder) {
          if (!/^\d+$/.test(rawReorder)) row.error ??= 'Reorder level must be a whole number';
          else row.reorderLevel = Number(rawReorder);
        }
        if (row.quantity === undefined && row.reorderLevel === undefined) {
          row.error ??= 'Nothing to change on this row';
        }
        return row;
      });
      setRows(parsed);
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const sample = options.warehouses[0]?.code ?? 'DEL-01';
    const csv = `${IMPORT_COLUMNS.join(',')}\nCLW-000001,${sample},120,10\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inventory-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const valid = (rows ?? []).filter((r) => !r.error);
  const invalid = (rows ?? []).filter((r) => r.error);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const body = await api<InventoryImportResult>('/api/admin/inventory/stock/import', {
        method: 'POST',
        auth: true,
        body: {
          mode,
          reason,
          isCount,
          rows: valid.map((r) => ({
            sku: r.sku,
            warehouseCode: r.warehouseCode,
            ...(r.quantity !== undefined ? { quantity: r.quantity } : {}),
            ...(r.reorderLevel !== undefined ? { reorderLevel: r.reorderLevel } : {}),
          })),
        },
      });
      setResult(body);
      if (body.skipped.length === 0) {
        await onDone(
          `${num(body.applied)} row(s) imported — ${num(body.quantityChanged)} stock change(s), ${num(body.reorderChanged)} reorder level(s).`,
        );
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Import inventory" onClose={onClose} wide>
      <p className="text-xs text-gray-500">
        A CSV with the columns <strong>{IMPORT_COLUMNS.join(', ')}</strong>. Rows are matched on SKU
        plus warehouse code. Every change is written to the movement ledger with your reason, the
        same as a manual adjustment — nothing is applied silently.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) readFile(file);
          }}
          className="text-xs"
        />
        <button
          onClick={downloadTemplate}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
        >
          Download template
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      {rows && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>How to apply the quantity</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as ImportMode)}
                className={`${inputClass} mt-1`}
              >
                {IMPORT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {IMPORT_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Reason</label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={`${inputClass} mt-1`}
              />
            </div>
          </div>

          <label className="mt-3 flex items-start gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={isCount}
              onChange={(e) => setIsCount(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              This sheet is a physical count — record it against stock accuracy. Untick if it is a
              correction rather than a shelf check.
            </span>
          </label>

          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-cream-100 px-2.5 py-1 font-semibold text-ink-900">
              {fileName}
            </span>
            <span className="rounded-full bg-green-100 px-2.5 py-1 font-semibold text-green-700">
              {num(valid.length)} ready
            </span>
            {invalid.length > 0 && (
              <span className="rounded-full bg-red-100 px-2.5 py-1 font-semibold text-red-700">
                {num(invalid.length)} will be skipped
              </span>
            )}
          </div>

          <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-gray-500">
                  <th className="px-2 py-1.5 font-semibold">Line</th>
                  <th className="px-2 py-1.5 font-semibold">SKU</th>
                  <th className="px-2 py-1.5 font-semibold">Warehouse</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Quantity</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Reorder</th>
                  <th className="px-2 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.line} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-400">{r.line}</td>
                    <td className="px-2 py-1 font-mono text-brand-600">{r.sku || '—'}</td>
                    <td className="px-2 py-1 text-gray-600">{r.warehouseCode || '—'}</td>
                    <td className="px-2 py-1 text-right">
                      {r.quantity === undefined ? '—' : num(r.quantity)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {r.reorderLevel === undefined ? '—' : num(r.reorderLevel)}
                    </td>
                    <td className="px-2 py-1">
                      {r.error ? (
                        <span className="text-red-600">{r.error}</span>
                      ) : (
                        <span className="text-green-600">Ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 200 && (
              <p className="px-2 py-1.5 text-[11px] text-gray-400">
                Showing the first 200 of {num(rows.length)} rows — all of them will be imported.
              </p>
            )}
          </div>
        </>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-cream-50 p-3 text-xs">
          <p className="font-semibold text-ink-900">
            {num(result.applied)} row(s) applied · {num(result.quantityChanged)} stock change(s) ·{' '}
            {num(result.reorderChanged)} reorder level(s)
          </p>
          {result.skipped.length > 0 && (
            <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-red-600">
              {result.skipped.map((s) => (
                <li key={`${s.row}-${s.sku}`}>
                  Row {s.row} ({s.sku}): {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          {result ? 'Close' : 'Cancel'}
        </button>
        <button
          disabled={busy || valid.length === 0 || reason.trim().length < 3 || Boolean(result)}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Importing…' : `Import ${num(valid.length)} row(s)`}
        </button>
      </div>
    </Modal>
  );
}

function AdjustModal({
  row,
  onClose,
  onDone,
}: {
  row: InventoryStockRow;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(row.available));
  const [reorderLevel, setReorderLevel] = useState(String(row.reorderLevel));
  const [reason, setReason] = useState('');
  const [isCount, setIsCount] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const delta = Number(quantity) - row.available;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (Number(reorderLevel) !== row.reorderLevel) {
        await api('/api/admin/inventory/stock/reorder-level', {
          method: 'PATCH',
          auth: true,
          body: { locationId: row.locationId, reorderLevel: Number(reorderLevel) },
        });
      }
      if (delta !== 0) {
        await api('/api/admin/inventory/stock/adjust', {
          method: 'POST',
          auth: true,
          body: {
            locationId: row.locationId,
            newQuantity: Number(quantity),
            reason,
            isCount,
          },
        });
      }
      await onDone(
        delta === 0
          ? `Reorder level for ${row.sku} updated.`
          : `${row.sku} adjusted by ${delta > 0 ? '+' : ''}${delta} at ${row.warehouseName}.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Adjust ${row.sku}`} onClose={onClose}>
      <p className="text-xs text-gray-500">
        {row.title}{row.label ? ` · ` : ''} · <strong>{row.warehouseName}</strong>
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Counted quantity</label>
          <input
            type="number"
            min={0}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={`${inputClass} mt-1`}
          />
          <p className="mt-1 text-[11px] text-gray-400">
            System says {num(row.available)}.{' '}
            {delta !== 0 && (
              <span className={delta > 0 ? 'text-green-600' : 'text-red-600'}>
                {delta > 0 ? '+' : ''}
                {delta} difference
              </span>
            )}
          </p>
        </div>
        <div>
          <label className={labelClass}>Reorder level</label>
          <input
            type="number"
            min={0}
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
            className={`${inputClass} mt-1`}
          />
          <p className="mt-1 text-[11px] text-gray-400">Low-stock alerts fire at or below this.</p>
        </div>
      </div>

      {delta !== 0 && (
        <>
          <div className="mt-3">
            <label className={labelClass}>Reason</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Cycle count — 3 units damaged in transit"
              className={`${inputClass} mt-1`}
            />
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={isCount}
              onChange={(e) => setIsCount(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              This came from a physical count — record it against stock accuracy. Leave unticked for
              a correction that was not a shelf check.
            </span>
          </label>
        </>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={busy || (delta !== 0 && reason.trim().length < 3)}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Warehouses tab
// ---------------------------------------------------------------------------

const EMPTY_WAREHOUSE = {
  code: '',
  name: '',
  city: '',
  state: '',
  pincode: '',
  addressLine: '',
  contactName: '',
  contactPhone: '',
  isActive: true,
  isDefault: false,
};

function WarehousesTab({
  onChanged,
  flash,
}: {
  onChanged: () => Promise<void>;
  flash: (m: string) => void;
}) {
  const [rows, setRows] = useState<WarehouseRow[] | null>(null);
  const [editing, setEditing] = useState<WarehouseRow | 'NEW' | null>(null);
  const [transfers, setTransfers] = useState<TransferRow[] | null>(null);
  const [creatingTransfer, setCreatingTransfer] = useState(false);

  const load = useCallback(async () => {
    const [w, t] = await Promise.all([
      api<WarehouseRow[]>('/api/admin/inventory/warehouses', { auth: true }),
      api<TransferRow[]>('/api/admin/inventory/transfers', { auth: true }),
    ]);
    setRows(w);
    setTransfers(t);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setTransferStatus(id: string, status: string) {
    try {
      await api(`/api/admin/inventory/transfers/${id}/status`, {
        method: 'PATCH',
        auth: true,
        body: { status },
      });
      flash(status === 'COMPLETED' ? 'Transfer completed — stock moved.' : 'Transfer updated.');
      await load();
      await onChanged();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not update the transfer.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-ink-900">Warehouses</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setCreatingTransfer(true)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            🔁 Create stock transfer
          </button>
          <button
            onClick={() => setEditing('NEW')}
            className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white"
          >
            + Add warehouse
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(rows ?? []).map((w) => (
          <div key={w.id} className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink-900">{w.name}</p>
                <p className="truncate text-[11px] text-gray-400">
                  {w.code} · {w.city}, {w.state}
                  {w.pincode ? ` — ${w.pincode}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    w.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {w.isActive ? 'Active' : 'Inactive'}
                </span>
                {w.isDefault && (
                  <span className="rounded-full bg-cream-100 px-2 py-0.5 text-[10px] font-semibold text-brand-600">
                    Default
                  </span>
                )}
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              {[
                ['SKUs', num(w.skus)],
                ['Units', num(w.units)],
                ['Value', formatPaise(w.valuePaise)],
                ['Low stock', num(w.lowStockCount)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-cream-50 px-2.5 py-1.5">
                  <dt className="text-[10px] text-gray-500">{label}</dt>
                  <dd className="font-semibold text-ink-900">{value}</dd>
                </div>
              ))}
            </dl>

            {w.contactName && (
              <p className="mt-2 text-[11px] text-gray-500">
                {w.contactName}
                {w.contactPhone ? ` · +91 ${w.contactPhone}` : ''}
              </p>
            )}

            <button
              onClick={() => setEditing(w)}
              className="mt-3 w-full rounded-lg border border-gray-300 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
          </div>
        ))}
        {rows?.length === 0 && (
          <p className="text-sm text-gray-500">No warehouses yet — add the first one.</p>
        )}
      </div>

      <Panel title="Stock transfers" subtitle="Stock only moves when a transfer is completed">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[660px] text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2 font-semibold">Transfer</th>
                <th className="px-3 py-2 font-semibold">Route</th>
                <th className="px-3 py-2 text-right font-semibold">Units</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Raised</th>
                <th className="px-3 py-2 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {(transfers ?? []).map((t) => (
                <tr key={t.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono text-brand-600">{t.transferNumber}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {t.fromWarehouse} → {t.toWarehouse}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">{num(t.totalUnits)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        t.status === 'COMPLETED'
                          ? 'bg-green-100 text-green-700'
                          : t.status === 'IN_TRANSIT'
                            ? 'bg-blue-100 text-blue-700'
                            : t.status === 'PENDING'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {t.statusLabel}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">{when(t.createdAt)}</td>
                  <td className="px-3 py-2">
                    {t.status === 'PENDING' && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => void setTransferStatus(t.id, 'IN_TRANSIT')}
                          className="rounded-lg border border-gray-300 px-2 py-1 font-semibold hover:bg-gray-50"
                        >
                          Dispatch
                        </button>
                        <button
                          onClick={() => void setTransferStatus(t.id, 'CANCELLED')}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-gray-500 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {t.status === 'IN_TRANSIT' && (
                      <button
                        onClick={() => void setTransferStatus(t.id, 'COMPLETED')}
                        className="rounded-lg bg-brand-600 px-2 py-1 font-semibold text-white"
                      >
                        Mark received
                      </button>
                    )}
                    {['COMPLETED', 'CANCELLED'].includes(t.status) && (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {transfers?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No transfers raised yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {editing && (
        <WarehouseModal
          warehouse={editing === 'NEW' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={async (message) => {
            setEditing(null);
            flash(message);
            await load();
            await onChanged();
          }}
        />
      )}
      {creatingTransfer && rows && (
        <TransferModal
          warehouses={rows.filter((w) => w.isActive)}
          onClose={() => setCreatingTransfer(false)}
          onDone={async (message) => {
            setCreatingTransfer(false);
            flash(message);
            await load();
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function WarehouseModal({
  warehouse,
  onClose,
  onDone,
}: {
  warehouse: WarehouseRow | null;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [form, setForm] = useState(
    warehouse
      ? {
          code: warehouse.code,
          name: warehouse.name,
          city: warehouse.city,
          state: warehouse.state,
          pincode: warehouse.pincode ?? '',
          addressLine: warehouse.addressLine ?? '',
          contactName: warehouse.contactName ?? '',
          contactPhone: warehouse.contactPhone ?? '',
          isActive: warehouse.isActive,
          isDefault: warehouse.isDefault,
        }
      : EMPTY_WAREHOUSE,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (warehouse) {
        await api(`/api/admin/inventory/warehouses/${warehouse.id}`, {
          method: 'PATCH',
          auth: true,
          body: form,
        });
      } else {
        await api('/api/admin/inventory/warehouses', { method: 'POST', auth: true, body: form });
      }
      await onDone(warehouse ? `${form.name} updated.` : `${form.name} added.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the warehouse.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={warehouse ? `Edit ${warehouse.name}` : 'Add warehouse'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Code</label>
          <input
            value={form.code}
            onChange={(e) => set('code', e.target.value.toUpperCase())}
            placeholder="DEL-02"
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass}>Name</label>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Delhi Warehouse 2"
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass}>City</label>
          <input
            value={form.city}
            onChange={(e) => set('city', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass}>State</label>
          <input
            value={form.state}
            onChange={(e) => set('state', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass}>Pincode</label>
          <input
            value={form.pincode}
            onChange={(e) => set('pincode', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass}>Contact phone</label>
          <input
            value={form.contactPhone}
            onChange={(e) => set('contactPhone', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Address</label>
          <input
            value={form.addressLine}
            onChange={(e) => set('addressLine', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Contact name</label>
          <input
            value={form.contactName}
            onChange={(e) => set('contactName', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
      </div>

      <div className="mt-3 space-y-2 text-xs text-gray-600">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => set('isActive', e.target.checked)}
          />
          Active — can receive and dispatch stock
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => set('isDefault', e.target.checked)}
          />
          Default — where seller stock increases land
        </label>
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={busy || !form.code || !form.name || !form.city || !form.state}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Variant picker — shared by transfers and purchase orders
// ---------------------------------------------------------------------------

interface VariantHit {
  id: string;
  sku: string;
  title: string;
  size: string;
  color: string;
  pricePaise: number;
  totalStock: number;
  atWarehouse: number;
}

function VariantPicker({
  warehouseId,
  onPick,
}: {
  warehouseId?: string;
  onPick: (v: VariantHit) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<VariantHit[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ q: q.trim() });
      if (warehouseId) params.set('warehouseId', warehouseId);
      try {
        setHits(
          await api<VariantHit[]>(`/api/admin/inventory/meta/variants?${params}`, { auth: true }),
        );
      } catch {
        setHits([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, warehouseId]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search a SKU or product to add…"
        className={inputClass}
      />
      {hits.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                onClick={() => {
                  onPick(h);
                  setQ('');
                  setHits([]);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-cream-50"
              >
                <span className="min-w-0">
                  <span className="font-mono text-brand-600">{h.sku}</span>{' '}
                  <span className="text-ink-900">{h.title}</span>
                  <span className="text-gray-400">
                    {' '}
                    {[h.size, h.color].filter(Boolean).length ? ` · ${[h.size, h.color].filter(Boolean).join(' / ')}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-gray-500">
                  {warehouseId ? `${h.atWarehouse} here` : `${h.totalStock} total`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TransferModal({
  warehouses,
  onClose,
  onDone,
}: {
  warehouses: WarehouseRow[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [fromWarehouseId, setFrom] = useState(warehouses[0]?.id ?? '');
  const [toWarehouseId, setTo] = useState(warehouses[1]?.id ?? '');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ variant: VariantHit; quantity: number }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const created = await api<{ transferNumber: string }>('/api/admin/inventory/transfers', {
        method: 'POST',
        auth: true,
        body: {
          fromWarehouseId,
          toWarehouseId,
          notes,
          items: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity })),
        },
      });
      await onDone(`${created.transferNumber} raised — dispatch it when the stock leaves.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not raise the transfer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create stock transfer" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>From</label>
          <select
            value={fromWarehouseId}
            onChange={(e) => setFrom(e.target.value)}
            className={`${inputClass} mt-1`}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>To</label>
          <select
            value={toWarehouseId}
            onChange={(e) => setTo(e.target.value)}
            className={`${inputClass} mt-1`}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4">
        <label className={labelClass}>Add stock</label>
        <div className="mt-1">
          <VariantPicker
            warehouseId={fromWarehouseId}
            onPick={(v) =>
              setLines((ls) =>
                ls.some((l) => l.variant.id === v.id) ? ls : [...ls, { variant: v, quantity: 1 }],
              )
            }
          />
        </div>
      </div>

      {lines.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-semibold">SKU</th>
              <th className="py-1 font-semibold">Product</th>
              <th className="py-1 text-right font-semibold">At source</th>
              <th className="py-1 text-right font-semibold">Move</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.variant.id} className="border-t border-gray-100">
                <td className="py-1.5 font-mono text-brand-600">{l.variant.sku}</td>
                <td className="max-w-48 truncate py-1.5">{l.variant.title}</td>
                <td className="py-1.5 text-right text-gray-500">{num(l.variant.atWarehouse)}</td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    min={1}
                    max={l.variant.atWarehouse}
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, quantity: Number(e.target.value) } : x,
                        ),
                      )
                    }
                    className="w-20 rounded border border-gray-300 px-2 py-1 text-right"
                  />
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3">
        <label className={labelClass}>Notes</label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={`${inputClass} mt-1`}
        />
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={
            busy ||
            lines.length === 0 ||
            fromWarehouseId === toWarehouseId ||
            lines.some((l) => l.quantity < 1 || l.quantity > l.variant.atWarehouse)
          }
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Raising…' : 'Raise transfer'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Movements tab
// ---------------------------------------------------------------------------

function MovementsTab({ options }: { options: InventoryFilterOptions }) {
  const [page, setPage] = useState<MovementPage | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState<'ALL' | MovementType>('ALL');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pageNo, setPageNo] = useState(1);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ type, page: String(pageNo), pageSize: '25' });
    if (q.trim()) params.set('q', q.trim());
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    setPage(await api<MovementPage>(`/api/admin/inventory/movements?${params}`, { auth: true }));
  }, [q, type, warehouseId, from, to, pageNo]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPageNo(1);
  }, [q, type, warehouseId, from, to]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search SKU or product…"
          className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as 'ALL' | MovementType)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="ALL">All movement types</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {MOVEMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          <option value="">All warehouses</option>
          {options.warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        />
      </div>

      <section className="rounded-2xl border border-gray-100 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2.5 font-semibold">Type</th>
                <th className="px-3 py-2.5 font-semibold">SKU</th>
                <th className="px-3 py-2.5 font-semibold">Product</th>
                <th className="px-3 py-2.5 text-right font-semibold">Qty</th>
                <th className="px-3 py-2.5 font-semibold">From</th>
                <th className="px-3 py-2.5 font-semibold">To</th>
                <th className="px-3 py-2.5 font-semibold">Reason</th>
                <th className="px-3 py-2.5 font-semibold">Reference</th>
                <th className="px-3 py-2.5 font-semibold">By</th>
                <th className="px-3 py-2.5 font-semibold">When</th>
              </tr>
            </thead>
            <tbody>
              {(page?.rows ?? []).map((m) => (
                <tr key={m.id} className="border-t border-gray-100 hover:bg-cream-50">
                  <td className="px-3 py-2.5">
                    <span
                      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${MOVEMENT_STYLES[m.type]}`}
                    >
                      {m.typeLabel}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-brand-600">{m.sku}</td>
                  <td className="max-w-52 truncate px-3 py-2.5 text-ink-900">{m.title}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">{num(m.quantity)}</td>
                  <td className="px-3 py-2.5 text-gray-600">{m.fromWarehouse ?? '—'}</td>
                  <td className="px-3 py-2.5 text-gray-600">{m.toWarehouse ?? '—'}</td>
                  <td className="max-w-44 truncate px-3 py-2.5 text-gray-500">{m.reason ?? '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-500">{m.reference ?? '—'}</td>
                  <td className="px-3 py-2.5 text-gray-500">{m.actorName ?? 'System'}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                    {when(m.createdAt)}
                  </td>
                </tr>
              ))}
              {page?.rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
                    No movements match those filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {page && (
          <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
            <span>{num(page.total)} movements</span>
            <div className="flex items-center gap-2">
              <button
                disabled={page.page <= 1}
                onClick={() => setPageNo(page.page - 1)}
                className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
              >
                ‹
              </button>
              <span className="font-semibold text-ink-900">
                {page.page} / {page.totalPages}
              </span>
              <button
                disabled={page.page >= page.totalPages}
                onClick={() => setPageNo(page.page + 1)}
                className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adjustments tab — the ledger, narrowed to manual corrections
// ---------------------------------------------------------------------------

function AdjustmentsTab() {
  const [page, setPage] = useState<MovementPage | null>(null);
  const [pageNo, setPageNo] = useState(1);

  useEffect(() => {
    void (async () => {
      setPage(
        await api<MovementPage>(
          `/api/admin/inventory/movements?type=ADJUSTMENT&page=${pageNo}&pageSize=25`,
          { auth: true },
        ),
      );
    })();
  }, [pageNo]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Every manual correction, with who made it and why. Adjustments are made from the Inventory
        Overview tab — pick a row and use <strong>Adjust</strong>.
      </p>
      <section className="rounded-2xl border border-gray-100 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2.5 font-semibold">SKU</th>
                <th className="px-3 py-2.5 font-semibold">Product</th>
                <th className="px-3 py-2.5 font-semibold">Warehouse</th>
                <th className="px-3 py-2.5 text-right font-semibold">Change</th>
                <th className="px-3 py-2.5 font-semibold">Reason</th>
                <th className="px-3 py-2.5 font-semibold">By</th>
                <th className="px-3 py-2.5 font-semibold">When</th>
              </tr>
            </thead>
            <tbody>
              {(page?.rows ?? []).map((m) => {
                // An adjustment that added stock names the destination; one that
                // removed stock names the source.
                const added = Boolean(m.toWarehouse);
                return (
                  <tr key={m.id} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5 font-mono text-brand-600">{m.sku}</td>
                    <td className="max-w-52 truncate px-3 py-2.5 text-ink-900">{m.title}</td>
                    <td className="px-3 py-2.5 text-gray-600">
                      {m.toWarehouse ?? m.fromWarehouse ?? '—'}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-semibold ${added ? 'text-green-600' : 'text-red-600'}`}
                    >
                      {added ? '+' : '−'}
                      {num(m.quantity)}
                    </td>
                    <td className="max-w-64 truncate px-3 py-2.5 text-gray-500">
                      {m.reason ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-gray-500">{m.actorName ?? 'System'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                      {when(m.createdAt)}
                    </td>
                  </tr>
                );
              })}
              {page?.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                    No adjustments recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {page && page.totalPages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-4 py-3 text-xs">
            <button
              disabled={page.page <= 1}
              onClick={() => setPageNo(page.page - 1)}
              className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
            >
              ‹
            </button>
            <span className="font-semibold text-ink-900">
              {page.page} / {page.totalPages}
            </span>
            <button
              disabled={page.page >= page.totalPages}
              onClick={() => setPageNo(page.page + 1)}
              className="rounded-lg border border-gray-300 px-2.5 py-1 disabled:opacity-40"
            >
              ›
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suppliers tab
// ---------------------------------------------------------------------------

const EMPTY_SUPPLIER = {
  code: '',
  name: '',
  contactName: '',
  email: '',
  phone: '',
  city: '',
  state: '',
  gstin: '',
  notes: '',
  isActive: true,
};

function SuppliersTab({ flash }: { flash: (m: string) => void }) {
  const [rows, setRows] = useState<SupplierRow[] | null>(null);
  const [editing, setEditing] = useState<SupplierRow | 'NEW' | null>(null);

  const load = useCallback(async () => {
    setRows(await api<SupplierRow[]>('/api/admin/inventory/suppliers', { auth: true }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-ink-900">Suppliers</h2>
        <button
          onClick={() => setEditing('NEW')}
          className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white"
        >
          + Add supplier
        </button>
      </div>

      <section className="rounded-2xl border border-gray-100 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2.5 font-semibold">Code</th>
                <th className="px-3 py-2.5 font-semibold">Supplier</th>
                <th className="px-3 py-2.5 font-semibold">Contact</th>
                <th className="px-3 py-2.5 font-semibold">Location</th>
                <th className="px-3 py-2.5 text-right font-semibold">POs</th>
                <th className="px-3 py-2.5 text-right font-semibold">Units received</th>
                <th className="px-3 py-2.5 text-right font-semibold">Spend</th>
                <th className="px-3 py-2.5 font-semibold">Last order</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((s) => (
                <tr key={s.id} className="border-t border-gray-100 hover:bg-cream-50">
                  <td className="px-3 py-2.5 font-mono text-brand-600">{s.code}</td>
                  <td className="px-3 py-2.5 font-medium text-ink-900">{s.name}</td>
                  <td className="px-3 py-2.5 text-gray-600">
                    {s.contactName ?? '—'}
                    {s.phone && (
                      <span className="block text-[11px] text-gray-400">+91 {s.phone}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">
                    {[s.city, s.state].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">{num(s.purchaseOrders)}</td>
                  <td className="px-3 py-2.5 text-right">{num(s.unitsSupplied)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">
                    {formatPaise(s.spendPaise)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                    {s.lastOrderAt ? when(s.lastOrderAt) : '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        s.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {s.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => setEditing(s)}
                      className="rounded-lg border border-gray-300 px-2 py-1 font-semibold hover:bg-gray-50"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
                    No suppliers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <SupplierModal
          supplier={editing === 'NEW' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={async (message) => {
            setEditing(null);
            flash(message);
            await load();
          }}
        />
      )}
    </div>
  );
}

function SupplierModal({
  supplier,
  onClose,
  onDone,
}: {
  supplier: SupplierRow | null;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [form, setForm] = useState(
    supplier
      ? {
          code: supplier.code,
          name: supplier.name,
          contactName: supplier.contactName ?? '',
          email: supplier.email ?? '',
          phone: supplier.phone ?? '',
          city: supplier.city ?? '',
          state: supplier.state ?? '',
          gstin: supplier.gstin ?? '',
          notes: supplier.notes ?? '',
          isActive: supplier.isActive,
        }
      : EMPTY_SUPPLIER,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (supplier) {
        await api(`/api/admin/inventory/suppliers/${supplier.id}`, {
          method: 'PATCH',
          auth: true,
          body: form,
        });
      } else {
        await api('/api/admin/inventory/suppliers', { method: 'POST', auth: true, body: form });
      }
      await onDone(supplier ? `${form.name} updated.` : `${form.name} added.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the supplier.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={supplier ? `Edit ${supplier.name}` : 'Add supplier'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            ['code', 'Code', 'SUP-006'],
            ['name', 'Name', 'Tirupur Knit Exports'],
            ['contactName', 'Contact name', ''],
            ['phone', 'Phone', '9876543210'],
            ['email', 'Email', ''],
            ['gstin', 'GSTIN', ''],
            ['city', 'City', ''],
            ['state', 'State', ''],
          ] as const
        ).map(([key, label, placeholder]) => (
          <div key={key}>
            <label className={labelClass}>{label}</label>
            <input
              value={form[key]}
              onChange={(e) =>
                set(key, key === 'code' ? e.target.value.toUpperCase() : e.target.value)
              }
              placeholder={placeholder}
              className={`${inputClass} mt-1`}
            />
          </div>
        ))}
        <div className="col-span-2">
          <label className={labelClass}>Notes</label>
          <input
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(e) => set('isActive', e.target.checked)}
        />
        Active — can be picked on a new purchase order
      </label>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={busy || !form.code || !form.name}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Purchase orders tab
// ---------------------------------------------------------------------------

function PurchaseOrdersTab({
  options,
  onChanged,
  flash,
}: {
  options: InventoryFilterOptions;
  onChanged: () => Promise<void>;
  flash: (m: string) => void;
}) {
  const [rows, setRows] = useState<PurchaseOrderRow[] | null>(null);
  const [status, setStatus] = useState('ALL');
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrderRow | null>(null);

  const load = useCallback(async () => {
    setRows(
      await api<PurchaseOrderRow[]>(`/api/admin/inventory/purchase-orders?status=${status}`, {
        auth: true,
      }),
    );
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(po: PurchaseOrderRow) {
    if (!window.confirm(`Cancel ${po.poNumber}?`)) return;
    try {
      await api(`/api/admin/inventory/purchase-orders/${po.id}/status`, {
        method: 'PATCH',
        auth: true,
        body: { status: 'CANCELLED' },
      });
      flash(`${po.poNumber} cancelled.`);
      await load();
      await onChanged();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not cancel that PO.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-xs"
        >
          {['ALL', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>
              {s === 'ALL' ? 'All purchase orders' : s}
            </option>
          ))}
        </select>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white"
        >
          + Create purchase order
        </button>
      </div>

      <section className="rounded-2xl border border-gray-100 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2.5 font-semibold">PO</th>
                <th className="px-3 py-2.5 font-semibold">Supplier</th>
                <th className="px-3 py-2.5 font-semibold">Destination</th>
                <th className="px-3 py-2.5 text-right font-semibold">Received / ordered</th>
                <th className="px-3 py-2.5 text-right font-semibold">Cost</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Raised</th>
                <th className="px-3 py-2.5 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((po) => (
                <tr key={po.id} className="border-t border-gray-100 hover:bg-cream-50">
                  <td className="px-3 py-2.5 font-mono text-brand-600">{po.poNumber}</td>
                  <td className="px-3 py-2.5 text-ink-900">{po.supplierName}</td>
                  <td className="px-3 py-2.5 text-gray-600">{po.warehouseName}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className="font-semibold text-ink-900">{num(po.receivedUnits)}</span>
                    <span className="text-gray-400"> / {num(po.totalUnits)}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold">
                    {formatPaise(po.totalCostPaise)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        po.status === 'RECEIVED'
                          ? 'bg-green-100 text-green-700'
                          : po.status === 'PARTIAL'
                            ? 'bg-yellow-100 text-yellow-800'
                            : po.status === 'ORDERED'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {po.statusLabel}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                    {when(po.createdAt)}
                  </td>
                  <td className="px-3 py-2.5">
                    {['ORDERED', 'PARTIAL'].includes(po.status) ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => setReceiving(po)}
                          className="rounded-lg bg-brand-600 px-2 py-1 font-semibold text-white"
                        >
                          Receive
                        </button>
                        {po.receivedUnits === 0 && (
                          <button
                            onClick={() => void cancel(po)}
                            className="rounded-lg border border-gray-300 px-2 py-1 text-gray-500 hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                    No purchase orders yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {creating && (
        <PurchaseOrderModal
          options={options}
          onClose={() => setCreating(false)}
          onDone={async (message) => {
            setCreating(false);
            flash(message);
            await load();
            await onChanged();
          }}
        />
      )}
      {receiving && (
        <ReceiveModal
          po={receiving}
          onClose={() => setReceiving(null)}
          onDone={async (message) => {
            setReceiving(null);
            flash(message);
            await load();
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function PurchaseOrderModal({
  options,
  onClose,
  onDone,
}: {
  options: InventoryFilterOptions;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const activeWarehouses = options.warehouses.filter((w) => w.isActive);
  const [supplierId, setSupplierId] = useState(options.suppliers[0]?.id ?? '');
  const [warehouseId, setWarehouseId] = useState(activeWarehouses[0]?.id ?? '');
  const [expectedAt, setExpectedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<
    { variant: VariantHit; quantityOrdered: number; unitCostPaise: number }[]
  >([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const total = lines.reduce((sum, l) => sum + l.quantityOrdered * l.unitCostPaise, 0);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const created = await api<{ poNumber: string }>('/api/admin/inventory/purchase-orders', {
        method: 'POST',
        auth: true,
        body: {
          supplierId,
          warehouseId,
          expectedAt: expectedAt ? new Date(expectedAt).toISOString() : '',
          notes,
          items: lines.map((l) => ({
            variantId: l.variant.id,
            quantityOrdered: l.quantityOrdered,
            unitCostPaise: l.unitCostPaise,
          })),
        },
      });
      await onDone(`${created.poNumber} raised — the units now show as incoming.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not raise the PO.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create purchase order" onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Supplier</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className={`${inputClass} mt-1`}
          >
            {options.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Deliver to</label>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className={`${inputClass} mt-1`}
          >
            {activeWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Expected</label>
          <input
            type="date"
            value={expectedAt}
            onChange={(e) => setExpectedAt(e.target.value)}
            className={`${inputClass} mt-1`}
          />
        </div>
      </div>

      <div className="mt-4">
        <label className={labelClass}>Add lines</label>
        <div className="mt-1">
          <VariantPicker
            onPick={(v) =>
              setLines((ls) =>
                ls.some((l) => l.variant.id === v.id)
                  ? ls
                  : [...ls, { variant: v, quantityOrdered: 10, unitCostPaise: v.pricePaise }],
              )
            }
          />
        </div>
      </div>

      {lines.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-semibold">SKU</th>
              <th className="py-1 font-semibold">Product</th>
              <th className="py-1 text-right font-semibold">Qty</th>
              <th className="py-1 text-right font-semibold">Unit cost (₹)</th>
              <th className="py-1 text-right font-semibold">Line total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.variant.id} className="border-t border-gray-100">
                <td className="py-1.5 font-mono text-brand-600">{l.variant.sku}</td>
                <td className="max-w-44 truncate py-1.5">{l.variant.title}</td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    min={1}
                    value={l.quantityOrdered}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, quantityOrdered: Number(e.target.value) } : x,
                        ),
                      )
                    }
                    className="w-20 rounded border border-gray-300 px-2 py-1 text-right"
                  />
                </td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    min={0}
                    value={Math.round(l.unitCostPaise / 100)}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, unitCostPaise: Number(e.target.value) * 100 } : x,
                        ),
                      )
                    }
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-right"
                  />
                </td>
                <td className="py-1.5 text-right font-semibold">
                  {formatPaise(l.quantityOrdered * l.unitCostPaise)}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            <tr className="border-t border-gray-200">
              <td colSpan={4} className="py-2 text-right font-semibold text-gray-500">
                Total
              </td>
              <td className="py-2 text-right font-display font-bold text-ink-900">
                {formatPaise(total)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-3">
        <label className={labelClass}>Notes</label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={`${inputClass} mt-1`}
        />
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={busy || lines.length === 0 || !supplierId || !warehouseId}
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Raising…' : 'Raise PO'}
        </button>
      </div>
    </Modal>
  );
}

function ReceiveModal({
  po,
  onClose,
  onDone,
}: {
  po: PurchaseOrderRow;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      po.items.map((i) => [i.id, Math.max(0, i.quantityOrdered - i.quantityReceived)]),
    ),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const totalReceiving = Object.values(quantities).reduce((sum, q) => sum + (q || 0), 0);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/admin/inventory/purchase-orders/${po.id}/receive`, {
        method: 'POST',
        auth: true,
        body: {
          lines: po.items.map((i) => ({ itemId: i.id, quantity: quantities[i.id] ?? 0 })),
        },
      });
      await onDone(`${num(totalReceiving)} unit(s) received into ${po.warehouseName}.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not receive that stock.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Receive ${po.poNumber}`} onClose={onClose} wide>
      <p className="text-xs text-gray-500">
        {po.supplierName} → <strong>{po.warehouseName}</strong>. Received units go straight onto the
        shelf and appear in the movement ledger.
      </p>

      <table className="mt-4 w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="py-1 font-semibold">SKU</th>
            <th className="py-1 font-semibold">Product</th>
            <th className="py-1 text-right font-semibold">Ordered</th>
            <th className="py-1 text-right font-semibold">Already in</th>
            <th className="py-1 text-right font-semibold">Receiving now</th>
          </tr>
        </thead>
        <tbody>
          {po.items.map((i) => {
            const outstanding = i.quantityOrdered - i.quantityReceived;
            return (
              <tr key={i.id} className="border-t border-gray-100">
                <td className="py-1.5 font-mono text-brand-600">{i.sku}</td>
                <td className="max-w-52 truncate py-1.5">
                  {i.title}
                  <span className="text-gray-400">
                    {' '}
                    {[i.size, i.color].filter(Boolean).length ? ` · ${[i.size, i.color].filter(Boolean).join(' / ')}` : ''}
                  </span>
                </td>
                <td className="py-1.5 text-right">{num(i.quantityOrdered)}</td>
                <td className="py-1.5 text-right text-gray-500">{num(i.quantityReceived)}</td>
                <td className="py-1.5 text-right">
                  <input
                    type="number"
                    min={0}
                    max={outstanding}
                    value={quantities[i.id] ?? 0}
                    onChange={(e) =>
                      setQuantities((q) => ({ ...q, [i.id]: Number(e.target.value) }))
                    }
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-right"
                  />
                  <p className="text-[10px] text-gray-400">{num(outstanding)} outstanding</p>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <div className="mt-5 flex items-center justify-end gap-3">
        <span className="text-xs text-gray-500">
          Receiving <strong className="text-ink-900">{num(totalReceiving)}</strong> unit(s)
        </span>
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          disabled={
            busy ||
            totalReceiving <= 0 ||
            po.items.some((i) => (quantities[i.id] ?? 0) > i.quantityOrdered - i.quantityReceived)
          }
          onClick={() => void submit()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Receiving…' : 'Receive stock'}
        </button>
      </div>
    </Modal>
  );
}
