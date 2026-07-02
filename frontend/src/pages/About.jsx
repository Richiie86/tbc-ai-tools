import React from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { ShieldCheck, Code2, Globe, Users, Target, Sparkles } from 'lucide-react';

export default function About() {
  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-5xl px-5 pt-20 pb-12">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">About TBC AI Tools</div>
        <h1 className="mt-3 text-5xl font-bold tracking-tight text-white md:text-6xl">A copy of an elite AI builder — yours to operate.</h1>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-slate-300">
          TBC AI Tools was created for the TradeBridge Club to put the power of frontier large language
          models behind a single, polished, operator-grade interface. Every conversation is private,
          persistent, and secured with two-factor authentication.
        </p>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-400">
          Behind the scenes we orchestrate GPT-5, Claude 4 and Gemini 3 through a unified API so you can
          choose the right brain for the right job — reasoning, code, long context, or rapid iteration.
        </p>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {[
            { icon: Target,      title: 'Mission',  desc: 'Make production-grade software accessible to anyone who can describe an idea.' },
            { icon: ShieldCheck, title: 'Security', desc: 'TOTP 2FA, JWT auth, encrypted transit, and zero card storage — by default.' },
            { icon: Globe,       title: 'Reach',    desc: 'Hosted globally so every member experiences low-latency token streaming.' },
          ].map((b) => (
            <div key={b.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-7">
              <b.icon className="h-6 w-6 text-tbc-400" />
              <div className="mt-3 text-lg font-semibold text-white">{b.title}</div>
              <p className="mt-2 text-sm text-slate-400">{b.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-14">
          <h2 className="text-3xl font-bold tracking-tight text-white">The team behind the engine</h2>
          <p className="mt-3 max-w-3xl text-sm text-slate-400">
            TradeBridge Club is a small senior team focused on reliability, privacy and rapid model
            adoption. New models are integrated within days of release.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 max-w-4xl">
            {[
              { name: 'Sandra Pereira', role: 'Head of Operations' },
              { name: 'Marc Liu',       role: 'Lead AI Engineer' },
              { name: 'Aisha Khan',     role: 'Security Architect' },
            ].map((p) => (
              <div key={p.name} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <div className="grid h-7 w-7 place-items-center rounded-full bg-tbc-500/20 text-[10px] font-bold text-tbc-300">{p.name.split(' ').map((s)=>s[0]).join('')}</div>
                <div className="mt-2 text-xs font-semibold text-white">{p.name}</div>
                <div className="text-[9px] uppercase tracking-wider text-slate-500">{p.role}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <Footer />
    </div>
  );
}
