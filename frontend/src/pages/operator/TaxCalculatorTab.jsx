import React, { useMemo, useState } from 'react';
import { Calculator, TrendingUp, Receipt, Wallet, Info } from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { EU_TAX_RATES, CURRENCIES } from '../../lib/euTaxRates';

const MODES = [
  { id: 'capital', label: 'Capital gains', icon: TrendingUp },
  { id: 'vat', label: 'VAT', icon: Receipt },
  { id: 'income', label: 'Income tax', icon: Wallet },
];

function num(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function ResultRow({ label, value, symbol, strong, accent }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className={`text-sm ${strong ? 'font-semibold text-tbc-100' : 'text-tbc-200/70'}`}>{label}</span>
      <span
        className={`font-mono text-sm ${
          accent === 'pay' ? 'text-rose-300' : accent === 'keep' ? 'text-emerald-300' : 'text-tbc-100'
        } ${strong ? 'text-base font-bold' : ''}`}
      >
        {symbol}{value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}

export default function TaxCalculatorTab() {
  const [mode, setMode] = useState('capital');
  const [countryCode, setCountryCode] = useState('SE');
  const [currency, setCurrency] = useState('EUR');

  // Capital gains inputs
  const [proceeds, setProceeds] = useState('');
  const [cost, setCost] = useState('');
  // VAT inputs
  const [vatAmount, setVatAmount] = useState('');
  const [vatDirection, setVatDirection] = useState('add'); // add = net→gross, extract = gross→net
  // Income inputs
  const [income, setIncome] = useState('');

  const country = useMemo(
    () => EU_TAX_RATES.find((c) => c.code === countryCode) || EU_TAX_RATES[0],
    [countryCode],
  );
  const symbol = (CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0]).symbol;

  const capital = useMemo(() => {
    const gain = num(proceeds) - num(cost);
    const rate = country.capital / 100;
    const tax = gain > 0 ? gain * rate : 0;
    return { gain, tax, net: gain - tax, rate: country.capital };
  }, [proceeds, cost, country]);

  const vat = useMemo(() => {
    const rate = country.vat / 100;
    const amount = num(vatAmount);
    if (vatDirection === 'add') {
      const tax = amount * rate;
      return { net: amount, tax, gross: amount + tax, rate: country.vat };
    }
    // extract: amount is gross (VAT-inclusive)
    const net = amount / (1 + rate);
    return { net, tax: amount - net, gross: amount, rate: country.vat };
  }, [vatAmount, vatDirection, country]);

  const inc = useMemo(() => {
    const gross = num(income);
    const rate = country.income / 100;
    const tax = gross * rate;
    return { gross, tax, net: gross - tax, rate: country.income };
  }, [income, country]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-tbc-100">
          <Calculator className="h-5 w-5 text-tbc-300" /> EU Tax Calculator
        </h2>
        <p className="mt-1 text-sm text-tbc-200/60">
          Estimate what you owe and what you keep across 31 European countries — capital gains, VAT, and income tax.
        </p>
      </div>

      {/* Mode switch */}
      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => {
          const Icon = m.icon;
          const activeMode = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                activeMode
                  ? 'border-tbc-500 bg-tbc-500 text-ink-950'
                  : 'border-tbc-900/60 bg-ink-900 text-tbc-200/70 hover:border-tbc-500/40'
              }`}
            >
              <Icon className="h-4 w-4" /> {m.label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Inputs */}
        <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-tbc-200/70">Country</Label>
              <Select value={countryCode} onValueChange={setCountryCode}>
                <SelectTrigger className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {EU_TAX_RATES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-tbc-200/70">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {mode === 'capital' && (
              <>
                <div>
                  <Label className="text-xs text-tbc-200/70">Sale proceeds (what you sold for)</Label>
                  <Input inputMode="decimal" value={proceeds} onChange={(e) => setProceeds(e.target.value)}
                    placeholder="0.00" className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100" />
                </div>
                <div>
                  <Label className="text-xs text-tbc-200/70">Cost basis (what you paid)</Label>
                  <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)}
                    placeholder="0.00" className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100" />
                </div>
              </>
            )}
            {mode === 'vat' && (
              <>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setVatDirection('add')}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${vatDirection === 'add' ? 'border-tbc-500 bg-tbc-500/15 text-tbc-100' : 'border-tbc-900/60 text-tbc-200/60'}`}>
                    Add VAT (net → gross)
                  </button>
                  <button type="button" onClick={() => setVatDirection('extract')}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${vatDirection === 'extract' ? 'border-tbc-500 bg-tbc-500/15 text-tbc-100' : 'border-tbc-900/60 text-tbc-200/60'}`}>
                    Extract VAT (gross → net)
                  </button>
                </div>
                <div>
                  <Label className="text-xs text-tbc-200/70">
                    {vatDirection === 'add' ? 'Net amount (before VAT)' : 'Gross amount (VAT included)'}
                  </Label>
                  <Input inputMode="decimal" value={vatAmount} onChange={(e) => setVatAmount(e.target.value)}
                    placeholder="0.00" className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100" />
                </div>
              </>
            )}
            {mode === 'income' && (
              <div>
                <Label className="text-xs text-tbc-200/70">Gross income</Label>
                <Input inputMode="decimal" value={income} onChange={(e) => setIncome(e.target.value)}
                  placeholder="0.00" className="mt-1 border-tbc-900/60 bg-ink-950 text-tbc-100" />
              </div>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
          <div className="flex items-center justify-between border-b border-tbc-900/60 pb-2">
            <span className="text-xs uppercase tracking-wider text-tbc-200/50">{country.name}</span>
            <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-semibold text-tbc-300">
              {mode === 'capital' && `${capital.rate}% capital gains`}
              {mode === 'vat' && `${vat.rate}% VAT`}
              {mode === 'income' && `${inc.rate}% income (headline)`}
            </span>
          </div>

          <div className="mt-2 divide-y divide-tbc-900/40">
            {mode === 'capital' && (
              <>
                <ResultRow label="Gross gain" value={capital.gain} symbol={symbol} />
                <ResultRow label="Tax to pay" value={capital.tax} symbol={symbol} accent="pay" />
                <ResultRow label="Net gain you keep" value={capital.net} symbol={symbol} accent="keep" strong />
              </>
            )}
            {mode === 'vat' && (
              <>
                <ResultRow label="Net (ex-VAT)" value={vat.net} symbol={symbol} />
                <ResultRow label="VAT to remit" value={vat.tax} symbol={symbol} accent="pay" />
                <ResultRow label="Gross (inc-VAT)" value={vat.gross} symbol={symbol} accent="keep" strong />
              </>
            )}
            {mode === 'income' && (
              <>
                <ResultRow label="Gross income" value={inc.gross} symbol={symbol} />
                <ResultRow label="Estimated tax" value={inc.tax} symbol={symbol} accent="pay" />
                <ResultRow label="Take-home" value={inc.net} symbol={symbol} accent="keep" strong />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200/80">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Estimates use each country&apos;s headline standard rates and are for planning only — not tax advice.
          Real liabilities depend on holding period, income brackets, allowances, and residency. Income tax uses the
          top marginal rate, so actual tax on lower incomes is usually less.
        </span>
      </div>
    </div>
  );
}
