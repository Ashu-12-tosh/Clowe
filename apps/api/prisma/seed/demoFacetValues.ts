import type { PrismaClient, Prisma } from '@prisma/client';
import { normaliseAttributes, optionValuesFromJson, type ProductAttribute } from '@clowe/shared';
import { hasFacetValue, readFacet } from '../../src/services/facetData';
import { categoryRows, chainOf, facetsFromChain, invalidateCategoryRules } from '../../src/services/categoryRules';
import { DEMO_PRODUCT_MARKER } from './demoAttributes';
import { hashSeed, makeRng } from './rng';

/**
 * Values for the filter facets the demo catalog's spec sheets never had —
 * screen size and processor on laptops, resolution on TVs, type on shoes.
 *
 * What a product says about itself wins: its title first ("Raptor 15 Gaming
 * Laptop" is a 15.6" with a top-end processor), then another field of its own
 * spec sheet (5G from its connectivity line). Only where neither says anything
 * and any answer would be plausible is a value drawn from a pool, seeded by
 * the product so a re-run writes the same thing. A facet with no rule stays
 * empty for that product: the coverage report shows it, rather than a value
 * made up to fill the gap.
 *
 * Demo products only (the seeds' description marker), and only facets the
 * product has no value for — a seller's listing is never touched.
 */

type Value = string | ((m: RegExpMatchArray) => string);
interface Rule {
  /** First pattern that matches wins. */
  match?: [RegExp, Value][];
  /** Where the patterns look: 'title', or a spec-sheet key. Tried in order. */
  from?: string[];
  /** Otherwise one of these, seeded per product. */
  pool?: string[];
}

const title = (match: [RegExp, Value][], pool?: string[]): Rule => ({ match, ...(pool ? { pool } : {}) });

const SCREEN_FROM_DISPLAY: Rule = { match: [[/(\d{1,2}(?:\.\d)?)\s*(?:"|inch)/i, (m) => `${m[1]}"`]], from: ['display'] };
const NETWORK: Rule = {
  match: [[/5G/, '5G'], [/4G|LTE/i, '4G'], [/Wi-?Fi/i, 'Wi-Fi only']],
  from: ['title', 'connectivity'],
};
const CONNECTION: Rule = {
  match: [[/Bluetooth.*(aux|3\.5mm|USB-C wired|wired)|(aux|wired).*Bluetooth/i, 'Wireless + wired'], [/Bluetooth|2\.4GHz|Wi-?Fi/i, 'Wireless'], [/Wired|USB/i, 'Wired']],
  from: ['connectivity'],
};
const APPLIANCE_TYPE = title([
  [/refrigerator|fridge/i, 'Refrigerator'], [/washing|washer/i, 'Washing machine'], [/microwave|oven/i, 'Microwave'],
  [/air ?conditioner|\bAC\b|inverter split/i, 'Air conditioner'], [/air purifier/i, 'Air purifier'], [/water purifier|RO\b/i, 'Water purifier'],
  [/vacuum|robot clean/i, 'Vacuum cleaner'], [/mixer|grinder/i, 'Mixer grinder'], [/blender|mix\b|swiftmix/i, 'Blender'],
  [/fry/i, 'Air fryer'], [/coffee|brew/i, 'Coffee maker'], [/kettle/i, 'Kettle'], [/induction/i, 'Induction cooktop'],
  [/\bfan\b/i, 'Fan'],
]);
const GARMENT_TYPE = title([
  [/track ?pants/i, 'Track pants'], [/tracksuit/i, 'Tracksuit'], [/sports bra/i, 'Sports bra'], [/tights|leggings/i, 'Tights'],
  [/kurta set/i, 'Kurta set'], [/kurti/i, 'Kurti'], [/kurta/i, 'Kurta'], [/saree|sari\b/i, 'Saree'], [/lehenga/i, 'Lehenga'],
  [/salwar|anarkali|churidar/i, 'Salwar suit'], [/sherwani/i, 'Sherwani'], [/dupatta/i, 'Dupatta'], [/nehru/i, 'Nehru jacket'],
  [/polo/i, 'Polo'], [/t-?shirt|\btee\b/i, 'T-shirt'], [/shirt/i, 'Shirt'], [/jeans|denim/i, 'Jeans'], [/chinos?/i, 'Chinos'],
  [/trousers|pants|palazzo/i, 'Trousers'], [/shorts/i, 'Shorts'], [/joggers/i, 'Joggers'], [/puffer/i, 'Puffer jacket'],
  [/hoodie/i, 'Hoodie'], [/sweatshirt/i, 'Sweatshirt'], [/sweater|pullover|cardigan/i, 'Sweater'], [/coat|parka/i, 'Coat'],
  [/thermal/i, 'Thermal'], [/shawl|stole/i, 'Shawl'], [/jacket|bomber|windcheater/i, 'Jacket'], [/jumpsuit/i, 'Jumpsuit'],
  [/co-?ord/i, 'Co-ord set'], [/frock/i, 'Frock'], [/dress/i, 'Dress'], [/skirt/i, 'Skirt'], [/top|blouse|tunic|camisole/i, 'Top'],
  [/briefs/i, 'Briefs'], [/trunks/i, 'Trunks'], [/boxers/i, 'Boxers'], [/\bvests?\b/i, 'Vest'], [/\bbra\b/i, 'Bra'],
  [/panties|hipster/i, 'Panties'], [/socks/i, 'Socks'], [/\bset\b/i, 'Clothing set'],
]);
const SMARTPHONE: Record<string, Rule> = {
  ram: title([[/max|ultra|pro\b/i, '12GB'], [/lite|go\b/i, '6GB']], ['8GB', '8GB', '6GB', '12GB']),
  screen_size: {
    ...SCREEN_FROM_DISPLAY,
    from: ['display', 'title'],
    match: [...SCREEN_FROM_DISPLAY.match!, [/max|ultra/i, '6.7"'], [/lite|mini/i, '6.4"']],
    pool: ['6.5"', '6.6"', '6.6"', '6.7"'],
  },
  // Most phones sold now are 5G; one whose title and spec sheet say nothing is drawn mostly so.
  network: { ...NETWORK, pool: ['5G', '5G', '4G'] },
  processor: title([[/ultra|max|pro\b/i, 'Snapdragon 8 Gen 2'], [/lite|go\b/i, 'Helio G99']], ['Snapdragon 7 Gen 1', 'Dimensity 8100', 'Exynos 1380']),
};
const TABLET: Record<string, Rule> = {
  screen_size: { ...SCREEN_FROM_DISPLAY, from: ['display', 'title'], pool: ['10.1"', '10.9"', '11"', '12.4"'] },
  network: { ...NETWORK, match: [[/5G/, '5G'], [/4G|LTE/i, '4G']], pool: ['Wi-Fi only'] },
};

export const DEMO_FACET_RULES: Record<string, Record<string, Rule>> = {
  'electronics-laptops': {
    processor: title(
      [[/gaming|workstation|creator|raptor|studio/i, 'Intel Core i9'], [/pro\b|ultra/i, 'Intel Core i7'], [/air|slim|go\b|flex/i, 'Intel Core i5']],
      ['Intel Core i5', 'Intel Core i7', 'AMD Ryzen 5', 'AMD Ryzen 7', 'Intel Core Ultra 7'],
    ),
    screen_size: title(
      [[/\b13\b/, '13.3"'], [/\b14\b/, '14"'], [/\b15\b/, '15.6"'], [/\b16\b/, '16"'], [/\b17\b/, '17.3"']],
      ['14"', '15.6"'],
    ),
  },
  'electronics-smartphones': SMARTPHONE,
  'mobiles-smartphones': SMARTPHONE,
  'electronics-tablets': TABLET,
  'mobiles-tablets': TABLET,
  'electronics-tvs': {
    resolution: title([[/8K/, '8K'], [/4K|Ultra|OLED|QLED|Cinema|Theatre/i, '4K Ultra HD'], [/1080p|Full HD|FHD/i, 'Full HD']], ['Full HD']),
    tv_type: title([[/QLED/, 'QLED TV'], [/OLED/, 'OLED TV'], [/projector/i, 'Projector'], [/stream|stick|box\b/i, 'Streaming device'], [/TV/, 'LED TV']]),
  },
  'electronics-headphones': {
    headphone_type: title([
      [/buds|tws|true wireless/i, 'True wireless'], [/neckband/i, 'Neckband'], [/in-?ear|earphone/i, 'In-ear'],
      [/on-?ear/i, 'On-ear'], [/over-?ear|headphone|headset|halo|studio/i, 'Over-ear'],
    ]),
    connection: CONNECTION,
    noise_cancellation: { match: [[/ANC|noise[- ]cancel/i, 'Active (ANC)']], from: ['title', 'power'], pool: ['Passive', 'None'] },
  },
  'electronics-smartwatches': { compatible_with: { pool: ['Android & iPhone', 'Android & iPhone', 'Android'] } },
  'electronics-cameras': {
    camera_type: title(
      [[/mirrorless/i, 'Mirrorless'], [/dslr/i, 'DSLR'], [/action|go\b/i, 'Action camera'], [/instant/i, 'Instant'], [/compact|point/i, 'Compact']],
      ['Mirrorless', 'DSLR', 'Compact'],
    ),
  },
  'electronics-speakers': {
    speaker_type: title([[/soundbar/i, 'Soundbar'], [/party/i, 'Party speaker'], [/smart|home/i, 'Smart speaker'], [/theatre|theater/i, 'Home theatre']], ['Portable']),
    connection: CONNECTION,
  },
  'electronics-accessories': {
    accessory_type: title([
      [/keyboard.*mouse|mouse.*keyboard|combo/i, 'Keyboard & mouse'], [/keyboard/i, 'Keyboard'], [/mouse ?pad|desk ?mat/i, 'Mouse pad'],
      [/mouse/i, 'Mouse'], [/webcam/i, 'Webcam'], [/hub|dock/i, 'USB hub'], [/monitor/i, 'Monitor'], [/stand/i, 'Laptop stand'],
      [/ssd|hard drive|pen ?drive|storage/i, 'Portable storage'], [/power ?bank/i, 'Power bank'], [/headset/i, 'Headset'],
    ]),
    connection: CONNECTION,
  },
  'electronics-gaming': {
    gaming_type: title([[/controller|gamepad|pad\b/i, 'Controller'], [/console/i, 'Console'], [/headset/i, 'Headset'], [/handheld/i, 'Handheld']], ['Accessory']),
    platform: title([[/\bPC\b|windows/i, 'PC'], [/playstation|ps5/i, 'PlayStation 5'], [/xbox/i, 'Xbox Series X|S'], [/switch/i, 'Nintendo Switch']]),
  },
  'electronics-appliances': {
    appliance_type: APPLIANCE_TYPE,
    capacity: title([[/(\d+(?:\.\d)?)\s?L\b/, (m) => `${m[1]} L`], [/refrigerator|fridge/i, '253 L'], [/washing/i, '7 kg'], [/microwave|oven/i, '25 L'], [/air ?conditioner|\bAC\b/i, '1.5 ton']]),
    energy_rating: { match: [[/refrigerator|fridge|washing|air ?conditioner|\bAC\b/i, '']], pool: ['3 Star', '4 Star', '5 Star'] },
  },
  'electronics-drones': {
    flight_time: {
      match: [[/(\d+)\s*min/i, (m) => (Number(m[1]) < 20 ? 'Under 20 min' : Number(m[1]) < 30 ? '20–30 min' : '30 min and above')]],
      from: ['power'],
    },
  },
  'mobiles-accessories': {
    accessory_type: title([
      [/case|cover/i, 'Case & cover'], [/charger|adapter/i, 'Charger'], [/cable/i, 'Cable'], [/power ?bank/i, 'Power bank'],
      [/screen|tempered|guard/i, 'Screen guard'], [/earphone|buds|headset/i, 'Earphones'], [/holder|stand|mount/i, 'Holder & stand'],
    ]),
  },
  'fashion-men': { garment_type: GARMENT_TYPE },
  'fashion-women': { garment_type: GARMENT_TYPE },
  'fashion-kids': { garment_type: GARMENT_TYPE, for_gender: title([[/girl/i, 'Girls'], [/boy/i, 'Boys']], ['Unisex']) },
  'fashion-ethnic': { garment_type: GARMENT_TYPE },
  'fashion-innerwear': { garment_type: GARMENT_TYPE },
  'fashion-winter': { garment_type: GARMENT_TYPE },
  'sports-sportswear': { garment_type: GARMENT_TYPE },
  'fashion-footwear': {
    footwear_type: title([
      [/sneaker/i, 'Sneakers'], [/running|trail|runner/i, 'Running shoes'], [/sports|training/i, 'Sports shoes'], [/boot|chukka/i, 'Boots'],
      [/loafer/i, 'Loafers'], [/derby|oxford|formal|brogue/i, 'Formal shoes'], [/slip-?on/i, 'Slip-ons'], [/sandal/i, 'Sandals'],
      [/flip|slides|chappal/i, 'Flip-flops'], [/heel|pump/i, 'Heels'],
    ]),
  },
  'fashion-bags': {
    bag_type: title([
      [/backpack|rucksack/i, 'Backpack'], [/laptop/i, 'Laptop bag'], [/tote/i, 'Tote'], [/sling|crossbody/i, 'Sling bag'],
      [/wallet|card holder|purse/i, 'Wallet'], [/duffel|gym bag|travel bag/i, 'Duffel'], [/clutch/i, 'Clutch'], [/handbag|satchel|shoulder/i, 'Handbag'],
    ]),
  },
  'fashion-watches': { watch_type: title([[/chrono/i, 'Chronograph'], [/digital/i, 'Digital'], [/smart/i, 'Smartwatch']], ['Analog']) },
  'fashion-sunglasses': {
    frame_shape: title(
      [[/aviator/i, 'Aviator'], [/wayfarer/i, 'Wayfarer'], [/round/i, 'Round'], [/rectang|square/i, 'Rectangle'], [/cat-?eye/i, 'Cat-eye'], [/sport|wrap/i, 'Sport'], [/oversized/i, 'Oversized']],
      ['Wayfarer', 'Aviator', 'Rectangle'],
    ),
  },
  'fashion-jewellery': {
    jewellery_type: title([
      [/earring|jhumk|stud/i, 'Earrings'], [/necklace|choker/i, 'Necklace'], [/pendant/i, 'Pendant'], [/bangle|kada/i, 'Bangles'],
      [/bracelet/i, 'Bracelet'], [/\bring\b/i, 'Ring'], [/set/i, 'Jewellery set'], [/anklet|payal/i, 'Anklet'],
    ]),
  },
  'fashion-caps': {
    cap_type: title([[/snapback/i, 'Snapback'], [/trucker/i, 'Trucker cap'], [/bucket/i, 'Bucket hat'], [/beanie/i, 'Beanie'], [/sun hat|fedora/i, 'Sun hat']], ['Baseball cap']),
  },
  'fashion-accessories': {
    accessory_type: title([
      [/belt/i, 'Belt'], [/\btie\b/i, 'Tie'], [/scarf|stole|muffler/i, 'Scarf'], [/socks/i, 'Socks'], [/gloves/i, 'Gloves'],
      [/cufflink/i, 'Cufflinks'], [/hair|scrunchie|clip/i, 'Hair accessory'], [/keychain|key ring/i, 'Keychain'],
    ]),
  },
  'home-appliances': {
    appliance_type: APPLIANCE_TYPE,
    capacity: title([[/(\d+(?:\.\d)?)\s?L\b/, (m) => `${m[1]} L`], [/blender|mix/i, '1.5 L'], [/coffee|brew/i, '1.2 L'], [/kettle/i, '1.5 L']]),
  },
  'home-cookware': {
    cookware_type: title([
      [/kadai|kadhai|wok/i, 'Kadai'], [/tawa/i, 'Tawa'], [/skillet/i, 'Skillet'], [/pressure cooker/i, 'Pressure cooker'],
      [/saucepan/i, 'Saucepan'], [/casserole/i, 'Casserole'], [/set|piece/i, 'Cookware set'], [/pan/i, 'Frying pan'],
    ]),
    induction: title([[/cast iron|tri-?ply|induction|steel/i, 'Induction & gas']], ['Induction & gas', 'Gas only']),
    capacity: title([[/(\d+(?:\.\d)?)\s?L\b/, (m) => `${m[1]} L`], [/kadai|kadhai|wok/i, '2.5 L'], [/pressure cooker/i, '5 L']]),
  },
  'home-furniture': {
    furniture_type: title([
      [/study|desk/i, 'Study table'], [/chair/i, 'Chair'], [/table/i, 'Table'], [/book ?shelf|shelf|rack/i, 'Bookshelf'],
      [/sofa|couch/i, 'Sofa'], [/\bbed\b/i, 'Bed'], [/cabinet|storage|drawer/i, 'Storage cabinet'], [/shoe/i, 'Shoe rack'],
    ]),
  },
  'home-decor': {
    decor_type: title([
      [/wall art|painting|canvas|print/i, 'Wall art'], [/vase/i, 'Vase'], [/lamp|light/i, 'Table lamp'], [/candle/i, 'Candle'],
      [/clock/i, 'Wall clock'], [/frame/i, 'Photo frame'], [/planter|pot\b/i, 'Planter'], [/showpiece|figurine|idol|statue/i, 'Showpiece'],
    ]),
  },
  'beauty-skincare': {
    skin_concern: title(
      [[/spf|sunscreen|sun/i, 'Sun protection'], [/vitamin c|bright|glow/i, 'Dullness'], [/acne|salicylic|clear/i, 'Acne'], [/moistur|hydrat|hyaluronic/i, 'Dryness'], [/retinol|ageing|aging|night/i, 'Ageing'], [/oil[- ]free|matt/i, 'Oil control']],
      ['Dryness', 'Dullness'],
    ),
  },
  'beauty-makeup': { finish: title([[/matte/i, 'Matte'], [/satin/i, 'Satin'], [/dewy|glow/i, 'Dewy'], [/gloss/i, 'Glossy']], ['Matte', 'Natural', 'Satin']) },
  'beauty-haircare': {
    hair_type: title(
      [[/frizz|smooth/i, 'Frizzy'], [/curl/i, 'Curly'], [/damage|repair|bond/i, 'Damaged'], [/colou?r/i, 'Colour-treated'], [/dandruff|oil/i, 'Oily'], [/dry|hydrat/i, 'Dry']],
      ['All hair types'],
    ),
  },
  'beauty-fragrances': {
    fragrance_family: title([[/oud|wood|sandal|cedar/i, 'Woody'], [/rose|floral|jasmine|bloom/i, 'Floral'], [/citrus|lemon|bergamot/i, 'Citrus'], [/aqua|ocean|marine/i, 'Aquatic']], ['Fresh', 'Woody', 'Floral']),
    for_gender: title([[/women|her\b|femme/i, 'Women'], [/\bmen\b|him\b|homme/i, 'Men']], ['Unisex']),
  },
  'books-fiction': {
    genre: title(
      [[/thriller|murder|dark|kill/i, 'Thriller'], [/mystery|secret|case/i, 'Mystery'], [/love|heart|romance/i, 'Romance'], [/dragon|magic|kingdom|realm/i, 'Fantasy'], [/star|galaxy|robot|future/i, 'Science fiction'], [/empire|war|raj|dynasty/i, 'Historical'], [/stories|tales/i, 'Short stories']],
      ['Literary'],
    ),
  },
  'books-non-fiction': {
    subject: title(
      [[/life|journey|memoir|biography/i, 'Biography'], [/money|business|startup|leader|invest/i, 'Business'], [/habit|mind|success|happiness/i, 'Self-help'], [/history|past|ancient/i, 'History'], [/science|universe|brain/i, 'Science'], [/travel|road|journey/i, 'Travel'], [/health|food|yoga|fitness/i, 'Health']],
      ['Self-help', 'Business', 'History'],
    ),
  },
  'books-academic': {
    subject: title(
      [[/engineering|mechanics|circuit/i, 'Engineering'], [/neet|anatomy|medical|biology/i, 'Medical'], [/jee|upsc|ssc|exam|aptitude/i, 'Competitive exams'], [/account|commerce|economics/i, 'Commerce'], [/class|ncert|school/i, 'School'], [/law|legal/i, 'Law'], [/programming|computer|algorithm|python|java/i, 'Computer science']],
      ['Competitive exams', 'Engineering'],
    ),
  },
  'books-children': { age_group: { match: [[/board book/i, '1–3 years']], from: ['format', 'title'], pool: ['3+ years', '5+ years', '8+ years'] } },
  'supplements-protein': {
    protein_type: title([[/isolate/i, 'Whey isolate'], [/plant|pea|vegan/i, 'Plant protein'], [/casein/i, 'Casein'], [/gainer/i, 'Mass gainer'], [/whey/i, 'Whey concentrate']]),
    veg: title([[/omega|fish|collagen|gelatin|softgel/i, 'Non-veg']], ['Veg']),
  },
  'supplements-vitamins': {
    supplement_form: {
      match: [[/softgel/i, 'Softgels'], [/gumm/i, 'Gummies'], [/capsule/i, 'Capsules'], [/effervescent/i, 'Effervescent'], [/powder/i, 'Powder'], [/tablet|tabs|multivitamin/i, 'Tablets']],
      from: ['title', 'net_quantity'],
    },
    veg: title([[/omega|fish|collagen|gelatin|softgel/i, 'Non-veg']], ['Veg']),
  },
  'supplements-fitness': {
    supplement_type: title([[/creatine/i, 'Creatine'], [/pre-?workout/i, 'Pre-workout'], [/bcaa/i, 'BCAA'], [/eaa/i, 'EAA'], [/electrolyte|hydration/i, 'Electrolytes'], [/burner|l-carnitine/i, 'Fat burner']]),
    veg: title([[/omega|fish|collagen|gelatin|softgel/i, 'Non-veg']], ['Veg']),
  },
  'sports-fitness': {
    equipment_type: title([
      [/dumbbell/i, 'Dumbbells'], [/kettlebell/i, 'Kettlebell'], [/yoga|mat\b/i, 'Yoga mat'], [/band/i, 'Resistance bands'],
      [/skipping|rope/i, 'Skipping rope'], [/bench/i, 'Bench'], [/ab roller|ab wheel/i, 'Ab roller'], [/treadmill/i, 'Treadmill'],
    ]),
  },
  'sports-outdoor': {
    sport: title([
      [/cricket|\bbat\b/i, 'Cricket'], [/football|soccer/i, 'Football'], [/badminton|shuttle|racquet|racket/i, 'Badminton'], [/tennis/i, 'Tennis'],
      [/basketball/i, 'Basketball'], [/cycl|bike|bicycle/i, 'Cycling'], [/camp|tent|trek/i, 'Camping'], [/swim|goggles/i, 'Swimming'],
    ]),
  },
  'gaming-consoles': { platform: title([[/playstation|ps5/i, 'PlayStation 5'], [/xbox/i, 'Xbox Series X|S'], [/switch/i, 'Nintendo Switch']]) },
  'gaming-games': {
    age_rating: { match: [[/racing|sports/i, '3+'], [/shooter/i, '18+'], [/action|adventure/i, '16+'], [/role|strategy/i, '12+']], from: ['genre'], pool: ['12+'] },
  },
  'gaming-accessories': {
    accessory_type: title([[/controller|gamepad|pad\b/i, 'Controller'], [/headset/i, 'Headset'], [/charg|dock/i, 'Charging station'], [/wheel/i, 'Racing wheel'], [/mouse/i, 'Gaming mouse'], [/keyboard/i, 'Gaming keyboard']]),
    platform: title([[/\bPC\b/i, 'PC'], [/playstation|ps5/i, 'PlayStation 5'], [/xbox/i, 'Xbox Series X|S'], [/switch/i, 'Nintendo Switch']]),
  },
  'grocery-staples': {
    staple_type: title([
      [/atta|flour|maida|besan/i, 'Atta & flour'], [/rice|basmati/i, 'Rice'], [/dal|pulse|chana|moong|rajma/i, 'Dal & pulses'],
      [/ghee/i, 'Ghee'], [/oil/i, 'Cooking oil'], [/sugar|salt|jaggery/i, 'Sugar & salt'], [/masala|spice|turmeric|chilli|haldi/i, 'Spices'],
    ]),
  },
  'grocery-snacks': {
    snack_type: title([
      [/chips|crisps/i, 'Chips & crisps'], [/biscuit|cookie/i, 'Biscuits & cookies'], [/namkeen|bhujia|mixture/i, 'Namkeen'],
      [/chocolate|cocoa/i, 'Chocolates'], [/almond|cashew|dry fruit|nuts|raisin/i, 'Dry fruits'], [/\btea\b|chai/i, 'Tea'],
      [/coffee/i, 'Coffee'], [/juice|drink|soda|beverage/i, 'Juices & drinks'],
    ]),
  },
  'grocery-packaged': {
    food_type: title([
      [/ready to eat|curry|biryani/i, 'Ready to eat'], [/noodle|pasta/i, 'Noodles & pasta'], [/cereal|oats|muesli|cornflakes/i, 'Breakfast cereal'],
      [/jam|spread|peanut butter|honey/i, 'Spreads & jams'], [/ketchup|sauce/i, 'Sauces & ketchup'], [/pickle|achaar/i, 'Pickles'], [/mix\b/i, 'Instant mixes'],
    ]),
  },
  'toys-toys': {
    toy_type: title([
      [/block|brick|lego/i, 'Building blocks'], [/plush|soft|teddy/i, 'Soft toys'], [/puzzle|jigsaw/i, 'Puzzles'], [/board game|ludo|chess/i, 'Board games'],
      [/\brc\b|remote/i, 'Remote control'], [/stem|learning|educational|science kit/i, 'Educational'], [/doll/i, 'Dolls'], [/figure/i, 'Action figures'],
    ]),
  },
  'toys-baby-care': {
    baby_care_type: title([
      [/diaper/i, 'Diapers'], [/wipes/i, 'Wipes'], [/lotion|soap|shampoo|bath|oil/i, 'Bath & skin'], [/bottle|feeding|sipper/i, 'Feeding'],
      [/blanket|bedding|swaddle/i, 'Bedding'], [/rattle|teether/i, 'Baby toys'],
    ]),
  },
  'toys-school': {
    school_type: title([
      [/school bag|backpack|\bbag\b/i, 'School bags'], [/pencil box|geometry/i, 'Pencil boxes'], [/lunch/i, 'Lunch boxes'],
      [/bottle/i, 'Water bottles'], [/colou?r|crayon|paint|art/i, 'Art supplies'], [/pen\b|pencil|notebook|stationery/i, 'Stationery'],
    ]),
  },
};

/** The value one rule gives a product, or null. */
export function ruleValue(rule: Rule, product: { slug: string; title: string; attributes: ProductAttribute[] }, key: string): string | null {
  for (const source of rule.from ?? ['title']) {
    const text = source === 'title' ? product.title : product.attributes.find((a) => a.key === source)?.value;
    if (!text) continue;
    for (const [pattern, value] of rule.match ?? []) {
      const m = text.match(pattern);
      if (!m) continue;
      const out = typeof value === 'function' ? value(m) : value;
      // An empty value means "this rule applies, draw from the pool".
      if (out) return out;
      return rule.pool ? pickFrom(rule.pool, product.slug, key) : null;
    }
  }
  // energy_rating-style rules: a pool that only applies when a pattern matched.
  if (rule.match?.some(([, v]) => v === '')) return null;
  return rule.pool ? pickFrom(rule.pool, product.slug, key) : null;
}

function pickFrom(pool: readonly string[], slug: string, key: string): string {
  const rng = makeRng(hashSeed(`${slug}#${key}`));
  return pool[Math.floor(rng() * pool.length)];
}

export interface FacetCoverageRow {
  slug: string;
  path: string;
  products: number;
  facets: { key: string; label: string; withValue: number }[];
}

/** For each category with live products: how many carry a value for each of its facets. */
export async function facetCoverage(prisma: PrismaClient): Promise<FacetCoverageRow[]> {
  invalidateCategoryRules();
  const rows = await categoryRows();
  const products = await prisma.product.findMany({
    where: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false } },
    select: { categoryId: true, attributes: true, variants: { select: { optionValues: true } } },
  });
  const byCategory = new Map<string, typeof products>();
  for (const p of products) byCategory.set(p.categoryId, [...(byCategory.get(p.categoryId) ?? []), p]);
  const out: FacetCoverageRow[] = [];
  for (const [categoryId, list] of byCategory) {
    const chain = chainOf(rows, categoryId);
    const facets = facetsFromChain(chain);
    out.push({
      slug: rows.get(categoryId)?.slug ?? categoryId,
      path: [...chain].reverse().map((c) => c.name).join(' › '),
      products: list.length,
      facets: facets.map((facet) => ({
        key: facet.key,
        label: facet.label,
        withValue: list.filter((p) =>
          hasFacetValue(readFacet(normaliseAttributes(p.attributes), p.variants.map((v) => optionValuesFromJson(v.optionValues)), facet)),
        ).length,
      })),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DemoFacetReport {
  /** Demo products given at least one value. */
  products: number;
  /** Values written in total, by facet key. */
  values: Record<string, number>;
}

export async function seedDemoFacetValues(prisma: PrismaClient, apply: boolean): Promise<DemoFacetReport> {
  invalidateCategoryRules();
  const rows = await categoryRows();
  const products = await prisma.product.findMany({
    where: { description: { contains: DEMO_PRODUCT_MARKER } },
    select: { id: true, slug: true, title: true, categoryId: true, attributes: true, variants: { select: { optionValues: true } } },
  });
  const report: DemoFacetReport = { products: 0, values: {} };
  for (const p of products) {
    const category = rows.get(p.categoryId);
    if (!category) continue;
    const rules = DEMO_FACET_RULES[category.slug];
    if (!rules) continue;
    const attributes = normaliseAttributes(p.attributes);
    const options = p.variants.map((v) => optionValuesFromJson(v.optionValues));
    const added: ProductAttribute[] = [];
    for (const facet of facetsFromChain(chainOf(rows, p.categoryId))) {
      const rule = rules[facet.key];
      if (!rule || hasFacetValue(readFacet(attributes, options, facet))) continue;
      const value = ruleValue(rule, { slug: p.slug, title: p.title, attributes }, facet.key);
      if (!value) continue;
      added.push({ key: facet.key, label: facet.label, value });
      report.values[facet.key] = (report.values[facet.key] ?? 0) + 1;
    }
    if (added.length === 0) continue;
    report.products += 1;
    if (apply) {
      await prisma.product.update({
        where: { id: p.id },
        data: { attributes: [...attributes, ...added] as unknown as Prisma.InputJsonValue },
      });
    }
  }
  return report;
}
