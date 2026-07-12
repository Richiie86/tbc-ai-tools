import React from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

export default function Terms() {
  return (
    <div className="min-h-screen bg-ink-950 text-slate-100" data-testid="terms-page">
      <Navbar />
      <main className="mx-auto max-w-3xl px-5 py-16 sm:py-24">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Terms of Service</div>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">Rules for using TBCTools</h1>
        <p className="mt-4 text-sm text-slate-400">Last updated: July 2026</p>

        <section className="mt-10 space-y-6 text-sm leading-7 text-slate-300">
          <p>
            By using TBCTools, you agree to use the platform lawfully and responsibly. The service helps
            users generate, review, and deploy software with AI assistance, but you remain responsible for
            reviewing and approving what you ship.
          </p>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">Acceptable use</h2>
            <p className="mt-2">
              Do not use TBCTools to create malware, phishing pages, spam systems, illegal surveillance,
              abusive automation, or content that violates applicable law or provider policies.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">AI outputs</h2>
            <p className="mt-2">
              AI output can be incomplete, insecure, or wrong. You must review code, deployments,
              billing behavior, and legal/compliance requirements before relying on them in production.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">Accounts, keys, and deployments</h2>
            <p className="mt-2">
              You are responsible for the API keys, GitHub repositories, Vercel projects, Render services,
              domains, and payment settings connected to your workspace. Rotate secrets if you suspect exposure.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold text-tbc-100">Availability and changes</h2>
            <p className="mt-2">
              TBCTools may change, pause, or remove features to maintain security and reliability. The operator
              may restrict access for abuse, non-payment, security risk, or violation of these terms.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
