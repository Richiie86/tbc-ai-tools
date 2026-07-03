/**
 * Indicative headline tax rates for 31 European countries (EU-27 + UK,
 * Norway, Switzerland, Iceland). Used by the operator Tax Calculator.
 *
 * IMPORTANT: these are simplified, headline/standard rates for a quick
 * estimate — they are NOT tax advice. Real liabilities depend on holding
 * period, income brackets, allowances, residency and local rules. The
 * calculator surfaces this caveat in the UI.
 *
 *  - vat:    standard VAT rate (%)
 *  - capital: typical rate applied to capital gains on securities/crypto (%)
 *  - income:  headline top marginal personal income tax rate (%)
 */
export const EU_TAX_RATES = [
  { code: 'AT', name: 'Austria',        vat: 20,   capital: 27.5, income: 55 },
  { code: 'BE', name: 'Belgium',        vat: 21,   capital: 10,   income: 50 },
  { code: 'BG', name: 'Bulgaria',       vat: 20,   capital: 10,   income: 10 },
  { code: 'HR', name: 'Croatia',        vat: 25,   capital: 10,   income: 30 },
  { code: 'CY', name: 'Cyprus',         vat: 19,   capital: 0,    income: 35 },
  { code: 'CZ', name: 'Czechia',        vat: 21,   capital: 15,   income: 23 },
  { code: 'DK', name: 'Denmark',        vat: 25,   capital: 42,   income: 55 },
  { code: 'EE', name: 'Estonia',        vat: 22,   capital: 20,   income: 20 },
  { code: 'FI', name: 'Finland',        vat: 25.5, capital: 34,   income: 51 },
  { code: 'FR', name: 'France',         vat: 20,   capital: 30,   income: 45 },
  { code: 'DE', name: 'Germany',        vat: 19,   capital: 26.375, income: 45 },
  { code: 'GR', name: 'Greece',         vat: 24,   capital: 15,   income: 44 },
  { code: 'HU', name: 'Hungary',        vat: 27,   capital: 15,   income: 15 },
  { code: 'IE', name: 'Ireland',        vat: 23,   capital: 33,   income: 40 },
  { code: 'IT', name: 'Italy',          vat: 22,   capital: 26,   income: 43 },
  { code: 'LV', name: 'Latvia',         vat: 21,   capital: 20,   income: 31 },
  { code: 'LT', name: 'Lithuania',      vat: 21,   capital: 20,   income: 32 },
  { code: 'LU', name: 'Luxembourg',     vat: 17,   capital: 24,   income: 42 },
  { code: 'MT', name: 'Malta',          vat: 18,   capital: 0,    income: 35 },
  { code: 'NL', name: 'Netherlands',    vat: 21,   capital: 32,   income: 49.5 },
  { code: 'PL', name: 'Poland',         vat: 23,   capital: 19,   income: 32 },
  { code: 'PT', name: 'Portugal',       vat: 23,   capital: 28,   income: 48 },
  { code: 'RO', name: 'Romania',        vat: 19,   capital: 10,   income: 10 },
  { code: 'SK', name: 'Slovakia',       vat: 23,   capital: 19,   income: 25 },
  { code: 'SI', name: 'Slovenia',       vat: 22,   capital: 25,   income: 50 },
  { code: 'ES', name: 'Spain',          vat: 21,   capital: 28,   income: 47 },
  { code: 'SE', name: 'Sweden',         vat: 25,   capital: 30,   income: 52 },
  // Non-EU European markets commonly served by TradeBridge Club members.
  { code: 'GB', name: 'United Kingdom', vat: 20,   capital: 24,   income: 45 },
  { code: 'NO', name: 'Norway',         vat: 25,   capital: 22,   income: 47 },
  { code: 'CH', name: 'Switzerland',    vat: 8.1,  capital: 0,    income: 40 },
  { code: 'IS', name: 'Iceland',        vat: 24,   capital: 22,   income: 46 },
];

export const CURRENCIES = [
  { code: 'EUR', symbol: '\u20ac' },
  { code: 'USD', symbol: '$' },
  { code: 'GBP', symbol: '\u00a3' },
  { code: 'SEK', symbol: 'kr' },
  { code: 'NOK', symbol: 'kr' },
  { code: 'CHF', symbol: 'CHF' },
];
