// services/importCategorizer.js — category guesses for imported bank rows.
//
// Two sources of truth, in order of preference:
//   1. MCC (merchant category code) when the statement carries one (Monobank).
//   2. Keywords in the description (English + Ukrainian + Russian merchants and
//      words common on Canadian / Ukrainian statements).
// Returns English category names; the rules engine (/api/rules) can override
// them after import.

const CATEGORY = {
  groceries: 'Groceries',
  dining: 'Food & Dining',
  transport: 'Transport',
  fuel: 'Fuel',
  health: 'Health',
  shopping: 'Shopping',
  entertainment: 'Entertainment',
  utilities: 'Utilities',
  telecom: 'Phone & Internet',
  housing: 'Housing',
  fees: 'Bank Fees',
  subscriptions: 'Subscriptions',
  salary: 'Salary',
  investments: 'Investments',
  refund: 'Refund',
  transfer: 'Transfer',
  cash: 'Cash',
  travel: 'Travel',
  education: 'Education',
  taxes: 'Taxes & Government',
  other: 'Other'
};

// MCC ranges/codes -> category. Source: ISO 18245 merchant category codes.
const MCC_EXACT = {
  5411: 'groceries', 5422: 'groceries', 5441: 'groceries', 5451: 'groceries', 5462: 'groceries', 5499: 'groceries',
  5812: 'dining', 5813: 'dining', 5814: 'dining',
  4111: 'transport', 4112: 'transport', 4121: 'transport', 4131: 'transport', 4789: 'transport', 7523: 'transport',
  5541: 'fuel', 5542: 'fuel', 5983: 'fuel',
  5912: 'health', 8011: 'health', 8021: 'health', 8031: 'health', 8041: 'health', 8042: 'health', 8043: 'health',
  8049: 'health', 8050: 'health', 8062: 'health', 8071: 'health', 8099: 'health',
  5311: 'shopping', 5331: 'shopping', 5399: 'shopping', 5611: 'shopping', 5621: 'shopping', 5631: 'shopping',
  5641: 'shopping', 5651: 'shopping', 5661: 'shopping', 5681: 'shopping', 5691: 'shopping', 5699: 'shopping',
  5732: 'shopping', 5942: 'shopping', 5943: 'shopping', 5945: 'shopping', 5977: 'shopping', 5999: 'shopping',
  7832: 'entertainment', 7841: 'entertainment', 7911: 'entertainment', 7922: 'entertainment', 7929: 'entertainment',
  7932: 'entertainment', 7933: 'entertainment', 7941: 'entertainment', 7991: 'entertainment', 7996: 'entertainment',
  7997: 'entertainment', 7999: 'entertainment',
  4900: 'utilities',
  4812: 'telecom', 4814: 'telecom', 4816: 'telecom', 4899: 'telecom',
  6010: 'cash', 6011: 'cash',
  6012: 'transfer', 4829: 'transfer', 6536: 'transfer', 6537: 'transfer', 6538: 'transfer',
  3000: 'travel', 4511: 'travel', 4722: 'travel', 7011: 'travel', 7512: 'travel',
  8211: 'education', 8220: 'education', 8241: 'education', 8244: 'education', 8249: 'education', 8299: 'education',
  9311: 'taxes', 9222: 'taxes', 9399: 'taxes',
  6300: 'fees', 7399: 'other'
};

function categorizeByMcc(mcc) {
  const code = Number(mcc);
  if (!Number.isFinite(code)) return CATEGORY.other;
  if (MCC_EXACT[code]) return CATEGORY[MCC_EXACT[code]];
  if (code >= 3000 && code <= 3299) return CATEGORY.travel; // airlines
  if (code >= 3351 && code <= 3441) return CATEGORY.travel; // car rental
  if (code >= 3501 && code <= 3999) return CATEGORY.travel; // hotels
  if (code >= 5600 && code <= 5699) return CATEGORY.shopping;
  if (code >= 5900 && code <= 5999) return CATEGORY.shopping;
  if (code >= 7800 && code <= 7999) return CATEGORY.entertainment;
  if (code >= 8000 && code <= 8099) return CATEGORY.health;
  return CATEGORY.other;
}

// Ordered keyword rules; first hit wins. Keep income-ish words before generic ones.
const KEYWORD_RULES = [
  ['salary', ['payroll', 'salary', 'direct deposit', 'pay deposit', 'зарплат', 'заробітна', 'аванс', 'wages']],
  ['refund', ['refund', 'reversal', 'chargeback', 'повернення', 'возврат', 'cashback', 'кешбек', 'кэшбэк']],
  ['investments', ['dividend', 'interest paid', 'interest earned', 'wealthsimple invest', 'questrade', 'tfsa', 'rrsp', 'дивіденд', 'дивиденд', 'відсотки', 'проценты']],
  ['taxes', ['canada revenue', 'cra ', 'revenu quebec', 'service canada', 'gst/hst', 'податк', 'налог', 'дія', 'tax']],
  ['cash', ['atm', 'abm ', 'cash withdrawal', 'withdrawal', 'банкомат', 'зняття', 'снятие']],
  ['transfer', ['e-transfer', 'etransfer', 'e-tfr', 'interac', 'transfer', 'переказ', 'перевод', 'wire', 'payment to', 'на картку', 'на карту']],
  ['fees', ['service charge', 'monthly fee', 'plan fee', 'account fee', 'nsf', 'overdraft', 'bank fee', 'комісі', 'комисси', 'плата за обслуговування', 'плата за обслуживание']],
  ['subscriptions', ['netflix', 'spotify', 'youtube', 'apple.com/bill', 'icloud', 'google storage', 'google one', 'disney', 'crave', 'prime video', 'amazon prime', 'subscription', 'підписк', 'подписк', 'patreon', 'adobe', 'microsoft 365', 'chatgpt', 'openai']],
  ['groceries', ['loblaws', 'no frills', 'nofrills', 'metro', 'sobeys', 'food basics', 'freshco', 'walmart', 'costco', 'superstore', 'farm boy', 'grocery', 'supermarket', 'iga ', 'maxi', 'provigo', 'сільпо', 'сильпо', 'атб', 'novus', 'фора', 'ашан', 'auchan', 'варус', 'продукт', 'супермаркет']],
  ['dining', ['tim hortons', 'starbucks', 'mcdonald', 'restaurant', 'resto', 'cafe', 'café', 'coffee', 'pizza', 'burger', 'subway', 'wendy', 'a&w', 'harvey', 'uber eats', 'ubereats', 'skip the dishes', 'skipthedishes', 'doordash', 'glovo', 'bolt food', 'кафе', 'ресторан', 'кофе', 'кава', 'піца', 'пицца', 'їжа', 'еда']],
  ['fuel', ['petro-canada', 'petro canada', 'esso', 'shell', 'ultramar', 'husky', 'canadian tire gas', 'gas bar', 'fuel', 'окко', 'okko', 'wog', 'азс', 'укрнафта']],
  ['transport', ['uber', 'lyft', 'presto', 'oc transpo', 'ttc', 'stm ', 'go transit', 'via rail', 'parking', 'taxi', 'такси', 'таксі', 'bolt', 'uklon', 'метро', 'transit', 'bus ', 'автобус']],
  ['health', ['pharmacy', 'shoppers drug', 'rexall', 'jean coutu', 'dental', 'dentist', 'clinic', 'physio', 'optical', 'hospital', 'аптек', 'клінік', 'клиник', 'лікар', 'врач', 'стоматолог']],
  ['telecom', ['rogers', 'bell canada', 'bell mobility', 'telus', 'fido', 'koodo', 'freedom mobile', 'videotron', 'kyivstar', 'київстар', 'vodafone', 'lifecell', 'internet', 'mobile']],
  ['utilities', ['hydro', 'enbridge', 'ontario energy', 'utilities', 'water bill', 'electricity', 'електро', 'комунал', 'коммунал', 'газ', 'yasno', 'київенерго']],
  ['housing', ['rent', 'mortgage', 'landlord', 'condo fee', 'property tax', 'оренда', 'аренда', 'квартплат', 'іпотек', 'ипотек']],
  ['entertainment', ['cinema', 'cineplex', 'theatre', 'theater', 'concert', 'ticketmaster', 'steam', 'playstation', 'xbox', 'nintendo', 'кіно', 'кино', 'театр', 'концерт']],
  ['education', ['university', 'college', 'tuition', 'udemy', 'coursera', 'school', 'університет', 'школа', 'курс']],
  ['travel', ['air canada', 'westjet', 'porter', 'airbnb', 'booking.com', 'expedia', 'hotel', 'marriott', 'hilton', 'ryanair', 'wizz', 'мау', 'готель', 'отель']],
  ['shopping', ['amazon', 'amzn', 'canadian tire', 'ikea', 'best buy', 'home depot', 'rona', 'dollarama', 'winners', 'zara', 'h&m', 'uniqlo', 'shein', 'aliexpress', 'rozetka', 'розетка', 'comfy', 'епіцентр', 'эпицентр', 'одяг', 'одежда', 'clothing', 'shoes']]
];

function categorizeByDescription(description) {
  if (!description) return CATEGORY.other;
  const text = String(description).toLowerCase();
  for (const [key, words] of KEYWORD_RULES) {
    for (const w of words) {
      if (text.includes(w)) return CATEGORY[key];
    }
  }
  return CATEGORY.other;
}

module.exports = { CATEGORY, categorizeByMcc, categorizeByDescription };
