// ---------------------------------------------------------------------------
// Which fee-schedule category each of Clowe's categories is charged under, by
// slug. The owner fixed four (Men › Shirts, Men › Trousers, Mobiles, Shoes);
// the rest are the closest row of the sheet, and `note` marks the ones that
// are a judgement call. A category not listed here inherits its parent's;
// with none up the tree it keeps its flat referral percent. Applied by
// scripts/importReferralFees.ts --apply, after a dry run.
// ---------------------------------------------------------------------------

export interface CategoryMappingEntry {
  sheetCategory: string;
  /** Why this row, where it is not obvious. */
  note?: string;
}

export const CATEGORY_MAPPING: Record<string, CategoryMappingEntry> = {
  // Beauty
  beauty: { sheetCategory: 'Beauty - Other products' },
  'beauty-fragrances': { sheetCategory: 'Beauty - Fragrance' },
  'beauty-haircare': { sheetCategory: 'Beauty - Haircare, Bath and Shower' },
  'beauty-makeup': { sheetCategory: 'Beauty - Make-up' },
  'beauty-skincare': { sheetCategory: 'Beauty - Other products', note: 'the sheet has no skincare row' },
  // Books
  books: { sheetCategory: 'Books' },
  'books-academic': { sheetCategory: 'Books' },
  'books-children': { sheetCategory: 'Books' },
  'books-fiction': { sheetCategory: 'Books' },
  'books-non-fiction': { sheetCategory: 'Books' },
  // Electronics
  electronics: {
    sheetCategory: 'Electronic Devices (Excluding TV, Camera and Camcorder, Camera Lenses and Accessories, GPS Devices and Speakers)',
    note: 'the department itself: the general electronics row',
  },
  'electronics-accessories': { sheetCategory: 'Accessories - Electronics, PC and Wireless', note: 'Computer Accessories; keyboards and mice have their own row' },
  'electronics-appliances': { sheetCategory: 'Small Appliances', note: 'Home Appliances; large ones would be Major Appliances' },
  'electronics-cameras': { sheetCategory: 'Camera and Camcorder' },
  'electronics-drones': { sheetCategory: 'Toys - Drones', note: 'the only drone row is under Toys' },
  'electronics-gaming': { sheetCategory: 'Video Games - Other products' },
  'electronics-headphones': { sheetCategory: 'Headsets, Headphones and Earphones' },
  'electronics-laptops': { sheetCategory: 'Laptops' },
  'electronics-smartphones': { sheetCategory: 'Mobile Phones' },
  'electronics-smartwatches': { sheetCategory: 'Smart Watches and Accessories' },
  'electronics-speakers': { sheetCategory: 'Speakers' },
  'electronics-tablets': { sheetCategory: 'Tablets' },
  'electronics-tvs': { sheetCategory: 'Television' },
  // Fashion
  fashion: { sheetCategory: 'Apparel - Other products' },
  'fashion-accessories': { sheetCategory: 'Apparel - Accessories' },
  'fashion-bags': { sheetCategory: 'Handbags', note: 'Bags & Wallets; backpacks have their own row' },
  'fashion-caps': { sheetCategory: 'Apparel - Accessories' },
  'fashion-ethnic': { sheetCategory: 'Apparel - Ethnic Wear' },
  'fashion-footwear': { sheetCategory: 'Shoes' },
  'fashion-innerwear': { sheetCategory: 'Apparel - Other Innerwear', note: "women's innerwear has its own row" },
  'fashion-jewellery': { sheetCategory: 'Fashion Jewellery' },
  'fashion-kids': { sheetCategory: 'Apparel - Other products', note: 'kids clothing; only babywear has a row' },
  'fashion-men': { sheetCategory: 'Apparel - Other products' },
  'fashion-sunglasses': { sheetCategory: 'Eyewear - Sunglasses, Frames and Zero Power Eye Glasses' },
  'fashion-watches': { sheetCategory: 'Watches' },
  'fashion-winter': { sheetCategory: 'Apparel - Sweat Shirts and Jackets' },
  'fashion-women': { sheetCategory: 'Apparel - Other products' },
  'men-shirts': { sheetCategory: 'Apparel - Shirts' },
  'men-trousers': { sheetCategory: 'Pants - Trousers, Jeans, Trackpants and Leggings' },
  // Gaming
  gaming: { sheetCategory: 'Video Games - Other products' },
  'gaming-accessories': { sheetCategory: 'Video Games - Accessories' },
  'gaming-consoles': { sheetCategory: 'Video Games - Consoles' },
  'gaming-games': { sheetCategory: 'Video Games - Other products' },
  // Grocery
  grocery: { sheetCategory: 'Grocery and Gourmet - Other products' },
  'grocery-packaged': { sheetCategory: 'Grocery and Gourmet - Other products' },
  'grocery-snacks': { sheetCategory: 'Grocery and Gourmet - Other products', note: 'Snacks & Beverages; drinks alone would be Grocery and Gourmet - Beverages' },
  'grocery-staples': { sheetCategory: 'Grocery and Gourmet - Other products', note: 'oils, spices and dry fruits have their own rows' },
  // Home & Kitchen
  'home-kitchen': { sheetCategory: 'Home - Other products' },
  'home-appliances': { sheetCategory: 'Small Appliances' },
  'home-bedding': { sheetCategory: 'Bedsheets, Blankets and Covers' },
  'home-cookware': { sheetCategory: 'Cookware, Tableware and Dinnerware' },
  'home-decor': { sheetCategory: 'Home Decor Products' },
  'home-furniture': { sheetCategory: 'Furniture - Other products', note: 'sofas, beds and wardrobes have their own row' },
  // Mobiles
  mobiles: { sheetCategory: 'Mobile Phones' },
  'mobiles-accessories': { sheetCategory: 'Accessories - Electronics, PC and Wireless', note: 'cases and screen guards have their own row' },
  'mobiles-smartphones': { sheetCategory: 'Mobile Phones' },
  'mobiles-tablets': { sheetCategory: 'Tablets' },
  // Sports
  sports: { sheetCategory: 'Sports - Other products' },
  'sports-fitness': { sheetCategory: 'Gym Equipments' },
  'sports-outdoor': { sheetCategory: 'Sports - Other products' },
  'sports-sportswear': { sheetCategory: 'Apparel - Other products', note: 'clothing; sports shoes would be Sports - Footwear' },
  // Supplements
  supplements: { sheetCategory: 'Health and Household - Vitamins and Mineral Health Supplements' },
  'supplements-fitness': { sheetCategory: 'Health and Household - Sports Nutrition and Meal Replacement Shakes' },
  'supplements-protein': { sheetCategory: 'Health and Household - Sports Nutrition and Meal Replacement Shakes' },
  'supplements-vitamins': { sheetCategory: 'Health and Household - Vitamins and Mineral Health Supplements' },
  // Toys & Kids
  'toys-kids': { sheetCategory: 'Toys - Other products' },
  'toys-baby-care': { sheetCategory: 'Baby - Other products' },
  'toys-school': { sheetCategory: 'Office Products - Office Supplies', note: 'School Supplies' },
  'toys-toys': { sheetCategory: 'Toys - Other products' },
};

/**
 * Gaps the "same family" rule cannot fill, and the row the owner chose for
 * each. Empty until they choose: those prices keep the category's flat rate.
 */
export const GAP_DONORS: Record<string, string> = {};
