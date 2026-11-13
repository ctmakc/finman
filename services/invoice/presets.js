// services/invoice/presets.js — starter templates.
//
// BLANK_* — what any new Finman user starts from (no company data).
// The INNOVA / OH! Catering presets carry real requisites copied verbatim from the owner's
// document templates (docs-templates/innova/invoice-template*.html, OH! Catering invoice No. 4).
// They are NOT offered to other users: scripts/invoice-presets-seed.js puts them into the
// owner's account or into a share link. Logos/signatures are attached by that script from
// files on disk, never committed here.

const CLASSIC_DEFAULTS = {
  title: 'INVOICE',
  heading: '{title} No. {number} dated {date_long}',
  due_line: 'Due date: {due_long} ({due_days} days)',
  seller: { label: 'Supplier:', name: '', lines: [] },
  client_label: 'Bill to:',
  bank: null,
  bank_before_client: false,
  item_header: 'Services',
  qty_header: 'Qty',
  price_header: 'Price, {currency}',
  amount_header: 'Amount, {currency}',
  qty_width: 50,
  money_style: 'code',
  tax: { label: 'Tax:', sub: '', rate: null, text: 'not applicable' },
  words: { enabled: true, prefix: 'Total items {count}, amount due:', unit: null, note: '' },
  payment_reference: 'Invoice {number}',
  pay_online: null,
  terms: '',
  signer: null,
  signature_width: 200,
  signature_drop: 14,
};

const LIGHT_DEFAULTS = {
  title: 'INVOICE',
  heading: '{title} N°: {number}',
  date_line: 'Date: {date_dmy_long}',
  due_line: '',
  seller: { name: '', lines: [] },
  client_label: "Client's Information:",
  bank: null,
  item_header: 'Description / Product',
  qty_header: 'Qty',
  price_header: 'Price',
  amount_header: 'Total',
  money_style: 'symbol',
  symbol: '$',
  tax: { label: 'TAX', sub: '', rate: null, text: '' },
  words: { enabled: false },
  payment_reference: '',
  pay_online: null,
  terms: '',
  signer: null,
};

const BLANK_CLASSIC = {
  key: 'classic',
  name: 'Classic — bank transfer',
  layout: 'classic',
  currency: 'USD',
  number_format: '{DD}-{MM}-{YY}-{N}',
  due_days: 14,
  data: {
    ...CLASSIC_DEFAULTS,
    seller: { label: 'Supplier:', name: 'Your Company Ltd.', lines: ['Address, City, Country', 'you@example.com'] },
    bank: {
      title: 'Bank transfer',
      key: [
        { k: 'Beneficiary name', v: 'Your Company Ltd.' },
        { k: 'Account No. / IBAN', v: '' },
        { k: 'SWIFT / BIC', v: '' },
      ],
      rest: [{ k: 'Bank:', v: '' }],
      note: '',
    },
    tax: { label: 'Tax:', sub: '', rate: null, text: 'not applicable' },
    payment_reference: 'Invoice {number}',
    terms: 'Please pay within {due_days} days of receiving this invoice.',
    signer: null,
  },
};

const BLANK_LIGHT = {
  key: 'light',
  name: 'Light — services & catering',
  layout: 'light',
  currency: 'CAD',
  number_format: '{SEQ}',
  due_days: 7,
  data: {
    ...LIGHT_DEFAULTS,
    seller: { name: 'Your Business', lines: ['Address, City', 'hello@example.com', 'Phone'] },
    item_header: 'Description / Product',
    qty_header: 'Qty',
    price_header: 'Price',
    amount_header: 'Total',
    tax: { label: 'TAX', sub: '', rate: 13, text: '' },
  },
};

// ---- INNOVA CONSULT LTD. (Canada), invoice-template-ca-eur.html ----
const INNOVA_ADDR = '2164 Montreal Road, Unit 5, Ottawa, ON K1J 1G4, Canada';
const RBC = 'Royal Bank of Canada, 180 Wellington St W, Toronto, ON M5J 1J1, Canada';

const INNOVA_CA_EUR = {
  key: 'innova-ca-eur',
  name: 'INNOVA Canada — EUR (SWIFT)',
  layout: 'classic',
  currency: 'EUR',
  number_format: '{DD}-{MM}-{YY}-{N}',
  due_days: 3,
  data: {
    ...CLASSIC_DEFAULTS,
    due_line: 'Due date: {due_long} ({due_days} days)  ·  Currency: {currency}',
    seller: {
      label: 'Supplier:',
      name: 'INNOVA CONSULT LTD.',
      lines: [
        'Federal Corp. No. 1522612-1 (Canada, CBCA)  ·  BN 799524756',
        'GST/HST No. 799524756 RT0001',
        INNOVA_ADDR,
        'Director: Maksym Stepanenko  ·  m@innovacg.com',
      ],
    },
    client_label: 'Bill to:',
    bank_before_client: false,
    bank: {
      title: 'Bank transfer — SWIFT, in EUR',
      key: [
        { k: 'Beneficiary name', v: 'INNOVA CONSULT LTD.' },
        { k: 'Account No. (IBAN field)', v: '0300 4101 4232' },
        { k: 'SWIFT / BIC', v: 'ROYC CAT2 XXX' },
      ],
      rest: [
        { k: 'Beneficiary address:', v: INNOVA_ADDR },
        { k: 'Bank:', v: RBC },
        { k: 'Account, no spaces:', v: '**030041014232** (transit 03004 + account 1014232)' },
        { k: 'Institution / Transit:', v: '003 / 03004 · Canadian sort code //CC000303004 · branch Kanata, ON' },
        { k: 'Bank charges:', v: 'OUR (all charges paid by the sender)' },
      ],
      note: 'Canada does not use IBAN: enter the account number in the IBAN/account field. Send in EUR; Royal Bank of Canada credits the CAD equivalent at its rate on the date of receipt.',
    },
    qty_width: 50,
    tax: {
      label: 'Canadian GST/HST 0% — zero-rated supply of services to a non-resident',
      sub: '(Excise Tax Act, Schedule VI, Part V, section 23)',
      rate: 0,
      text: '',
    },
    words: { enabled: true, prefix: 'Total items {count}, amount due:', unit: null, note: '' },
    payment_reference: 'Invoice {number}',
    pay_online: {
      url: 'https://innovacg.com/en/invoice?ref={ref}&amount={amount}&currency={currency}',
      label: 'by card (Stripe) or in USDT (Solana):',
      currencies: ['EUR', 'USD', 'CAD'],
    },
    terms: 'Please pay within 3 days of receiving this invoice. Bank charges: OUR — the invoice is settled when the full amount arrives with all bank charges paid by the Customer. Payment confirms acceptance of the services for the period stated above.',
    signer: { title: 'Supplier:', lines: ['INNOVA CONSULT LTD.', 'Maksym Stepanenko, Director'] },
    signature_width: 200,
    signature_drop: 14,
  },
};

// ---- invoice-template.html (CAD, clients in Canada) ----
const INNOVA_CAD = {
  key: 'innova-cad',
  name: 'INNOVA Canada — CAD (HST 13%)',
  layout: 'classic',
  currency: 'CAD',
  number_format: '{DD}-{MM}-{YY}-{N}',
  due_days: 30,
  data: {
    ...CLASSIC_DEFAULTS,
    due_line: 'Due date: {due_long} ({due_days} days)',
    seller: {
      label: 'Supplier:',
      name: 'INNOVA CONSULT LTD',
      lines: [
        'Federal Corp. No. 1522612-1 (Canada, CBCA)  ·  BN 799524756',
        INNOVA_ADDR,
        'Director: Maksym Stepanenko  ·  m@innovacg.com',
      ],
    },
    client_label: 'Bill to:',
    bank_before_client: true,
    bank: {
      title: 'Bank transfer — CAD',
      key: [
        { k: 'Beneficiary name', v: 'INNOVA CONSULT LTD.' },
        { k: 'Account No.', v: '0300 4101 4232' },
        { k: 'SWIFT / BIC', v: 'ROYC CAT2 XXX' },
      ],
      rest: [
        { k: 'Beneficiary address:', v: INNOVA_ADDR },
        { k: 'Bank:', v: RBC },
        { k: 'Within Canada:', v: 'institution **003** · transit **03004** · account **1014232** · RBC Kanata' },
        { k: 'International, no spaces:', v: '**030041014232** (transit + account) · SWIFT ROYCCAT2XXX (ROYCCAT2)' },
      ],
      note: '',
    },
    qty_width: 60,
    tax: { label: 'HST (13%, Ontario):', sub: '', rate: 13, text: '' },
    words: { enabled: true, prefix: 'Total items {count}, amount due:', unit: null, note: 'GST/HST No. 799524756 RT0001.' },
    payment_reference: 'Payment for services under Invoice No. {number} dated {date_dmy}.',
    pay_online: {
      url: 'https://innovacg.com/en/invoice?ref={ref}&amount={amount}&currency={currency}',
      label: 'by card (Stripe) or in USDT (Solana):',
      currencies: ['EUR', 'USD', 'CAD'],
    },
    terms: "Please send payment within 30 days of receiving this invoice. There will be a 1.5% interest charge per month on late invoices. All charges of correspondent banks are at the Customer's expense. Payment of this invoice constitutes confirmation of the services rendered and of final mutual settlement between the Parties, without any additional documents; the Parties acknowledge they have no claims against each other.",
    signer: { title: 'Supplier:', lines: ['INNOVA CONSULT LTD', 'Maksym Stepanenko, Director'] },
    signature_width: 200,
    signature_drop: 14,
  },
};

// ---- invoice-template-eur.html (UK company, Wise EUR). The UK company was dissolved on
// 26.05.2026: new invoices only on the owner's decision; no online payment box (the pay page
// credits the Canadian company). ----
const INNOVA_UK_EUR = {
  key: 'innova-uk-eur',
  name: 'INNOVA UK — EUR Wise (dissolved, owner decision only)',
  layout: 'classic',
  currency: 'EUR',
  number_format: '{DD}-{MM}-{YY}-{N}',
  due_days: 3,
  data: {
    ...CLASSIC_DEFAULTS,
    due_line: 'Pay within {due_days} days from receipt',
    seller: {
      label: 'Supplier:',
      name: 'INNOVA CONSULT LTD',
      lines: [
        'Company No. 14561148 (England and Wales)',
        '5 Brayford Square, London, E1 0SG, United Kingdom',
        'Director: Maksym Stepanenko  ·  m@innovacg.com',
      ],
    },
    client_label: 'Customer:',
    bank_before_client: true,
    bank: {
      title: 'Bank transfer — EUR (SEPA / SWIFT)',
      key: [
        { k: 'Beneficiary name', v: 'Innova Consult Ltd' },
        { k: 'IBAN', v: 'BE74 9675 7576 7007' },
        { k: 'SWIFT / BIC', v: 'TRWI BEB1 XXX' },
      ],
      rest: [
        { k: 'Bank:', v: 'Wise, Rue du Trône 100, 3rd floor, Brussels, 1050, Belgium' },
        { k: 'Account number:', v: '5757670' },
        { k: 'No spaces:', v: 'IBAN **BE74967575767007** · BIC **TRWIBEB1XXX**' },
      ],
      note: '',
    },
    qty_width: 60,
    tax: { label: 'VAT:', sub: '', rate: null, text: 'not applicable' },
    words: { enabled: true, prefix: 'Total items {count}, amount due:', unit: { one: 'euro', many: 'euro', minor: 'euro cents' }, note: '' },
    payment_reference: 'Payment for services under Invoice No. {number} dated {date_dmy}.',
    pay_online: null,
    terms: "The bank commission is paid by the Customer; all charges of correspondent banks are at the Customer's expense. Payment of this invoice constitutes confirmation of the performed works and delivered services and of final mutual settlement between the Parties, without any additional documents; the Parties acknowledge they have no claims against each other.",
    signer: { title: 'Supplier:', lines: ['INNOVA CONSULT LTD', 'Maksym Stepanenko, Director'] },
    signature_width: 230,
    signature_drop: 40,
  },
};

// ---- OH! Catering (Anastasiia Stepanenko), as on her invoice No. 4 of 12.11.2026.
// No business/HST number and no e-Transfer address: they are not on her invoices yet
// (open questions to the owner). Tax line follows invoice No. 4 (TAX 13%). ----
const OH_CATERING = {
  key: 'oh-catering',
  name: 'OH! Catering',
  layout: 'light',
  currency: 'CAD',
  number_format: '{SEQ}',
  next_seq: 5,
  due_days: 7,
  data: {
    ...LIGHT_DEFAULTS,
    seller: { name: 'OH! Catering', lines: ['19 Vermeer, Ottawa', 'hello@ohcatering.ca', '613-710-0554'] },
    client_label: "Client's Information:",
    item_header: 'Description / Product',
    qty_header: 'Guests',
    price_header: 'Per 1',
    amount_header: 'Total',
    money_style: 'symbol',
    symbol: '$',
    tax: { label: 'TAX', sub: '', rate: 13, text: '' },
    payment_reference: '',
    pay_online: {
      url: 'https://ohcatering.ca/pay?ref={ref}&amount={amount}',
      label: 'Pay online by card:',
      currencies: ['CAD'],
    },
    terms: '',
  },
};

const BLANKS = [BLANK_CLASSIC, BLANK_LIGHT];
const OWNER_PRESETS = { 'innova-ca-eur': INNOVA_CA_EUR, 'innova-cad': INNOVA_CAD, 'innova-uk-eur': INNOVA_UK_EUR, 'oh-catering': OH_CATERING };

function defaultsFor(layout) { return layout === 'light' ? LIGHT_DEFAULTS : CLASSIC_DEFAULTS; }

module.exports = { BLANKS, OWNER_PRESETS, CLASSIC_DEFAULTS, LIGHT_DEFAULTS, defaultsFor };
