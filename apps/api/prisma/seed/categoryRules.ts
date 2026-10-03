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
  taxRule: 'VALUE_SLAB' | null;
  defaultTaxRatePercent: number | null;
  hsnCode: string | null;
  /** Null: follow the platform return window setting. Set only where a category truly differs. */
  returnWindowDays: number | null;
}

const COLOR: VariantAxis = { key: 'color', label: 'Colour' };
const SIZE: VariantAxis = { key: 'size', label: 'Size', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] };
const STORAGE: VariantAxis = { key: 'storage', label: 'Storage' };
const RAM: VariantAxis = { key: 'ram', label: 'RAM' };
/** Mechanical keyboard switch type; the only non-colour axis computer accessories vary on. */
const SWITCH: VariantAxis = { key: 'switch', label: 'Switch', values: ['Red Switch', 'Brown Switch', 'Blue Switch'] };

const ORIGIN: AttributeDef = { key: 'country_of_origin', label: 'Country of origin', type: 'text', required: true };
const MANUFACTURER: AttributeDef = { key: 'manufacturer', label: 'Manufacturer / packer', type: 'text' };
const WARRANTY: AttributeDef = { key: 'warranty', label: 'Warranty', type: 'text', required: true, placeholder: 'e.g. 1 year manufacturer warranty' };
const MODEL_NUMBER: AttributeDef = { key: 'model_number', label: 'Model number', type: 'text', required: true };
const IN_THE_BOX: AttributeDef = { key: 'in_the_box', label: 'In the box', type: 'text' };

export const ROOT_RULES: Record<string, RootRules> = {
  electronics: {
    // Storage and RAM are declared on the children that fill them (see
    // CHILD_RULE_OVERRIDES); on the root they reached headphones, speakers
    // and appliances as axes those never use.
    variantAxes: [COLOR],
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
    // Follows the platform window since 2026-10-09; it used to set its own.
    returnWindowDays: null,
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
    returnWindowDays: null,
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
    taxRule: 'VALUE_SLAB',
    defaultTaxRatePercent: null,
    hsnCode: '6109',
    returnWindowDays: null,
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
    returnWindowDays: null,
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
    returnWindowDays: null,
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
    returnWindowDays: null,
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
    defaultTaxRatePercent: 5,
    hsnCode: '2106',
    returnWindowDays: null,
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
    defaultTaxRatePercent: 5,
    hsnCode: '9506',
    returnWindowDays: null,
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
    hsnCode: '9504',
    returnWindowDays: null,
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
    defaultTaxRatePercent: 5,
    hsnCode: '9503',
    returnWindowDays: null,
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
  // Electronics: the option axes each department actually varies on. The
  // root declares only colour, so a category not listed here offers colour
  // alone and a seller adds anything else by hand.
  'electronics-laptops': { variantAxes: [COLOR, STORAGE, RAM] },
  'electronics-smartphones': { variantAxes: [COLOR, STORAGE] },
  'electronics-tablets': { variantAxes: [COLOR, STORAGE] },
  'electronics-accessories': { variantAxes: [COLOR, SWITCH] },
};

/**
 * GST by department, where a child differs from its root. GST 2.0 rates
 * (Notification 9/2025-Central Tax (Rate), in force 22.09.2025; nil list
 * 10/2025-CT(R)). Categories marked mixed hold goods at more than one rate;
 * the dominant one is used until products carry their own classification.
 * The migration 20261002120000_gst_two_point_zero applies the same table to
 * a live catalog — both are generated from one list, so they cannot drift.
 */
export const CHILD_GST_OVERRIDES: Record<string, Pick<RootRules, 'taxRule' | 'defaultTaxRatePercent' | 'hsnCode'>> = {
  'fashion-footwear': { taxRule: 'VALUE_SLAB', defaultTaxRatePercent: null, hsnCode: '6403' }, // per pair: Sch I 392 / Sch II 202-206
  'fashion-bags': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '4202' }, // Sch II 145 (cotton/jute handbags 5%: mixed)
  'fashion-watches': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '9102' }, // Sch II 583-584
  'fashion-sunglasses': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '9004' }, // Sch II 558
  'fashion-jewellery': { taxRule: null, defaultTaxRatePercent: 3, hsnCode: '7117' }, // Sch IV 10, 14
  'fashion-caps': { taxRule: null, defaultTaxRatePercent: 5, hsnCode: '6505' }, // textile caps: Sch I 393-394
  'fashion-accessories': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '4203' }, // belts Sch II 146 (umbrellas, combs 5%: mixed)
  'electronics-accessories': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8471' }, // 
  'electronics-appliances': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8516' }, // mixed appliances, all 18%
  'electronics-cameras': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8525' }, // Sch II 497
  'electronics-drones': { taxRule: null, defaultTaxRatePercent: 5, hsnCode: '8806' }, // Sch I 464
  'electronics-gaming': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '9504' }, // Sch II 617
  'electronics-headphones': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8518' }, // Sch II 491
  'electronics-laptops': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8471' }, // Sch II 456
  'electronics-smartphones': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8517' }, // Sch II 490
  'electronics-smartwatches': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8517' }, // Sch II 490
  'electronics-speakers': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8518' }, // Sch II 491
  'electronics-tablets': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8471' }, // Sch II 456
  'electronics-tvs': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '8528' }, // Sch II 500, all sizes (was 28)
  'home-bedding': { taxRule: 'VALUE_SLAB', defaultTaxRatePercent: null, hsnCode: '6302' }, // made-up textiles per piece: Sch I 390 / Sch II 199
  'home-cookware': { taxRule: null, defaultTaxRatePercent: 5, hsnCode: '7323' }, // metal/ceramic utensils Sch I 416-419 (plastic 18%: mixed)
  'home-decor': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: null }, // mixed (carpets, candles 5%); standard rate
  'home-furniture': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '9403' }, // Sch II 612
  'home-appliances': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: null }, // 
  'beauty-haircare': { taxRule: null, defaultTaxRatePercent: 5, hsnCode: '3305' }, // shampoo, hair oil Sch I 245-246 (other hair products 18%: mixed)
  'beauty-fragrances': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '3303' }, // Sch II 64
  'sports-fitness': { taxRule: null, defaultTaxRatePercent: 18, hsnCode: '9506' }, // gym equipment Sch II 619
  'sports-sportswear': { taxRule: 'VALUE_SLAB', defaultTaxRatePercent: null, hsnCode: '6211' }, // apparel
  'toys-school': { taxRule: null, defaultTaxRatePercent: 0, hsnCode: '4820' }, // notebooks, pencils nil (pens, diaries, bags 18%: mixed)
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
  for (const [slug, gst] of Object.entries(CHILD_GST_OVERRIDES)) {
    const result = await prisma.category.updateMany({ where: { slug }, data: gst });
    updated += result.count;
  }
  return updated;
}
