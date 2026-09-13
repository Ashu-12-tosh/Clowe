import type { PrismaClient } from '@prisma/client';
import type { AttributeDef, VariantAxis } from '@clowe/shared';

/**
 * Per-department marketplace rules for the seeded root categories. Children
 * inherit everything unless an admin overrides a field on them.
 */
export interface RootRules {
  variantAxes: VariantAxis[];
  attributeSchema: AttributeDef[];
  tryOnEligible: boolean;
  sizeGuide: boolean;
  taxRule: 'APPAREL_SLAB' | null;
  defaultTaxRatePercent: number | null;
  hsnCode: string | null;
  returnWindowDays: number;
}

const COLOR: VariantAxis = { key: 'color', label: 'Colour' };
const SIZE: VariantAxis = { key: 'size', label: 'Size', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] };

const ORIGIN: AttributeDef = { key: 'country_of_origin', label: 'Country of origin', type: 'text', required: true };
const MANUFACTURER: AttributeDef = { key: 'manufacturer', label: 'Manufacturer / packer', type: 'text' };
const WARRANTY: AttributeDef = { key: 'warranty', label: 'Warranty', type: 'text', required: true, placeholder: 'e.g. 1 year manufacturer warranty' };
const MODEL_NUMBER: AttributeDef = { key: 'model_number', label: 'Model number', type: 'text', required: true };
const IN_THE_BOX: AttributeDef = { key: 'in_the_box', label: 'In the box', type: 'text' };

export const ROOT_RULES: Record<string, RootRules> = {
  electronics: {
    variantAxes: [COLOR, { key: 'storage', label: 'Storage' }, { key: 'ram', label: 'RAM' }],
    attributeSchema: [
      MODEL_NUMBER,
      WARRANTY,
      IN_THE_BOX,
      { key: 'power', label: 'Power / battery', type: 'text' },
      { key: 'connectivity', label: 'Connectivity', type: 'text' },
      { key: 'dimensions', label: 'Dimensions', type: 'text' },
      ORIGIN,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 18,
    hsnCode: '8471',
    returnWindowDays: 10,
  },
  mobiles: {
    variantAxes: [COLOR, { key: 'storage', label: 'Storage', values: ['64GB', '128GB', '256GB', '512GB'] }, { key: 'ram', label: 'RAM', values: ['4GB', '6GB', '8GB', '12GB'] }],
    attributeSchema: [
      MODEL_NUMBER,
      WARRANTY,
      { key: 'display', label: 'Display', type: 'text' },
      { key: 'processor', label: 'Processor', type: 'text' },
      { key: 'battery', label: 'Battery', type: 'text', unit: 'mAh' },
      { key: 'camera', label: 'Camera', type: 'text' },
      { key: 'os', label: 'Operating system', type: 'text' },
      IN_THE_BOX,
      ORIGIN,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 18,
    hsnCode: '8517',
    returnWindowDays: 7,
  },
  fashion: {
    variantAxes: [COLOR, SIZE],
    attributeSchema: [
      { key: 'fabric', label: 'Fabric', type: 'text', required: true },
      { key: 'fit', label: 'Fit', type: 'select', options: ['Slim', 'Regular', 'Relaxed', 'Oversized'] },
      { key: 'pattern', label: 'Pattern', type: 'text' },
      { key: 'sleeve', label: 'Sleeve length', type: 'text' },
      { key: 'occasion', label: 'Occasion', type: 'text' },
      { key: 'wash_care', label: 'Wash care', type: 'text' },
      ORIGIN,
    ],
    tryOnEligible: true,
    sizeGuide: true,
    taxRule: 'APPAREL_SLAB',
    defaultTaxRatePercent: null,
    hsnCode: '6109',
    returnWindowDays: 7,
  },
  'home-kitchen': {
    variantAxes: [COLOR, { key: 'capacity', label: 'Capacity' }],
    attributeSchema: [
      { key: 'material', label: 'Material', type: 'text', required: true },
      { key: 'dimensions', label: 'Dimensions', type: 'text' },
      { key: 'set_contents', label: 'Set contents', type: 'text' },
      { key: 'care', label: 'Care instructions', type: 'text' },
      WARRANTY,
      ORIGIN,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 18,
    hsnCode: null,
    returnWindowDays: 7,
  },
  beauty: {
    variantAxes: [{ key: 'shade', label: 'Shade' }, { key: 'volume', label: 'Volume / size' }],
    attributeSchema: [
      { key: 'net_quantity', label: 'Net quantity', type: 'text', required: true },
      { key: 'skin_type', label: 'Skin / hair type', type: 'text' },
      { key: 'formulation', label: 'Formulation', type: 'text' },
      { key: 'ingredients', label: 'Key ingredients', type: 'text' },
      { key: 'shelf_life', label: 'Shelf life', type: 'text', required: true },
      ORIGIN,
      MANUFACTURER,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 18,
    hsnCode: '3304',
    returnWindowDays: 7,
  },
  books: {
    variantAxes: [{ key: 'format', label: 'Format', values: ['Paperback', 'Hardcover'] }, { key: 'language', label: 'Language' }],
    attributeSchema: [
      { key: 'author', label: 'Author', type: 'text', required: true },
      { key: 'publisher', label: 'Publisher', type: 'text' },
      { key: 'isbn', label: 'ISBN', type: 'text', required: true },
      { key: 'pages', label: 'Pages', type: 'number' },
      { key: 'edition', label: 'Edition', type: 'text' },
      { key: 'language', label: 'Language', type: 'text' },
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 0,
    hsnCode: '4901',
    returnWindowDays: 7,
  },
  supplements: {
    variantAxes: [{ key: 'flavour', label: 'Flavour' }, { key: 'weight', label: 'Weight' }],
    attributeSchema: [
      { key: 'net_quantity', label: 'Net quantity', type: 'text', required: true },
      { key: 'serving_size', label: 'Serving size', type: 'text' },
      { key: 'ingredients', label: 'Ingredients', type: 'text', required: true },
      { key: 'shelf_life', label: 'Shelf life', type: 'text', required: true },
      { key: 'fssai', label: 'FSSAI licence no.', type: 'text' },
      ORIGIN,
      MANUFACTURER,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 18,
    hsnCode: '2106',
    returnWindowDays: 7,
  },
  sports: {
    variantAxes: [COLOR, SIZE],
    attributeSchema: [
      { key: 'material', label: 'Material', type: 'text' },
      { key: 'suitable_for', label: 'Suitable for', type: 'text' },
      { key: 'dimensions', label: 'Dimensions / weight', type: 'text' },
      WARRANTY,
      ORIGIN,
    ],
    tryOnEligible: false,
    sizeGuide: true,
    taxRule: null,
    defaultTaxRatePercent: 12,
    hsnCode: '9506',
    returnWindowDays: 7,
  },
  gaming: {
    variantAxes: [{ key: 'platform', label: 'Platform', values: ['PC', 'PlayStation 5', 'Xbox Series X', 'Nintendo Switch'] }, { key: 'edition', label: 'Edition' }, COLOR],
    attributeSchema: [
      { key: 'genre', label: 'Genre', type: 'text' },
      { key: 'region', label: 'Region', type: 'text' },
      WARRANTY,
      IN_THE_BOX,
      ORIGIN,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 18,
    hsnCode: null,
    returnWindowDays: 7,
  },
  grocery: {
    variantAxes: [{ key: 'weight', label: 'Weight / pack' }],
    attributeSchema: [
      { key: 'net_quantity', label: 'Net quantity', type: 'text', required: true },
      { key: 'shelf_life', label: 'Shelf life / best before', type: 'text', required: true },
      { key: 'ingredients', label: 'Ingredients', type: 'text' },
      { key: 'fssai', label: 'FSSAI licence no.', type: 'text' },
      { key: 'veg', label: 'Vegetarian', type: 'select', options: ['Veg', 'Non-veg', 'N/A'] },
      ORIGIN,
      MANUFACTURER,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 5,
    hsnCode: null,
    returnWindowDays: 2,
  },
  'toys-kids': {
    variantAxes: [COLOR, { key: 'size', label: 'Size / age' }],
    attributeSchema: [
      { key: 'age_group', label: 'Age group', type: 'text', required: true },
      { key: 'material', label: 'Material', type: 'text' },
      { key: 'safety', label: 'Safety certification', type: 'text' },
      { key: 'battery_required', label: 'Batteries required', type: 'select', options: ['No', 'Yes - included', 'Yes - not included'] },
      ORIGIN,
      MANUFACTURER,
    ],
    tryOnEligible: false,
    sizeGuide: false,
    taxRule: null,
    defaultTaxRatePercent: 12,
    hsnCode: '9503',
    returnWindowDays: 7,
  },
};


/**
 * Child overrides. A child inherits its root's rules unless a field is set
 * here.
 *
 * Try-on only works on garments worn on the torso or legs — the model places
 * a top, a bottom or a one-piece onto a photo of a person. Shoes, bags,
 * watches, sunglasses, jewellery and caps inherit Fashion's tryOnEligible
 * otherwise, and every attempt on one burns a provider credit to produce a
 * result nobody can use.
 */
export const CHILD_RULE_OVERRIDES: Record<string, Partial<RootRules>> = {
  'fashion-footwear': { tryOnEligible: false },
  'fashion-bags': { tryOnEligible: false, sizeGuide: false },
  'fashion-watches': { tryOnEligible: false, sizeGuide: false },
  'fashion-sunglasses': { tryOnEligible: false, sizeGuide: false },
  'fashion-jewellery': { tryOnEligible: false, sizeGuide: false },
  'fashion-caps': { tryOnEligible: false },
  // Try-on would render a customer in underwear from a photo they uploaded
  // to shop with. Off at the department level, and isSensitiveForTryOn()
  // catches the same garments listed under any other category.
  'fashion-innerwear': { tryOnEligible: false },
  'fashion-accessories': { tryOnEligible: false },
};

/** Apply ROOT_RULES to the seeded roots (idempotent). */
export async function seedCategoryRules(prisma: PrismaClient): Promise<number> {
  let updated = 0;
  for (const [slug, rules] of Object.entries(ROOT_RULES)) {
    const result = await prisma.category.updateMany({
      where: { slug },
      data: {
        variantAxes: rules.variantAxes,
        attributeSchema: rules.attributeSchema,
        tryOnEligible: rules.tryOnEligible,
        sizeGuide: rules.sizeGuide,
        taxRule: rules.taxRule,
        defaultTaxRatePercent: rules.defaultTaxRatePercent,
        hsnCode: rules.hsnCode,
        returnWindowDays: rules.returnWindowDays,
      },
    });
    updated += result.count;
  }

  // Then the per-child exceptions, which only set the fields they name.
  for (const [slug, overrides] of Object.entries(CHILD_RULE_OVERRIDES)) {
    const result = await prisma.category.updateMany({ where: { slug }, data: overrides });
    updated += result.count;
  }
  return updated;
}
