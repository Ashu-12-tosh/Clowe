import type { PrismaClient } from '@prisma/client';
import type { AttributeDef, ProductAttribute } from '@clowe/shared';
import { loadCategoryLookup } from './categoryRulesLookup';
import { hashSeed, makeRng } from './rng';

/**
 * Plausible spec sheets for the demo catalog.
 *
 * Every demo product gets a value for each field its category rule declares,
 * drawn from small pools per department (and per subcategory where the
 * department's pool would read wrong — a shoe has no sleeve length). The
 * generator is seeded from the product's slug, so a re-seed and the backfill
 * write byte-identical rows, and neither disturbs the sequence the seeds
 * already use for prices and ratings.
 */

/** Every description the seeds write carries this; it is how a demo product is told from a seller's. */
export const DEMO_PRODUCT_MARKER = 'Seeded demo product';

export interface DemoProductRef {
  slug: string;
  title: string;
  brand: string | null;
  categorySlug: string;
  rootSlug: string;
}

type Pool = string[];
/** Pools by attribute key; a subcategory entry overrides its root's for that key. */
type Pools = Record<string, Pool>;

const INDIA_MOSTLY: Pool = ['India', 'India', 'India', 'India', 'Bangladesh', 'Vietnam'];
const ASIA_ELECTRONICS: Pool = ['China', 'China', 'India', 'Vietnam', 'Taiwan'];

const ROOT_POOLS: Record<string, Pools> = {
  fashion: {
    fabric: ['100% Cotton', 'Cotton blend', 'Linen', 'Polyester', 'Viscose rayon', 'Cotton Lycra', 'Modal'],
    pattern: ['Solid', 'Striped', 'Checked', 'Printed', 'Floral', 'Textured'],
    sleeve: ['Half sleeve', 'Full sleeve', 'Short sleeve', 'Three-quarter sleeve', 'Sleeveless'],
    occasion: ['Casual', 'Everyday', 'Office', 'Party', 'Festive'],
    wash_care: ['Machine wash cold', 'Gentle machine wash', 'Hand wash only', 'Machine wash, do not bleach'],
    country_of_origin: INDIA_MOSTLY,
  },
  electronics: {
    warranty: ['1 year manufacturer warranty', '1 year brand warranty', '2 years manufacturer warranty', '6 months warranty'],
    in_the_box: ['Device, USB cable, quick start guide'],
    power: ['USB powered'],
    connectivity: ['Bluetooth 5.0'],
    dimensions: ['15 × 10 × 5 cm, 300 g'],
    country_of_origin: ASIA_ELECTRONICS,
  },
  mobiles: {
    warranty: ['1 year manufacturer warranty', '1 year brand warranty'],
    display: ['6.6" FHD+ AMOLED, 120Hz', '6.5" FHD+ IPS LCD, 90Hz', '6.7" AMOLED, 120Hz', '6.1" OLED, 60Hz'],
    processor: ['Snapdragon 7 Gen 1', 'Dimensity 8100', 'Snapdragon 8 Gen 2', 'Helio G99', 'Exynos 1380'],
    battery: ['5000', '4500', '5500', '4300'],
    camera: ['50MP + 8MP ultrawide, 16MP front', '108MP main + 2MP macro, 32MP front', '64MP OIS + 12MP ultrawide, 16MP front'],
    os: ['Android 14', 'Android 13', 'Android 14 with 2 OS updates promised'],
    in_the_box: ['Handset, charger, USB-C cable, SIM tool', 'Handset, USB-C cable, SIM tool, case'],
    country_of_origin: ['India', 'India', 'China', 'Vietnam'],
  },
  'home-kitchen': {
    material: ['Stainless steel', 'Borosilicate glass', 'Ceramic', 'Cast iron', 'Food-grade plastic', 'Solid wood', 'Cotton'],
    dimensions: ['30 × 20 × 10 cm', '25 × 25 × 8 cm', '45 × 30 × 15 cm', '20 × 15 × 12 cm'],
    set_contents: ['1 piece', 'Set of 2', 'Set of 4', 'Set of 6'],
    care: ['Dishwasher safe', 'Hand wash only', 'Wipe clean with a damp cloth'],
    warranty: ['1 year warranty', '2 years warranty', '6 months warranty'],
    country_of_origin: ['India', 'India', 'China'],
  },
  beauty: {
    net_quantity: ['50 ml', '100 ml', '200 ml', '30 g', '15 ml', '150 ml'],
    skin_type: ['All skin types', 'Dry', 'Oily', 'Combination', 'Sensitive'],
    formulation: ['Cream', 'Gel', 'Serum', 'Liquid', 'Lotion'],
    ingredients: ['Hyaluronic acid, niacinamide', 'Vitamin C, aloe vera', 'Argan oil, keratin', 'Shea butter, vitamin E', 'Salicylic acid, zinc'],
    shelf_life: ['24 months', '36 months', '18 months'],
    country_of_origin: ['India'],
  },
  books: {
    author: ['A. R. Menon', 'Priya Deshmukh', 'Rohan Iyer', 'S. K. Banerjee', 'Meera Kulkarni', 'Vikram Nair', 'Tara Sethi'],
    publisher: ['Inkwell Press', 'Harbour Books', 'Saffron House', 'Lantern & Quill'],
    pages: ['192', '256', '320', '412', '288'],
    edition: ['1st edition', '2nd edition', 'Reprint', 'Revised edition'],
    language: ['English', 'English', 'English', 'Hindi'],
  },
  supplements: {
    net_quantity: ['1 kg', '500 g', '2 kg', '60 capsules', '90 tablets', '120 capsules'],
    serving_size: ['1 scoop (30 g)', '1 capsule', '2 tablets', '1 scoop (32 g)'],
    ingredients: ['Whey protein concentrate, cocoa, stevia', 'Vitamin D3, calcium, magnesium', 'Creatine monohydrate', 'Multivitamin blend, zinc, biotin'],
    shelf_life: ['18 months', '24 months'],
    country_of_origin: ['India', 'India', 'USA'],
  },
  sports: {
    material: ['Polyester', 'Rubber', 'Powder-coated steel', 'Nylon', 'EVA foam', 'Cotton blend'],
    suitable_for: ['Gym', 'Running', 'Yoga', 'Outdoor', 'Cricket', 'Home workouts'],
    dimensions: ['180 × 60 cm, 1.2 kg', '30 × 15 × 10 cm, 800 g', 'Standard, 450 g', '120 × 40 cm, 2 kg'],
    warranty: ['6 months warranty', '1 year warranty', 'No warranty'],
    country_of_origin: ['India', 'India', 'China'],
  },
  gaming: {
    genre: ['Action', 'Adventure', 'Sports', 'Racing', 'Role-playing', 'Strategy'],
    region: ['India (Region 2)', 'Global', 'Asia'],
    warranty: ['1 year manufacturer warranty', '6 months warranty'],
    in_the_box: ['Game disc, manual', 'Console, controller, HDMI cable, power cable', 'Controller, USB-C cable'],
    country_of_origin: ['China', 'Japan', 'India'],
  },
  grocery: {
    net_quantity: ['500 g', '1 kg', '250 g', '5 kg', '200 g'],
    shelf_life: ['6 months from packaging', '12 months from packaging', '9 months from packaging'],
    ingredients: ['Wheat flour, salt', 'Rice', 'Sugar, cocoa, milk solids', 'Peanuts, salt, spices', 'Tea leaves'],
    country_of_origin: ['India'],
  },
  'toys-kids': {
    age_group: ['3+ years', '5+ years', '8+ years', '1–3 years', '6+ years'],
    material: ['ABS plastic', 'Wood', 'Cotton fabric', 'Silicone', 'Card and paper'],
    safety: ['BIS certified', 'EN71 certified', 'Non-toxic, BIS certified'],
    country_of_origin: ['India', 'India', 'China'],
  },
};

const CHILD_POOLS: Record<string, Pools> = {
  'fashion-footwear': {
    fabric: ['Synthetic leather', 'Mesh', 'Canvas', 'Genuine leather', 'Knit upper'],
    wash_care: ['Wipe with a dry cloth', 'Wipe clean with a damp cloth'],
    occasion: ['Casual', 'Sports', 'Everyday', 'Formal'],
  },
  'fashion-bags': {
    fabric: ['PU leather', 'Canvas', 'Nylon', 'Genuine leather'],
    wash_care: ['Wipe with a dry cloth', 'Spot clean only'],
    occasion: ['Everyday', 'Office', 'Travel', 'Party'],
  },
  'fashion-watches': {
    fabric: ['Stainless steel', 'Silicone strap', 'Leather strap', 'Nylon strap'],
    wash_care: ['Wipe with a soft cloth', 'Keep away from water and perfume'],
    occasion: ['Everyday', 'Formal', 'Sports'],
  },
  'fashion-sunglasses': {
    fabric: ['Acetate', 'Metal', 'Polycarbonate', 'TR90'],
    wash_care: ['Wipe with the supplied cloth', 'Rinse with water, wipe with a soft cloth'],
    occasion: ['Everyday', 'Travel', 'Sports'],
  },
  'fashion-jewellery': {
    fabric: ['Brass with gold plating', 'Sterling silver', 'Alloy', 'Oxidised silver'],
    wash_care: ['Wipe with a soft cloth', 'Keep away from water and perfume'],
    occasion: ['Festive', 'Party', 'Everyday', 'Wedding'],
  },
  'fashion-caps': {
    fabric: ['Cotton twill', 'Polyester mesh', 'Acrylic wool'],
    wash_care: ['Hand wash only', 'Spot clean only'],
    occasion: ['Casual', 'Sports', 'Everyday'],
  },
  'fashion-accessories': {
    fabric: ['Genuine leather', 'Canvas', 'Alloy', 'PU leather'],
    wash_care: ['Wipe with a dry cloth'],
    occasion: ['Everyday', 'Office', 'Casual'],
  },
  'fashion-innerwear': {
    fabric: ['Cotton Lycra', '100% Cotton', 'Modal', 'Micro modal'],
    occasion: ['Everyday'],
  },
  'fashion-ethnic': {
    fabric: ['Cotton', 'Silk blend', 'Chanderi silk', 'Rayon', 'Georgette', 'Banarasi silk'],
    pattern: ['Embroidered', 'Printed', 'Woven', 'Solid', 'Zari work'],
    occasion: ['Festive', 'Wedding', 'Party', 'Everyday'],
    wash_care: ['Dry clean only', 'Hand wash only', 'Gentle machine wash'],
  },
  'fashion-winter': {
    fabric: ['Polyester fleece', 'Wool blend', 'Acrylic', 'Nylon shell, polyester fill', 'Cotton fleece'],
    sleeve: ['Full sleeve'],
    occasion: ['Casual', 'Everyday', 'Outdoor'],
  },
  'fashion-kids': {
    fabric: ['100% Cotton', 'Cotton blend', 'Cotton fleece'],
    occasion: ['Everyday', 'Casual', 'Party'],
  },
  'electronics-laptops': {
    in_the_box: ['Laptop, 65W charger, user guide', 'Laptop, 90W charger, user guide'],
    power: ['65W USB-C adapter, 56Wh battery', '90W adapter, 70Wh battery', '65W adapter, 50Wh battery'],
    connectivity: ['Wi-Fi 6, Bluetooth 5.2, 2× USB-C, 2× USB-A, HDMI', 'Wi-Fi 6E, Bluetooth 5.3, Thunderbolt 4, HDMI 2.1'],
    dimensions: ['35.6 × 23.4 × 1.8 cm, 1.6 kg', '31.2 × 22.1 × 1.5 cm, 1.3 kg', '36.0 × 25.0 × 2.2 cm, 2.1 kg'],
  },
  'electronics-headphones': {
    in_the_box: ['Headphones, USB-C cable, carry pouch', 'Earbuds, charging case, 3 ear-tip sizes, USB-C cable'],
    power: ['Up to 40 hours playback, USB-C charging', 'Up to 30 hours with ANC, fast charge', '8 hours + 24 hours from the case'],
    connectivity: ['Bluetooth 5.3, multipoint, 3.5mm aux', 'Bluetooth 5.2, multipoint', 'Bluetooth 5.3, LDAC'],
    dimensions: ['18 × 16 × 7 cm, 250 g', '6 × 5 × 3 cm case, 48 g', '19 × 17 × 8 cm, 290 g'],
  },
  'electronics-accessories': {
    in_the_box: ['Keyboard, USB-C cable, keycap puller', 'Mouse, USB receiver, 1 AA battery', 'Device, USB-C cable, quick start guide'],
    power: ['Wired, USB powered', 'Rechargeable, up to 70 hours', '2 AAA batteries (included)'],
    connectivity: ['Bluetooth 5.1 + 2.4GHz USB receiver', 'Wired USB-C', 'Bluetooth 5.0, tri-device pairing'],
    dimensions: ['36 × 13 × 3.5 cm, 650 g', '12 × 6.5 × 4 cm, 95 g', '44 × 14 × 4 cm, 900 g'],
  },
  'electronics-smartphones': {
    in_the_box: ['Handset, charger, USB-C cable, SIM tool', 'Handset, USB-C cable, SIM tool, case'],
    power: ['5000mAh, 33W fast charging', '4500mAh, 67W fast charging', '5500mAh, 18W charging'],
    connectivity: ['5G, Wi-Fi 6, Bluetooth 5.3, NFC', '4G LTE, Wi-Fi 5, Bluetooth 5.1', '5G, Wi-Fi 6E, Bluetooth 5.3, NFC, IR blaster'],
    dimensions: ['16.2 × 7.5 × 0.8 cm, 195 g', '15.8 × 7.3 × 0.8 cm, 185 g', '16.5 × 7.6 × 0.9 cm, 205 g'],
  },
  'electronics-tablets': {
    in_the_box: ['Tablet, charger, USB-C cable', 'Tablet, USB-C cable, SIM tool'],
    power: ['8000mAh, 18W charging', '7700mAh, 33W charging'],
    connectivity: ['Wi-Fi 6, Bluetooth 5.2', 'Wi-Fi 5, Bluetooth 5.0, 4G LTE'],
    dimensions: ['25.4 × 16.5 × 0.7 cm, 480 g', '28.0 × 18.0 × 0.7 cm, 560 g'],
  },
  'electronics-tvs': {
    in_the_box: ['TV, remote, 2 AAA batteries, table stand, wall mount', 'TV, remote, 2 AAA batteries, table stand'],
    power: ['AC 100–240V, 120W', 'AC 100–240V, 90W', 'AC 100–240V, 180W'],
    connectivity: ['Wi-Fi, Bluetooth, 3× HDMI, 2× USB', 'Wi-Fi, Bluetooth, 4× HDMI 2.1, 2× USB, optical'],
    dimensions: ['96 × 56 × 8 cm, 7.5 kg', '123 × 71 × 8 cm, 12 kg', '145 × 84 × 9 cm, 18 kg'],
  },
  'electronics-smartwatches': {
    in_the_box: ['Watch, strap, magnetic charger', 'Watch, 2 straps, magnetic charger'],
    power: ['Up to 14 days battery', 'Up to 7 days battery', 'Up to 10 days battery, 5 days with AOD'],
    connectivity: ['Bluetooth 5.2, GPS', 'Bluetooth 5.3, Wi-Fi, GPS', 'Bluetooth 5.0'],
    dimensions: ['4.6 × 4.0 × 1.1 cm, 45 g', '4.2 × 3.6 × 1.1 cm, 38 g'],
  },
  'electronics-cameras': {
    in_the_box: ['Camera body, battery, charger, strap, body cap', 'Camera, battery, USB-C cable, wrist strap'],
    power: ['Rechargeable Li-ion, approx. 500 shots', 'Rechargeable Li-ion, approx. 350 shots, USB-C charging'],
    connectivity: ['Wi-Fi, Bluetooth, USB-C, micro HDMI', 'Wi-Fi, Bluetooth, USB-C'],
    dimensions: ['13 × 9 × 7 cm, 580 g', '12 × 8 × 6 cm, 420 g'],
  },
  'electronics-speakers': {
    in_the_box: ['Speaker, USB-C cable, aux cable', 'Speaker, USB-C cable'],
    power: ['12 hours playback, USB-C charging', '20 hours playback, USB-C charging', 'AC powered'],
    connectivity: ['Bluetooth 5.3, aux-in', 'Bluetooth 5.0, aux-in, USB', 'Bluetooth 5.3, Wi-Fi, HDMI ARC'],
    dimensions: ['20 × 8 × 8 cm, 600 g', '90 × 7 × 10 cm, 2.4 kg', '12 × 6 × 6 cm, 300 g'],
  },
  'electronics-gaming': {
    in_the_box: ['Controller, USB-C cable', 'Console, controller, HDMI cable, power cable'],
    power: ['Rechargeable, up to 20 hours', 'AC 100–240V, 200W'],
    connectivity: ['Bluetooth, USB-C wired', 'Wi-Fi 6, Bluetooth 5.1, 3× USB, HDMI 2.1'],
    dimensions: ['16 × 10 × 6 cm, 280 g', '39 × 26 × 10 cm, 4.5 kg'],
  },
  'electronics-appliances': {
    in_the_box: ['Appliance, user manual, warranty card', 'Appliance, accessories, user manual, warranty card'],
    power: ['AC 230V, 50Hz, 1200W', 'AC 230V, 50Hz, 1800W', 'AC 230V, 50Hz, 150W'],
    connectivity: ['Not applicable', 'Wi-Fi app control'],
    dimensions: ['40 × 30 × 25 cm, 5 kg', '60 × 60 × 85 cm, 65 kg', '30 × 20 × 35 cm, 3 kg'],
  },
  'electronics-drones': {
    in_the_box: ['Drone, remote controller, 2 batteries, charger, spare propellers', 'Drone, remote controller, battery, charger'],
    power: ['Intelligent flight battery, 31 min flight time', 'Intelligent flight battery, 25 min flight time'],
    connectivity: ['2.4/5.8GHz, up to 10 km range', '2.4GHz, up to 4 km range'],
    dimensions: ['14.5 × 9 × 6 cm folded, 249 g', '18 × 10 × 8 cm folded, 595 g'],
  },
};

/** Declared on the root for every child, but meaningless on these; a filled value would be a lie. */
const SKIPPED_KEYS: Record<string, string[]> = {
  'fashion-footwear': ['sleeve', 'fit'],
  'fashion-bags': ['sleeve', 'fit', 'pattern'],
  'fashion-watches': ['sleeve', 'fit', 'pattern'],
  'fashion-sunglasses': ['sleeve', 'fit', 'pattern'],
  'fashion-jewellery': ['sleeve', 'fit', 'pattern'],
  'fashion-caps': ['sleeve', 'fit'],
  'fashion-accessories': ['sleeve', 'fit', 'pattern'],
};

/** Garments with no sleeves at all; Fashion declares sleeve length for every child. */
const SLEEVELESS_GARMENT_RE = /\b(jeans|trousers|pants|shorts|skirt|joggers|leggings|chinos|palazzos?|saree|dupatta|lehenga|dhoti)\b/i;

function pick(rng: () => number, pool: readonly string[]): string {
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * A value the title already states wins over the draw: "Striped Half Sleeve
 * Tee" must not say Solid and Sleeveless. The draw still happens, so the
 * sequence behind every other field is the same whether or not a hint hits.
 */
function pickWithTitleHint(rng: () => number, pool: readonly string[], title: string): string {
  const drawn = pick(rng, pool);
  const hinted = pool.find((value) => {
    const firstWord = value.split(/[\s,]+/)[0]?.replace(/[^A-Za-z0-9-]/g, '');
    return firstWord && new RegExp(`\\b${firstWord}\\b`, 'i').test(title);
  });
  return hinted ?? drawn;
}

function digits(rng: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += Math.floor(rng() * 10);
  return out;
}

/** "Zephyr Aero 14 Laptop" → "ZA14"; the letters a model number is usually built from. */
function initialsOf(title: string): string {
  return (
    title
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase())
      .join('')
      .slice(0, 4) || 'CLW'
  );
}

/** ISBN-13 with a valid check digit, in the 978-93 (India) range. */
function isbn13(rng: () => number): string {
  const body = `97893${digits(rng, 7)}`;
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

/** Values that are built rather than drawn, because a pool would repeat. */
function generatedValue(key: string, rng: () => number, ref: DemoProductRef): string | null {
  switch (key) {
    case 'model_number':
      return `${initialsOf(ref.title)}-${digits(rng, 4)}`;
    case 'manufacturer':
      return `${ref.brand ?? 'Clowe'} Consumer Products Pvt. Ltd.`;
    case 'isbn':
      return isbn13(rng);
    case 'fssai':
      // 14-digit licence numbers; the leading 1 marks a central licence.
      return `1${digits(rng, 13)}`;
    default:
      return null;
  }
}

function poolFor(key: string, ref: DemoProductRef): Pool | undefined {
  return CHILD_POOLS[ref.categorySlug]?.[key] ?? ROOT_POOLS[ref.rootSlug]?.[key];
}

/**
 * One row per declared field, in the rule's order. A `select` field draws
 * from its own options; a field with neither a pool nor a generator is left
 * out rather than filled with nonsense.
 */
export function demoAttributesFor(ref: DemoProductRef, defs: readonly AttributeDef[]): ProductAttribute[] {
  const rng = makeRng(hashSeed(ref.slug));
  const skipped = new Set(SKIPPED_KEYS[ref.categorySlug] ?? []);
  if (SLEEVELESS_GARMENT_RE.test(ref.title)) skipped.add('sleeve');
  const rows: ProductAttribute[] = [];
  for (const def of defs) {
    if (skipped.has(def.key)) continue;
    let value: string | null = null;
    if (def.type === 'select' && def.options?.length) value = pickWithTitleHint(rng, def.options, ref.title);
    else {
      const pool = poolFor(def.key, ref);
      value = pool ? pickWithTitleHint(rng, pool, ref.title) : generatedValue(def.key, rng, ref);
    }
    if (value) rows.push({ key: def.key, label: def.label, value });
  }
  return rows;
}

export interface DemoAttributeSeedReport {
  /** Demo products that had no spec sheet. */
  empty: number;
  /** Of those, given rows. */
  filled: number;
  /** Rows written in total. */
  rows: number;
}

/**
 * Give every demo product with no spec sheet the rows a re-seed would write.
 * Only products the seeds wrote (their description carries the marker) and
 * only those with nothing stored: a seller's own listing is never touched,
 * and neither is a demo product someone has since edited.
 */
export async function seedDemoAttributes(prisma: PrismaClient): Promise<DemoAttributeSeedReport> {
  const { rulesById, slugById, rootSlugById } = await loadCategoryLookup(prisma);
  const products = await prisma.product.findMany({
    where: { description: { contains: DEMO_PRODUCT_MARKER } },
    select: { id: true, slug: true, title: true, brand: true, categoryId: true, attributes: true },
  });
  const report: DemoAttributeSeedReport = { empty: 0, filled: 0, rows: 0 };
  for (const p of products) {
    if (Array.isArray(p.attributes) && p.attributes.length > 0) continue;
    report.empty += 1;
    const rows = demoAttributesFor(
      {
        slug: p.slug,
        title: p.title,
        brand: p.brand,
        categorySlug: slugById.get(p.categoryId) ?? '',
        rootSlug: rootSlugById.get(p.categoryId) ?? '',
      },
      rulesById.get(p.categoryId)?.attributeSchema ?? [],
    );
    if (rows.length === 0) continue;
    await prisma.product.update({ where: { id: p.id }, data: { attributes: rows } });
    report.filled += 1;
    report.rows += rows.length;
  }
  return report;
}
