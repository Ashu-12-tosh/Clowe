'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_VARIANT_AXES,
  SHIPPING_LIMITS,
  SHIPPING_TEMPLATES,
  SHIPPING_TEMPLATE_LABELS,
  VOLUMETRIC_DIVISOR,
  axisLabel,
  billedWeightGrams,
  oversizedBox,
  parcelProblems,
  volumetricWeightGrams,
  describeTaxDefault,
  optionsKeyOf,
  sellerProductUpsertSchema,
  type CategoryNode,
  type CategoryRules,
  type GstSettings,
  attributeMatchesDef,
  type AttributeDef,
  type ProductAttributeInput,
  type ProductSaveMode,
  type SellerProductDetail,
  type SellerProductUpsertInput,
  type SellerVariantInput,
  type ShippingTemplateValue,
  type VariantAxis,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { PricingBreakdown, loadRates } from '@/components/seller/PricingBreakdown';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

const STEPS = [
  { key: 'BASIC', label: 'Basic info' },
  { key: 'CATEGORY', label: 'Category & details' },
  { key: 'MEDIA', label: 'Images & video' },
  { key: 'VARIANTS', label: 'Variants' },
  { key: 'INVENTORY', label: 'Inventory & pricing' },
  { key: 'SHIPPING', label: 'Shipping & SEO' },
  { key: 'REVIEW', label: 'Review' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

const MAX_IMAGES = 8;
/** Per variant; the API caps this too. */
const MAX_VARIANT_IMAGES = 6;

/** Rules used until a category is picked / the tree has loaded. */
const NO_RULES: CategoryRules = {
  variantAxes: [],
  attributeSchema: [],
  tryOnEligible: false,
  sizeGuide: false,
  taxRule: null,
  defaultTaxRatePercent: null,
  hsnCode: null,
  returnWindowDays: null,
};

interface VariantRow {
  id?: string;
  /** Value per option axis key, e.g. { color: "Black", size: "L" }. */
  options: Record<string, string>;
  sku: string;
  price: string; // rupees, as typed
  mrp: string;
  stock: string;
  /** This variant's own pictures; empty means it shows the product's. */
  imageUrls: string[];
  /**
   * Whether the seller touched this variant's images in this session.
   *
   * Only a dirty row sends `imageUrls`, and an omitted field tells the API to
   * leave the stored pictures alone. That is what makes it impossible for an
   * unrelated edit — a price change, or moving a variant from Blue to Pink
   * where Pink already has images — to quietly throw somebody's uploads away.
   */
  imagesDirty?: boolean;
}

const emptyRow: VariantRow = {
  options: {},
  sku: '',
  price: '',
  mrp: '',
  stock: '10',
  imageUrls: [],
};

/** Root → … → node for a category id; [] when the id is not in the tree. */
function pathTo(tree: CategoryNode[], id: string): CategoryNode[] {
  for (const node of tree) {
    if (node.id === id) return [node];
    const deeper = pathTo(node.children, id);
    if (deeper.length) return [node, ...deeper];
  }
  return [];
}

/** "Screen size" → "screen_size" — the machine key for a seller-defined option axis. */
function axisKeyFrom(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 24);
}

/** Axes an existing listing already uses, in the order its variants carry them. */
function axesFromVariants(variants: SellerProductDetail['variants'] | undefined): VariantAxis[] {
  const keys: string[] = [];
  for (const v of variants ?? []) {
    for (const key of Object.keys(v.optionValues)) if (!keys.includes(key)) keys.push(key);
  }
  return keys.map((key) => ({ key, label: axisLabel(key) }));
}

/** Character counter shown under an input, e.g. "41/200". */
function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className={`text-[11px] ${over ? 'text-red-600' : 'text-gray-400'}`}>
      {value.length}/{max}
    </span>
  );
}

interface Props {
  /** Existing product when editing; undefined when creating. */
  initial?: SellerProductDetail;
}

export default function ProductForm({ initial }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<StepKey>('BASIC');
  const [categories, setCategories] = useState<CategoryNode[]>([]);

  // --- Basic ---
  const [title, setTitle] = useState(initial?.title ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  // Brands to suggest: ones shoppers already see, and new ones an admin added.
  const [brandOptions, setBrandOptions] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const q = brand.trim();
    const timer = setTimeout(() => {
      api<{ id: string; name: string }[]>(`/api/seller/brands?q=${encodeURIComponent(q)}`, { auth: true })
        .then(setBrandOptions)
        .catch(() => setBrandOptions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [brand]);
  const [shortDescription, setShortDescription] = useState(initial?.shortDescription ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  // --- Category & details ---
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '');
  // Rows from the category rule carry its key; the seller's own rows carry
  // only a label and the API derives their key on save.
  const [attributes, setAttributes] = useState<ProductAttributeInput[]>(initial?.attributes ?? []);
  const [highlights, setHighlights] = useState<string[]>(initial?.highlights ?? []);

  // --- Media ---
  const [imageUrls, setImageUrls] = useState<string[]>(initial?.imageUrls ?? []);
  const [videoUrl, setVideoUrl] = useState(initial?.videoUrl ?? '');
  // The clip is private: the reference is what the listing stores, the URL only previews it.
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // --- Variants ---
  const initialAxes = useMemo(() => axesFromVariants(initial?.variants), [initial]);
  const [hasVariants, setHasVariants] = useState(
    initial ? (initial.variants.length > 1 || initialAxes.length > 0) : true,
  );
  const [axes, setAxes] = useState<VariantAxis[]>(initialAxes);
  // Once the seller edits the axes (or is editing a listing) the category no
  // longer overwrites them.
  const [axesTouched, setAxesTouched] = useState(!!initial);
  const [newAxisLabel, setNewAxisLabel] = useState('');
  const [rows, setRows] = useState<VariantRow[]>(
    initial?.variants.map((v) => ({
      id: v.id,
      options: { ...v.optionValues },
      sku: v.sku,
      price: String(v.pricePaise / 100),
      mrp: v.mrpPaise != null ? String(v.mrpPaise / 100) : '',
      stock: String(v.stock),
      imageUrls: [...v.imageUrls],
    })) ?? [{ ...emptyRow }],
  );

  // --- Inventory / pricing / shipping / SEO ---
  // GST is never the seller's choice: it is derived from the category (see
  // gstRateFor). The settings it needs come with the pricing rates.
  const [gst, setGst] = useState<GstSettings | null>(null);
  useEffect(() => {
    loadRates()
      .then((r) => setGst(r.gst))
      .catch(() => {});
  }, []);
  const [lowStockAlert, setLowStockAlert] = useState(String(initial?.lowStockAlert ?? 5));
  const [allowBackorders, setAllowBackorders] = useState(initial?.allowBackorders ?? false);
  const [weight, setWeight] = useState(
    initial?.weightGrams != null ? String(initial.weightGrams / 1000) : '',
  );
  const [dims, setDims] = useState({
    l: initial?.lengthMm != null ? String(initial.lengthMm / 10) : '',
    w: initial?.widthMm != null ? String(initial.widthMm / 10) : '',
    h: initial?.heightMm != null ? String(initial.heightMm / 10) : '',
  });
  // The parcel in the units the API stores (g, mm), for the hint and the checks.
  const parcel = {
    weightGrams: weight.trim() ? Math.round(Number(weight) * 1000) : null,
    lengthMm: dims.l.trim() ? Math.round(Number(dims.l) * 10) : null,
    widthMm: dims.w.trim() ? Math.round(Number(dims.w) * 10) : null,
    heightMm: dims.h.trim() ? Math.round(Number(dims.h) * 10) : null,
  };
  const volumetricGrams = volumetricWeightGrams(parcel.lengthMm, parcel.widthMm, parcel.heightMm);
  const [shippingTemplate, setShippingTemplate] = useState<ShippingTemplateValue>(
    initial?.shippingTemplate ?? 'STANDARD',
  );
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? '');
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? '');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [isVisible, setIsVisible] = useState(initial?.isVisible ?? true);
  const [tryOnEnabled, setTryOnEnabled] = useState(initial?.tryOnEnabled ?? true);

  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api<CategoryNode[]>('/api/categories')
      .then(setCategories)
      .catch(() => {});
  }, []);

  // Category path (root → … → leaf) and the rules that apply there.
  const path = useMemo(() => pathTo(categories, categoryId), [categories, categoryId]);
  const selectedNode = path[path.length - 1];
  const isLeaf = !!selectedNode && selectedNode.children.length === 0;
  const rules = selectedNode?.rules ?? NO_RULES;
  // The spec sheet: the category's own fields plus the filter facets' fields,
  // with a dropdown wherever the facet knows the values (what shoppers filter by).
  const specFields = useMemo(() => selectedNode?.specFields ?? [], [selectedNode]);

  // A fresh listing takes its option axes from the category until the seller edits them.
  useEffect(() => {
    if (axesTouched || !selectedNode) return;
    setAxes(rules.variantAxes);
    setHasVariants(rules.variantAxes.length > 0);
  }, [axesTouched, selectedNode, rules.variantAxes]);

  const activeAxes = useMemo(() => (hasVariants ? axes : []), [hasVariants, axes]);

  // --- Images by option value -------------------------------------------
  // Pictures vary by colour, never by size: a 5-colour x 4-size listing has 20
  // variants and 5 things worth photographing. So the uploader is grouped by
  // one axis and fans out to every variant sharing that value, while the table
  // above stays six columns wide.
  /** Which colour group's picker is open, by label; null when none. */
  const [pickerFor, setPickerFor] = useState<{ label: string; top: number; left: number } | null>(
    null,
  );
  const [uploadingGroup, setUploadingGroup] = useState<string | null>(null);

  /** Colour when the listing has one, else the first axis few enough to shoot. */
  const imageAxis = useMemo(() => {
    const distinct = (key: string) =>
      new Set(rows.map((r) => (r.options[key] ?? '').trim()).filter(Boolean)).size;
    const colour = activeAxes.find((a) => /colou?r/i.test(a.key) || /colou?r/i.test(a.label));
    if (colour && distinct(colour.key) > 0) return colour;
    return activeAxes.find((a) => distinct(a.key) > 0 && distinct(a.key) <= 8) ?? null;
  }, [activeAxes, rows]);

  const sameUrls = (a: string[], b: string[]) =>
    a.length === b.length && a.every((u, i) => u === b[i]);

  /**
   * One uploader per axis value, or per variant when no axis is suitable.
   * `mixed` marks a group whose variants disagree — which happens when one is
   * re-coloured into a value that already had pictures. Nothing is merged or
   * dropped on sight of it; the seller is offered a button and decides.
   */
  const imageGroups = useMemo(() => {
    const groupsFrom = (keyOf: (i: number) => string | null) => {
      const map = new Map<string, number[]>();
      rows.forEach((_, i) => {
        const key = keyOf(i);
        if (key === null) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(i);
      });
      return [...map.entries()].map(([label, idxs]) => {
        const urls = rows[idxs[0]!]!.imageUrls;
        return {
          label,
          idxs,
          urls,
          mixed: idxs.some((i) => !sameUrls(rows[i]!.imageUrls, urls)),
        };
      });
    };
    if (imageAxis) {
      return groupsFrom((i) => (rows[i]!.options[imageAxis.key] ?? '').trim() || null);
    }
    // No axis worth grouping by. Per-variant is fine for a handful; beyond that
    // it would be forty uploaders, and the honest answer is to add an axis.
    if (rows.length > 8) return null;
    return groupsFrom((i) => {
      const row = rows[i]!;
      const fromOptions = activeAxes
        .map((a) => (row.options[a.key] ?? '').trim())
        .filter(Boolean)
        .join(' · ');
      return fromOptions || row.sku.trim() || `Variant ${i + 1}`;
    });
  }, [rows, imageAxis, activeAxes]);

  /**
   * Legacy listings have no variant pictures at all, and a colour now needs
   * them to pass review. Rather than block the edit, seed each empty colour
   * from the product gallery and mark it dirty, so the seller sees exactly
   * what will be saved and can replace it — the listing heals on its next
   * edit instead of refusing one. Runs once; a seller who then clears a
   * colour is not overruled on the next render.
   */
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current || !initial || !imageAxis || imageGroups === null) return;
    const empty = imageGroups.filter((g) => g.urls.length === 0);
    if (empty.length === 0) {
      prefilledRef.current = true;
      return;
    }
    if (imageUrls.length === 0) return; // nothing to seed from yet
    prefilledRef.current = true;
    const seed = imageUrls.slice(0, MAX_VARIANT_IMAGES);
    const targets = new Set(empty.flatMap((g) => g.idxs));
    setRows((prev) =>
      prev.map((row, i) =>
        targets.has(i) ? { ...row, imageUrls: seed, imagesDirty: true } : row,
      ),
    );
  }, [initial, imageAxis, imageGroups, imageUrls]);

  /** Row index -> its group, so a cell can find its own without rescanning. */
  const groupByRow = useMemo(() => {
    const m = new Map<number, NonNullable<typeof imageGroups>[number]>();
    (imageGroups ?? []).forEach((g) => g.idxs.forEach((i) => m.set(i, g)));
    return m;
  }, [imageGroups]);

  /** Write a set to every variant in the group and mark them dirty. */
  function setGroupImages(idxs: number[], urls: string[]) {
    setRows((prev) =>
      prev.map((row, i) =>
        idxs.includes(i) ? { ...row, imageUrls: urls, imagesDirty: true } : row,
      ),
    );
  }

  async function onUploadForGroup(group: { label: string; idxs: number[]; urls: string[] }, files: FileList | null) {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    setError('');
    setUploadingGroup(group.label);
    try {
      const uploaded = await uploadImages(list);
      setGroupImages(group.idxs, [...group.urls, ...uploaded].slice(0, MAX_VARIANT_IMAGES));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setUploadingGroup(null);
    }
  }

  const tags = useMemo(
    () =>
      tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 15),
    [tagsText],
  );

  const variantInputs: SellerVariantInput[] = useMemo(
    () =>
      rows
        .filter((r) => r.price.trim())
        .map((r) => ({
          id: r.id,
          optionValues: Object.fromEntries(
            activeAxes
              .map((a) => [a.key, (r.options[a.key] ?? '').trim()] as const)
              .filter(([, value]) => value),
          ),
          sku: r.sku.trim() || undefined,
          pricePaise: Math.round(Number(r.price) * 100),
          mrpPaise: r.mrp.trim() ? Math.round(Number(r.mrp) * 100) : null,
          stock: Math.max(0, Math.round(Number(r.stock) || 0)),
          // Sent only when the seller edited this variant's pictures. Leaving
          // the key off entirely is meaningful: the API reads an absent
          // imageUrls as "do not touch what is stored", so saving a price
          // never disturbs images, and a new row with none stays empty.
          ...(r.imagesDirty ? { imageUrls: r.imageUrls } : {}),
        })),
    [rows, activeAxes],
  );

  const cheapest = variantInputs.length
    ? variantInputs.reduce((min, v) => (v.pricePaise < min.pricePaise ? v : min))
    : null;
  const totalStock = variantInputs.reduce((sum, v) => sum + v.stock, 0);

  /** Spec-sheet fields the category requires that are still empty. */
  const missingRequired = useMemo(
    () =>
      specFields
        .filter(
          (def) =>
            def.required &&
            !attributes.some((a) => attributeMatchesDef(a, def) && a.value.trim()),
        )
        .map((def) => def.label),
    [specFields, attributes],
  );

  /** Attributes the seller added on top of the category's spec sheet. */
  const customAttributeIndexes = attributes
    .map((a, i) => ({ a, i }))
    .filter(
      ({ a }) => !specFields.some((def) => attributeMatchesDef(a, def)),
    )
    .map(({ i }) => i);

  /** Publish checklist — drives the completeness ring on the right. */
  const checklist = [
    { key: 'basic', label: 'Basic information', done: title.trim().length >= 3 && description.trim().length >= 20 },
    { key: 'category', label: 'Category', done: isLeaf },
    {
      key: 'details',
      label: specFields.some((d) => d.required) ? 'Required details' : 'Product details',
      // Not "done" until a category is picked - before that there is nothing to judge.
      done:
        !!selectedNode &&
        missingRequired.length === 0 &&
        (specFields.length === 0 || attributes.some((a) => a.value.trim())),
    },
    { key: 'images', label: 'Images', done: imageUrls.length > 0 },
    { key: 'variants', label: hasVariants ? 'Variants' : 'Price & stock', done: variantInputs.length > 0 },
    { key: 'inventory', label: 'Inventory', done: totalStock > 0 },
    { key: 'pricing', label: 'Pricing', done: !!cheapest },
    { key: 'shipping', label: 'Shipping', done: parcelProblems(parcel).length === 0 },
    { key: 'seo', label: 'SEO & visibility', done: !!metaTitle.trim() || tags.length > 0 },
  ];
  const completeness = Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100);

  function buildPayload(mode: ProductSaveMode): SellerProductUpsertInput {
    return {
      title: title.trim(),
      categoryId,
      brand: brand.trim() || undefined,
      shortDescription: shortDescription.trim() || undefined,
      description: description.trim(),
      imageUrls,
      videoUrl: videoUrl.trim() || undefined,
      attributes: attributes.filter((a) => a.label?.trim() && a.value.trim()),
      highlights: highlights.filter((h) => h.trim().length >= 3),
      variants: variantInputs,
      weightGrams: weight.trim() ? Math.round(Number(weight) * 1000) : null,
      lengthMm: dims.l.trim() ? Math.round(Number(dims.l) * 10) : null,
      widthMm: dims.w.trim() ? Math.round(Number(dims.w) * 10) : null,
      heightMm: dims.h.trim() ? Math.round(Number(dims.h) * 10) : null,
      shippingTemplate,
      metaTitle: metaTitle.trim() || undefined,
      metaDescription: metaDescription.trim() || undefined,
      tags,
      isVisible,
      // Only meaningful in try-on categories; the API enforces the same gate.
      tryOnEnabled: rules.tryOnEligible ? tryOnEnabled : false,
      lowStockAlert: Math.max(0, Math.round(Number(lowStockAlert) || 0)),
      allowBackorders,
      mode,
    };
  }

  /** Client-side checks the zod schema cannot express. */
  function variantProblem(): string | null {
    if (!hasVariants) return null;
    if (activeAxes.length === 0) {
      return 'Add at least one option (e.g. Colour) or untick "This product has variants"';
    }
    const incomplete = rows.some(
      (r) => r.price.trim() && activeAxes.some((a) => !(r.options[a.key] ?? '').trim()),
    );
    if (incomplete) return 'Fill in every option for each variant row';
    const keys = variantInputs.map((v) => optionsKeyOf(v.optionValues));
    if (new Set(keys).size !== keys.length) return 'Two variant rows have the same options';
    return null;
  }

  async function save(mode: ProductSaveMode) {
    setError('');
    setNotice('');

    // A live listing's price-only save needs no parcel; the API says so when
    // its edit goes to review. Everything else sent to review needs one.
    const problems = parcelProblems(parcel);
    if (mode === 'SUBMIT' && initial?.status !== 'APPROVED' && problems.length > 0) {
      setError(`Before review, add ${problems.join(', ')}`);
      setStep('SHIPPING');
      return;
    }

    if (mode === 'SUBMIT' && !isLeaf) {
      setError('Pick the most specific category for this product');
      setStep('CATEGORY');
      return;
    }
    const problem = variantProblem();
    if (problem) {
      setError(problem);
      setStep('VARIANTS');
      return;
    }
    if (mode === 'SUBMIT' && missingRequired.length > 0) {
      setError(`Please fill in: ${missingRequired.join(', ')}`);
      setStep('CATEGORY');
      return;
    }
    const parsed = sellerProductUpsertSchema.safeParse(buildPayload(mode));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.') || 'form'}: ${issue.message}`);
      return;
    }

    setBusy(true);
    try {
      if (initial) {
        await api(`/api/seller/products/${initial.id}`, {
          method: 'PUT',
          body: parsed.data,
          auth: true,
        });
      } else {
        await api('/api/seller/products', { body: parsed.data, auth: true });
      }
      router.push('/seller/products');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setBusy(false);
    }
  }

  async function generateDescription() {
    setError('');
    setAiBusy(true);
    try {
      const data = await api<{ description: string }>('/api/ai/product-description', {
        body: {
          title: title.trim(),
          brand: brand.trim() || undefined,
          categoryName: path.map((c) => c.name).join(' › ') || undefined,
          keywords:
            [shortDescription.trim(), ...attributes.map((a) => `${a.label}: ${a.value}`)]
              .filter(Boolean)
              .join(', ')
              .slice(0, 200) || undefined,
        },
        auth: true,
      });
      setDescription(data.description);
      setNotice('Description generated — edit it before publishing.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'AI generation failed');
    } finally {
      setAiBusy(false);
    }
  }

  async function onUpload(files: FileList | File[] | null) {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    setError('');
    setUploading(true);
    try {
      const urls = await uploadImages(list);
      setImageUrls((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function setRow(index: number, patch: Partial<VariantRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function setRowOption(index: number, key: string, value: string) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, options: { ...row.options, [key]: value } } : row)),
    );
  }

  /** Upsert one rule field's value; an empty value removes the row. */
  function setAttribute(def: AttributeDef, value: string) {
    setAttributes((prev) => {
      const i = prev.findIndex((a) => attributeMatchesDef(a, def));
      if (i === -1) return value === '' ? prev : [...prev, { key: def.key, label: def.label, value }];
      if (value === '') return prev.filter((_, j) => j !== i);
      return prev.map((a, j) => (j === i ? { ...a, key: def.key, label: def.label, value } : a));
    });
  }

  function addAxis(axis: VariantAxis) {
    if (axes.some((a) => a.key === axis.key) || axes.length >= MAX_VARIANT_AXES) return;
    setAxes((prev) => [...prev, axis]);
    setAxesTouched(true);
  }

  function removeAxis(key: string) {
    setAxes((prev) => prev.filter((a) => a.key !== key));
    setAxesTouched(true);
  }

  function addCustomAxis() {
    const key = axisKeyFrom(newAxisLabel);
    if (!key) return;
    addAxis({ key, label: newAxisLabel.trim() });
    setNewAxisLabel('');
  }

  /** Pick a category at one level of the tree; deeper picks reset. */
  function pickLevel(depth: number, id: string) {
    setCategoryId(id || path[depth - 1]?.id || '');
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const levelOptions: CategoryNode[][] = [categories];
  if (path[0]) levelOptions.push(path[0].children);
  if (path[1] && path[1].children.length > 0) levelOptions.push(path[1].children);
  const levelLabels = ['Department', 'Category', 'Subcategory'];

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        {/* --- Step tabs ------------------------------------------------ */}
        <div className="flex flex-wrap gap-1 rounded-2xl border border-gray-100 bg-white p-2">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStep(s.key)}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                step === s.key
                  ? 'bg-ink-900 text-white'
                  : 'text-gray-500 hover:bg-cream-100 hover:text-ink-900'
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                  step === s.key ? 'bg-white text-ink-900' : 'bg-cream-100 text-gray-500'
                }`}
              >
                {i + 1}
              </span>
              {s.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {notice}
          </div>
        )}

        {/* --- 1. Basic -------------------------------------------------- */}
        {step === 'BASIC' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">1. Basic information</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Product name *</label>
                  <Counter value={title} max={150} />
                </div>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={150}
                  placeholder="Brand, model and the key spec — e.g. Orbita Book 14 (16GB / 512GB)"
                  className={`mt-1 ${field}`}
                />
              </div>
              <div>
                <label className="text-sm font-medium" htmlFor="brand-input">
                  Brand
                </label>
                <input
                  id="brand-input"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  maxLength={40}
                  list="brand-suggestions"
                  autoComplete="off"
                  placeholder="Start typing to pick your brand"
                  className={`mt-1 ${field}`}
                />
                <datalist id="brand-suggestions">
                  {brandOptions.map((b) => (
                    <option key={b.id} value={b.name} />
                  ))}
                </datalist>
                <p className="mt-1 text-[11px] text-gray-400">
                  {brand.trim() && !brandOptions.some((b) => b.name.toLowerCase() === brand.trim().toLowerCase())
                    ? 'Not one of our brands yet — a new brand is checked when the listing is reviewed.'
                    : 'Pick from the list where your brand is there, so shoppers find it under one name.'}
                </p>
              </div>
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Short description</label>
                  <Counter value={shortDescription} max={200} />
                </div>
                <input
                  value={shortDescription}
                  onChange={(e) => setShortDescription(e.target.value)}
                  maxLength={200}
                  placeholder="One line shoppers see on cards and search results"
                  className={`mt-1 ${field}`}
                />
              </div>
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Long description * (min 20 chars)</label>
                  <Counter value={description} max={5000} />
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={7}
                  maxLength={5000}
                  placeholder="What it is, key specifications, what's in the box, warranty… or let AI write it from the title"
                  className={`mt-1 ${field}`}
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-cream-50 px-3 py-2">
                  <p className="text-xs text-gray-600">
                    <span className="font-semibold text-ink-900">✦ AI suggestion</span> — writes a
                    description from your title, category and details.
                  </p>
                  <button
                    type="button"
                    disabled={aiBusy || title.trim().length < 3}
                    onClick={() => void generateDescription()}
                    title={title.trim().length < 3 ? 'Enter a product name first' : undefined}
                    className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-40"
                  >
                    {aiBusy ? 'Writing…' : '✦ Generate with AI'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* --- 2. Category & details ------------------------------------- */}
        {step === 'CATEGORY' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">2. Category &amp; details</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              {levelOptions.map((options, depth) => (
                <div key={depth}>
                  <label className="text-sm font-medium">
                    {levelLabels[depth] ?? 'Subcategory'} *
                  </label>
                  <select
                    value={path[depth]?.id ?? ''}
                    onChange={(e) => pickLevel(depth, e.target.value)}
                    className={`mt-1 ${field}`}
                  >
                    <option value="">Select…</option>
                    {options.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {selectedNode && !isLeaf && (
              <p className="mt-2 text-xs text-orange-600">
                Pick a {levelLabels[path.length] ?? 'subcategory'} — listings go in the most specific
                category.
              </p>
            )}
            {selectedNode && (
              <p className="mt-2 text-xs text-gray-400">
                {path.map((c) => c.name).join(' › ')} · GST {gst ? describeTaxDefault(rules, gst) : '…'} ·
                {rules.returnWindowDays != null ? ` ${rules.returnWindowDays}-day returns` : ' platform return window'}
                {rules.tryOnEligible ? ' · AI Try-On available' : ''}
              </p>
            )}

            {/* Spec sheet from the category */}
            <div className="mt-5">
              <label className="text-sm font-medium">Product details</label>
              <p className="mt-1 text-xs text-gray-400">
                {specFields.length > 0
                  ? 'The spec sheet shoppers see on the product page, and filter by. Fields marked * are required for this category.'
                  : selectedNode
                    ? 'The spec sheet shoppers see on the product page.'
                    : 'Pick a category to see the details it needs.'}
              </p>
              {specFields.length > 0 && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {specFields.map((def) => {
                    const current = attributes.find((a) => attributeMatchesDef(a, def))?.value ?? '';
                    return (
                      <div key={def.key}>
                        <label className="text-xs font-medium text-gray-700">
                          {def.label}
                          {def.required && ' *'}
                          {def.unit && <span className="text-gray-400"> ({def.unit})</span>}
                        </label>
                        {def.type === 'select' && def.options?.length ? (
                          <select
                            value={current}
                            onChange={(e) => setAttribute(def, e.target.value)}
                            className={`mt-1 ${field}`}
                          >
                            <option value="">Select…</option>
                            {/* A value saved before this list existed stays visible, to be replaced. */}
                            {current && !def.options.includes(current) && (
                              <option value={current}>{current} (not in the list — pick one)</option>
                            )}
                            {def.options.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={def.type === 'number' ? 'number' : 'text'}
                            value={current}
                            onChange={(e) => setAttribute(def, e.target.value)}
                            placeholder={def.placeholder ?? ''}
                            maxLength={120}
                            className={`mt-1 ${field}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-600">Other details</span>
                <button
                  type="button"
                  onClick={() => setAttributes((prev) => [...prev, { label: '', value: '' }])}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold hover:bg-gray-50"
                >
                  ＋ Add detail
                </button>
              </div>
              <div className="mt-2 space-y-2">
                {customAttributeIndexes.map((i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={attributes[i].label ?? ''}
                      onChange={(e) =>
                        setAttributes((prev) =>
                          prev.map((a, j) => (i === j ? { ...a, label: e.target.value } : a)),
                        )
                      }
                      placeholder="Detail (e.g. Material)"
                      className={`${field} max-w-52`}
                    />
                    <input
                      value={attributes[i].value}
                      onChange={(e) =>
                        setAttributes((prev) =>
                          prev.map((a, j) => (i === j ? { ...a, value: e.target.value } : a)),
                        )
                      }
                      placeholder="Value"
                      className={field}
                    />
                    <button
                      type="button"
                      onClick={() => setAttributes((prev) => prev.filter((_, j) => j !== i))}
                      className="px-2 text-red-500"
                      aria-label="Remove detail"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {customAttributeIndexes.length === 0 && (
                  <p className="text-xs text-gray-400">No extra details yet.</p>
                )}
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Key highlights</label>
                <button
                  type="button"
                  onClick={() => setHighlights((prev) => [...prev, ''])}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold hover:bg-gray-50"
                >
                  ＋ Add highlight
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Short bullets shown above the description on the product page.
              </p>
              <div className="mt-2 space-y-2">
                {highlights.map((h, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={h}
                      onChange={(e) =>
                        setHighlights((prev) => prev.map((x, j) => (i === j ? e.target.value : x)))
                      }
                      placeholder="e.g. 16GB RAM for smooth multitasking"
                      className={field}
                    />
                    <button
                      type="button"
                      onClick={() => setHighlights((prev) => prev.filter((_, j) => j !== i))}
                      className="px-2 text-red-500"
                      aria-label="Remove highlight"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* --- 3. Media --------------------------------------------------- */}
        {step === 'MEDIA' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">3. Images &amp; video</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              First image is the main one. JPG / PNG / WebP, up to {MAX_IMAGES} images.
            </p>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void onUpload(e.dataTransfer.files);
              }}
              className={`mt-3 rounded-xl border-2 border-dashed p-6 text-center transition ${
                dragOver ? 'border-brand-600 bg-cream-50' : 'border-gray-300'
              }`}
            >
              <p className="text-2xl">🖼</p>
              <p className="mt-1 text-sm text-gray-600">Drag &amp; drop images here</p>
              <label className="mt-2 inline-block cursor-pointer rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700">
                {uploading ? 'Uploading…' : 'Upload images'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    void onUpload(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-3">
              {imageUrls.map((url, i) => (
                <div key={url} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt=""
                    className={`h-24 w-24 rounded-lg border-2 bg-cream-50 object-contain ${
                      i === 0 ? 'border-brand-600' : 'border-gray-200'
                    }`}
                  />
                  {i === 0 && (
                    <span className="absolute bottom-1 left-1 rounded bg-ink-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      Main
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setImageUrls((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white"
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setImageUrls((prev) => {
                          const next = [...prev];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          return next;
                        })
                      }
                      className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ink-900 text-[10px] text-white"
                      title="Move earlier"
                    >
                      ‹
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4">
              <label className="text-sm font-medium">Product video (optional)</label>
              <input
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="Paste a YouTube or Vimeo link"
                className={`mt-1 ${field}`}
              />
            </div>
          </section>
        )}

        {/* --- 4. Variants ------------------------------------------------ */}
        {step === 'VARIANTS' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-ink-900">4. Variants</h2>
                <p className="text-xs text-gray-400">
                  Does this product come in options — colour, size, storage, flavour…? Each
                  combination is its own sellable unit with its own price and stock.
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600">
                This product has variants
                <input
                  type="checkbox"
                  checked={hasVariants}
                  onChange={(e) => {
                    setHasVariants(e.target.checked);
                    setAxesTouched(true);
                    if (!e.target.checked) setRows((prev) => prev.slice(0, 1));
                  }}
                  className="h-4 w-4 accent-[#B8860B]"
                />
              </label>
            </div>

            {hasVariants && (
              <div className="mt-3 rounded-xl bg-cream-50 p-3">
                <p className="text-xs font-semibold text-gray-600">
                  Options this product varies on (up to {MAX_VARIANT_AXES})
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {axes.map((a) => (
                    <span
                      key={a.key}
                      className="inline-flex items-center gap-1.5 rounded-full bg-ink-900 px-2.5 py-1 text-[11px] font-semibold text-white"
                    >
                      {a.label}
                      <button
                        type="button"
                        onClick={() => removeAxis(a.key)}
                        aria-label={`Remove ${a.label}`}
                        className="text-white/70 hover:text-white"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {rules.variantAxes
                    .filter((a) => !axes.some((x) => x.key === a.key))
                    .map((a) => (
                      <button
                        key={a.key}
                        type="button"
                        onClick={() => addAxis(a)}
                        disabled={axes.length >= MAX_VARIANT_AXES}
                        className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:border-ink-900 disabled:opacity-40"
                      >
                        ＋ {a.label}
                      </button>
                    ))}
                  {axes.length < MAX_VARIANT_AXES && (
                    <span className="inline-flex items-center gap-1">
                      <input
                        value={newAxisLabel}
                        onChange={(e) => setNewAxisLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCustomAxis();
                          }
                        }}
                        placeholder="Other option, e.g. Wattage"
                        maxLength={30}
                        className="w-44 rounded-full border border-gray-300 bg-white px-3 py-1 text-[11px] outline-none focus:border-brand-600"
                      />
                      <button
                        type="button"
                        onClick={addCustomAxis}
                        disabled={!axisKeyFrom(newAxisLabel)}
                        className="rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
                      >
                        Add
                      </button>
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[584px] table-fixed text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    {activeAxes.map((a) => (
                      <th key={a.key} className="w-[90px] pb-2 pr-2">
                        {a.label} *
                      </th>
                    ))}
                    <th className="w-[80px] pb-2 pr-2">SKU</th>
                    <th className="w-[92px] pb-2 pr-2">Price (₹) *</th>
                    <th className="w-[88px] pb-2 pr-2">MRP (₹)</th>
                    <th className="w-[64px] pb-2 pr-2">Stock</th>
                    <th className="w-[56px] pb-2 pr-2">Images</th>
                    <th className="w-[24px] pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      {activeAxes.map((a) => (
                        <td key={a.key} className="pr-2 pt-1">
                          <input
                            value={row.options[a.key] ?? ''}
                            onChange={(e) => setRowOption(i, a.key, e.target.value)}
                            list={a.values?.length ? `axis-values-${a.key}` : undefined}
                            className={field}
                            placeholder={a.values?.[0] ?? a.label}
                            maxLength={60}
                          />
                        </td>
                      ))}
                      <td className="pr-2 pt-1">
                        <input
                          value={row.sku}
                          onChange={(e) => setRow(i, { sku: e.target.value })}
                          className={field}
                          placeholder="auto"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          type="number"
                          min={1}
                          value={row.price}
                          onChange={(e) => setRow(i, { price: e.target.value })}
                          className={field}
                          placeholder="499"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          type="number"
                          min={1}
                          value={row.mrp}
                          onChange={(e) => setRow(i, { mrp: e.target.value })}
                          className={field}
                          placeholder="799"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          type="number"
                          min={0}
                          value={row.stock}
                          onChange={(e) => setRow(i, { stock: e.target.value })}
                          className={field}
                        />
                      </td>
                      {/* Images. A 56px entry point, not an uploader: pictures
                          are written per colour, so this opens one picker for
                          the whole colour and the picker says so in its
                          heading. The picker itself is rendered once, outside
                          this scroll container — an absolute popover inside it
                          both widened the table and, keyed by colour, opened on
                          every row of that colour at once. */}
                      <td className="pr-2 pt-1">
                        {(() => {
                          const g = groupByRow.get(i);
                          if (!g) {
                            return (
                              <span
                                className="block text-center text-xs text-gray-300"
                                title="Fill in this row's options first"
                              >
                                &mdash;
                              </span>
                            );
                          }
                          return (
                            <button
                              type="button"
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setPickerFor(
                                  pickerFor?.label === g.label
                                    ? null
                                    : { label: g.label, top: r.bottom + 6, left: r.right - 288 },
                                );
                              }}
                              aria-expanded={pickerFor?.label === g.label}
                              aria-label={`Images for ${g.label}`}
                              className={`relative flex h-9 w-12 items-center justify-center overflow-hidden rounded-md border ${
                                g.urls.length === 0
                                  ? 'border-dashed border-gray-300 text-gray-400 hover:border-brand-600 hover:text-brand-600'
                                  : 'border-gray-200'
                              }`}
                            >
                              {g.urls[0] ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={g.urls[0]} alt="" className="h-full w-full object-cover" />
                              ) : (
                                <span className="text-base leading-none">&#xff0b;</span>
                              )}
                              {g.urls.length > 1 && (
                                <span className="absolute bottom-0 right-0 rounded-tl bg-ink-900/80 px-1 text-[10px] font-semibold leading-tight text-white">
                                  +{g.urls.length - 1}
                                </span>
                              )}
                              {g.mixed && (
                                <span
                                  className="absolute right-0 top-0 h-2 w-2 rounded-full bg-amber-500"
                                  title="Variants of this colour have different images"
                                />
                              )}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="pt-1">
                        <button
                          type="button"
                          onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                          disabled={rows.length === 1}
                          className="text-red-500 disabled:opacity-30"
                          aria-label="Remove variant"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activeAxes.map((a) =>
                a.values?.length ? (
                  <datalist key={a.key} id={`axis-values-${a.key}`}>
                    {a.values.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                ) : null,
              )}
            </div>


            {/* The one picker. Fixed-positioned from the cell it was opened
                from, so the scroll container above cannot clip it or be made
                wider by it, and only ever one exists however many rows share
                the colour. */}
            {pickerFor &&
              (() => {
                const g = (imageGroups ?? []).find((x) => x.label === pickerFor.label);
                if (!g) return null;
                return (
                  <>
                    <button
                      type="button"
                      aria-label="Close images"
                      onClick={() => setPickerFor(null)}
                      className="fixed inset-0 z-40 cursor-default"
                    />
                    <div
                      style={{ top: pickerFor.top, left: Math.max(8, pickerFor.left) }}
                      className="fixed z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-2xl"
                    >
                      <p className="text-sm font-bold text-ink-900">Images for {g.label}</p>
                      <p className="mt-0.5 text-xs font-semibold text-brand-600">
                        {g.idxs.length === 1
                          ? 'Applies to this variant'
                          : `Applies to all ${g.idxs.length} ${g.label} variants`}
                      </p>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        {g.urls.map((url) => (
                          <span key={url} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt=""
                              className="h-14 w-14 rounded-lg border border-gray-200 object-cover"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setGroupImages(
                                  g.idxs,
                                  g.urls.filter((u) => u !== url),
                                )
                              }
                              aria-label={`Remove image from ${g.label}`}
                              className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full bg-ink-900 text-[10px] leading-none text-white"
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                        {g.urls.length < MAX_VARIANT_IMAGES && (
                          <label className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-lg border border-dashed border-gray-300 text-lg text-gray-400 hover:border-brand-600 hover:text-brand-600">
                            {uploadingGroup === g.label ? '…' : '＋'}
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              className="hidden"
                              onChange={(e) => {
                                void onUploadForGroup(g, e.target.files);
                                e.target.value = '';
                              }}
                            />
                          </label>
                        )}
                      </div>

                      {g.urls.length === 0 && (
                        <p className="mt-2 text-[11px] text-gray-500">
                          Empty uses the listing&rsquo;s main images. A colour needs its own
                          before you can submit for review.
                        </p>
                      )}
                      {g.mixed && (
                        <p className="mt-2 text-[11px] text-amber-700">
                          Variants of this colour have different images.{' '}
                          <button
                            type="button"
                            onClick={() => setGroupImages(g.idxs, g.urls)}
                            className="font-semibold underline"
                          >
                            Use these for all {g.idxs.length}
                          </button>
                        </p>
                      )}
                    </div>
                  </>
                );
              })()}

            {hasVariants ? (
              <button
                type="button"
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    {
                      ...emptyRow,
                      options: { ...(prev[prev.length - 1]?.options ?? {}) },
                      price: prev[prev.length - 1]?.price ?? '',
                      mrp: prev[prev.length - 1]?.mrp ?? '',
                    },
                  ])
                }
                className="mt-2 text-sm font-medium text-brand-600 hover:underline"
              >
                ＋ Add variant row
              </button>
            ) : (
              <p className="mt-2 text-xs text-gray-400">
                Single SKU — one price and one stock count for the whole listing.
              </p>
            )}
          </section>
        )}

        {/* --- 5. Inventory & pricing -------------------------------------- */}
        {step === 'INVENTORY' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">5. Inventory &amp; pricing</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Low stock alert</label>
                <input
                  type="number"
                  min={0}
                  value={lowStockAlert}
                  onChange={(e) => setLowStockAlert(e.target.value)}
                  className={`mt-1 ${field}`}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Variants at or below this level are flagged on your dashboard.
                </p>
              </div>
              <div>
                <p className="text-sm font-medium">GST</p>
                <p className="mt-1 text-sm text-ink-900">{gst ? describeTaxDefault(rules, gst) : '…'}</p>
                <p className="mt-1 text-xs text-gray-400">
                  Set by the category under GST 2.0, not chosen per listing. Used on the tax invoice
                  for each order{rules.hsnCode ? ` · HSN ${rules.hsnCode}` : ''}.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={allowBackorders}
                  onChange={(e) => setAllowBackorders(e.target.checked)}
                  className="h-4 w-4 accent-[#B8860B]"
                />
                Allow backorders (keep selling when stock hits zero)
              </label>
            </div>

            <div className="mt-4 rounded-xl bg-cream-50 p-3 text-xs">
              <p className="font-semibold text-ink-900">Pricing summary</p>
              <p className="mt-1 text-gray-600">
                {cheapest ? (
                  <>
                    Listing price {formatPaise(cheapest.pricePaise)}
                    {cheapest.mrpPaise ? (
                      <>
                        {' '}
                        · MRP {formatPaise(cheapest.mrpPaise)} ·{' '}
                        {Math.round(
                          ((cheapest.mrpPaise - cheapest.pricePaise) / cheapest.mrpPaise) * 100,
                        )}
                        % off
                      </>
                    ) : null}{' '}
                    · {totalStock} unit(s) across {variantInputs.length} variant(s)
                  </>
                ) : (
                  'Add a variant with a price to see the listing price.'
                )}
              </p>
            </div>

            <PricingBreakdown listingPricePaise={cheapest ? cheapest.pricePaise : null} taxRules={selectedNode ? rules : null} />
          </section>
        )}

        {/* --- 6. Shipping & SEO ------------------------------------------ */}
        {step === 'SHIPPING' && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold text-ink-900">6. Shipping</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Item weight (kg)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    className={`mt-1 ${field}`}
                    placeholder="0.35"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Shipping template</label>
                  <select
                    value={shippingTemplate}
                    onChange={(e) => setShippingTemplate(e.target.value as ShippingTemplateValue)}
                    className={`mt-1 ${field}`}
                  >
                    {SHIPPING_TEMPLATES.map((t) => (
                      <option key={t} value={t}>
                        {SHIPPING_TEMPLATE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="text-sm font-medium">Dimensions (cm)</label>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    {(['l', 'w', 'h'] as const).map((key) => (
                      <div key={key}>
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={dims[key]}
                          onChange={(e) => setDims((d) => ({ ...d, [key]: e.target.value }))}
                          className={field}
                          placeholder={key.toUpperCase()}
                        />
                        <p className="mt-0.5 text-center text-[11px] text-gray-400">
                          {key === 'l' ? 'Length' : key === 'w' ? 'Width' : 'Height'}
                        </p>
                      </div>
                    ))}
                  </div>
                  {volumetricGrams !== null && (
                    <p className="mt-2 text-xs text-gray-600" data-volumetric>
                      Volumetric weight: <span className="font-semibold">{(volumetricGrams / 1000).toFixed(2)} kg</span>{' '}
                      (L × W × H ÷ {VOLUMETRIC_DIVISOR}). Couriers charge for the higher of this and the actual weight
                      {parcel.weightGrams ? (
                        <>
                          : <span className="font-semibold">{(billedWeightGrams(parcel.weightGrams, volumetricGrams)! / 1000).toFixed(2)} kg</span>.
                        </>
                      ) : (
                        '.'
                      )}
                    </p>
                  )}
                  {oversizedBox(parcel.weightGrams, volumetricGrams) && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-oversized>
                      The box is more than twice as heavy by size ({(volumetricGrams! / 1000).toFixed(2)} kg) as the item
                      itself ({(parcel.weightGrams! / 1000).toFixed(2)} kg), so shipping is charged on its size. A box that fits
                      the item more closely costs less to send.
                    </p>
                  )}
                  <p className="mt-2 text-[11px] text-gray-400">
                    Needed for review: a weight of {SHIPPING_LIMITS.minWeightGrams / 1000}–{SHIPPING_LIMITS.maxWeightGrams / 1000} kg
                    and each side {SHIPPING_LIMITS.minSideMm / 10}–{SHIPPING_LIMITS.maxSideMm / 10} cm.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold text-ink-900">7. SEO &amp; visibility</h2>
              <div className="mt-3 space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Meta title</label>
                    <Counter value={metaTitle} max={70} />
                  </div>
                  <input
                    value={metaTitle}
                    onChange={(e) => setMetaTitle(e.target.value)}
                    maxLength={70}
                    placeholder={title || 'Falls back to the product name'}
                    className={`mt-1 ${field}`}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Meta description</label>
                    <Counter value={metaDescription} max={160} />
                  </div>
                  <textarea
                    value={metaDescription}
                    onChange={(e) => setMetaDescription(e.target.value)}
                    rows={2}
                    maxLength={160}
                    placeholder="What a shopper sees in search results"
                    className={`mt-1 ${field}`}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Tags / keywords</label>
                    <span className="text-[11px] text-gray-400">{tags.length}/15</span>
                  </div>
                  <input
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="e.g. laptop, 16gb, gaming — comma separated"
                    className={`mt-1 ${field}`}
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isVisible}
                    onChange={(e) => setIsVisible(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[#B8860B]"
                  />
                  <span>
                    Show on storefront
                    <span className="block text-xs text-gray-400">
                      Unticking hides an approved listing from browsing and search without
                      archiving it.
                    </span>
                  </span>
                </label>

                {rules.tryOnEligible && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={tryOnEnabled}
                      onChange={(e) => setTryOnEnabled(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-[#B8860B]"
                    />
                    <span>
                      Enable AI Try-On
                      <span className="block text-xs text-gray-400">
                        Available because this category is wearable. The platform&apos;s
                        minimum-price rule still applies on top of this.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            </div>
          </section>
        )}

        {/* --- 7. Review --------------------------------------------------- */}
        {step === 'REVIEW' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Review &amp; publish</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              {initial
                ? 'Saved edits go back to the admin for re-approval.'
                : 'New listings go live once the admin approves them.'}
            </p>

            <ul className="mt-3 space-y-2 text-sm">
              {checklist.map((c) => (
                <li key={c.key} className="flex items-center gap-2">
                  <span className={c.done ? 'text-green-600' : 'text-gray-300'}>
                    {c.done ? '✓' : '○'}
                  </span>
                  <span className={c.done ? 'text-ink-900' : 'text-gray-500'}>{c.label}</span>
                </li>
              ))}
            </ul>
            {missingRequired.length > 0 && (
              <p className="mt-2 text-xs text-orange-600">
                Still needed for this category: {missingRequired.join(', ')}
              </p>
            )}

            <dl className="mt-4 grid gap-2 border-t border-gray-100 pt-3 text-xs sm:grid-cols-2">
              <div className="flex justify-between">
                <dt className="text-gray-500">Category</dt>
                <dd className="font-semibold">{path.map((c) => c.name).join(' › ') || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Options</dt>
                <dd className="font-semibold">
                  {activeAxes.length ? activeAxes.map((a) => a.label).join(' × ') : 'Single SKU'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Variants</dt>
                <dd className="font-semibold">{variantInputs.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Total stock</dt>
                <dd className="font-semibold">{totalStock}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Images</dt>
                <dd className="font-semibold">{imageUrls.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Details</dt>
                <dd className="font-semibold">{attributes.filter((a) => a.value.trim()).length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">GST</dt>
                <dd className="font-semibold">
                  {gst ? describeTaxDefault(rules, gst) : '…'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Storefront</dt>
                <dd className="font-semibold">{isVisible ? 'Visible' : 'Hidden'}</dd>
              </div>
              {rules.tryOnEligible && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">AI Try-On</dt>
                  <dd className="font-semibold">{tryOnEnabled ? 'Enabled' : 'Off'}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* --- Step nav + actions ------------------------------------------ */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-100 bg-white p-3">
          <button
            type="button"
            disabled={stepIndex === 0}
            onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].key)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-40"
          >
            ‹ Back
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || uploading || title.trim().length < 3 || !categoryId}
              onClick={() => void save('DRAFT')}
              title="Saves privately — no admin review, finish it later"
              className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50 disabled:opacity-40"
            >
              Save as draft
            </button>
            {stepIndex < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep(STEPS[stepIndex + 1].key)}
                className="rounded-lg bg-ink-900 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
              >
                Next ›
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || uploading}
                onClick={() => void save('SUBMIT')}
                className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? 'Saving…' : initial ? 'Save & resubmit' : 'Publish product'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* --- Sidebar: live preview + completeness ------------------------- */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <h2 className="text-sm font-bold text-ink-900">Product preview</h2>
          <p className="text-[11px] text-gray-400">How your listing appears to shoppers.</p>
          <div className="mt-3 overflow-hidden rounded-xl border border-gray-100">
            {imageUrls[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrls[0]} alt="" className="aspect-square w-full bg-cream-50 object-cover" />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center bg-cream-100 text-xs text-gray-400">
                Add an image
              </div>
            )}
            <div className="p-3">
              <p className="text-sm font-semibold text-ink-900">
                {title.trim() || 'Your product name'}
              </p>
              {shortDescription.trim() && (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500">{shortDescription}</p>
              )}
              <p className="mt-1.5">
                <span className="font-display text-lg font-bold text-ink-900">
                  {cheapest ? formatPaise(cheapest.pricePaise) : '₹—'}
                </span>
                {cheapest?.mrpPaise ? (
                  <>
                    <span className="ml-1.5 text-xs text-gray-400 line-through">
                      {formatPaise(cheapest.mrpPaise)}
                    </span>
                    <span className="ml-1.5 text-xs font-semibold text-green-700">
                      {Math.round(
                        ((cheapest.mrpPaise - cheapest.pricePaise) / cheapest.mrpPaise) * 100,
                      )}
                      % OFF
                    </span>
                  </>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">Inclusive of all taxes</p>
              <p className="mt-1 text-[11px] font-semibold text-green-700">
                {totalStock > 0 ? 'In stock' : allowBackorders ? 'Backorder' : 'Out of stock'}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(#B8860B ${completeness * 3.6}deg, #F1EFEA 0deg)`,
              }}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-bold text-ink-900">
                {completeness}%
              </span>
            </div>
            <div>
              <h2 className="text-sm font-bold text-ink-900">Product completeness</h2>
              <p className="text-[11px] text-gray-400">
                {completeness === 100
                  ? 'Everything filled in — ready to publish.'
                  : 'Complete the remaining fields for a stronger listing.'}
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-1.5 text-xs">
            {checklist.map((c) => (
              <li key={c.key} className="flex items-center gap-2">
                <span className={c.done ? 'text-green-600' : 'text-gray-300'}>
                  {c.done ? '✓' : '○'}
                </span>
                <span className={c.done ? 'text-ink-900' : 'text-gray-500'}>{c.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <h2 className="text-sm font-bold text-ink-900">Publishing guidelines</h2>
          <ul className="mt-2 space-y-1.5 text-[11px] text-gray-500">
            <li>• Use clear, well-lit images on a plain background.</li>
            <li>• Describe materials, specifications and warranty honestly.</li>
            <li>• Keep promotional words out of the product name.</li>
            <li>• Set stock accurately — overselling hurts your seller score.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
