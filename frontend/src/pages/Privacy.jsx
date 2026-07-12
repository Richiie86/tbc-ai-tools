import React from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

export default function Privacy() {
  return (
    <div className="min-h-screen bg-ink-950 text-slate-100" data-testid="privacy-page">
      <Navbar />
      <main className="mx-auto max-w-3xl px-5 py-16 sm:py-24">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Privacy Policy</div>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">How TBCTools handles your data</h1>
        <p className="mt-4 text-sm text-slate-400">Last updated: July 2026</p>

        <section className="mt-10 space-y-6 text-sm leading-7 text-slate-300">
          <p>
            TBCTools processes account details, chat prompts, generated outputs, deployment metadata,
            support messages, and payment records to provide the AI build and deployment service.
          </p>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">AI processing</h2>
            <p className="mt-2">
              Prompts and context may be sent to configured AI providers such as Anthropic, OpenAI,
              Google Gemini, OpenRouter, or other providers enabled by the operator. Do not submit
              secrets, private keys, or sensitive personal data unless you intend those providers to process it.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">Infrastructure and logs</h2>
            <p className="mt-2">
              The frontend runs on Vercel and the backend runs on Render. Runtime errors, deployment
              status, browser metadata, and diagnostic logs may be collected to keep the app reliable,
              debug failures, and power the operator error dashboard.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">Payments and support</h2>
            <p className="mt-2">
              Payment processors and email/support providers receive the information needed to process
              purchases, receipts, refunds, and support requests. TBCTools does not intentionally expose
              stored API keys or tokens to the browser.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">Your choices</h2>
            <p className="mt-2">
              Contact the operator to request access, correction, deletion, or export of account data
              where applicable. Some records may be retained for security, billing, legal, or abuse-prevention reasons.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
