import React from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import {
  ShieldCheck, Code2, Globe, Rocket, Target, Sparkles,
  Gauge, Lock, Layers, ShoppingBag, Gamepad2, Search, Network,
} from 'lucide-react';

/** Public "About" page — the story of TBC AI Tools, the team behind it,
 *  and how it fits into the wider TBC ecosystem. */
export default function About() {
  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-5 pt-20 pb-10">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">
          About TBC AI Tools
        </div>
        <h1 className="mt-3 text-balance text-5xl font-bold tracking-tight text-white md:text-6xl">
          Describe it. Ship it. Own it.
        </h1>
        <p className="mt-6 max-w-3xl text-pretty text-lg leading-relaxed text-slate-300">
          TBC AI Tools is an operator-grade AI build platform that turns plain language into
          production software — real code, real deploys, real infrastructure. It&apos;s the engine
          that lets a single founder move like a full engineering team, and it powers the entire
          TBC ecosystem from the inside out.
        </p>
        <p className="mt-4 max-w-3xl text-pretty text-lg leading-relaxed text-slate-400">
          Under the hood we orchestrate the world&apos;s strongest models — the GPT, Claude and
          Gemini families — behind one unified, secured interface, so you always get the right
          brain for the job: deep reasoning, long-context analysis, or fast iterative building.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/register"
            className="inline-flex items-center gap-2 rounded-lg bg-tbc-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-tbc-400"
          >
            <Rocket className="h-4 w-4" /> Start building
          </Link>
          <Link
            to="/pricing"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            See pricing
          </Link>
        </div>
      </section>

      {/* Why it matters */}
      <section className="mx-auto max-w-5xl px-5 py-10">
        <h2 className="text-3xl font-bold tracking-tight text-white">Why teams and companies need this</h2>
        <p className="mt-3 max-w-3xl text-pretty leading-relaxed text-slate-400">
          Traditional software delivery is slow, expensive and gate-kept by scarce engineering
          talent. TBC AI Tools collapses that gap: ideas become working products in hours, not
          quarters — without giving up security, ownership or control.
        </p>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {[
            { icon: Gauge, title: 'Move at idea-speed', desc: 'Go from prompt to deployed app in a single session. Iterate live while your users watch it improve.' },
            { icon: Code2, title: 'Real, ownable code', desc: 'No black boxes. You get genuine repositories, PR-gated deploys and an AI reviewer guarding every ship.' },
            { icon: Lock, title: 'Secure by default', desc: 'TOTP 2FA, JWT sessions, encrypted secrets at rest, rate-limited AI endpoints and zero card storage.' },
            { icon: Layers, title: 'One platform, many jobs', desc: 'Build web apps, storefronts, tools and automations — all from the same operator console.' },
            { icon: Globe, title: 'Global & always-on', desc: 'Hosted worldwide for low-latency streaming, with health checks and auto-recovery built in.' },
            { icon: Target, title: 'Built for operators', desc: 'Deploy, review, monitor and bill from one place. It runs a business, not just a chat window.' },
          ].map((b) => (
            <div key={b.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-7">
              <b.icon className="h-6 w-6 text-tbc-400" />
              <div className="mt-3 text-lg font-semibold text-white">{b.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{b.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The team behind the engine */}
      <section className="mx-auto max-w-5xl px-5 py-10">
        <h2 className="text-3xl font-bold tracking-tight text-white">The team behind the engine</h2>
        <div className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-start">
          <div className="rounded-2xl border border-tbc-500/30 bg-gradient-to-br from-slate-900/80 to-slate-900/40 p-7">
            <div className="flex items-center gap-4">
              <div className="grid h-14 w-14 place-items-center rounded-full bg-tbc-500/20 text-lg font-bold text-tbc-300">
                RA
              </div>
              <div>
                <div className="text-xl font-semibold text-white">Richard Almroth</div>
                <div className="text-xs font-semibold uppercase tracking-wider text-tbc-400">
                  Founder &amp; Architect of the Engine
                </div>
              </div>
            </div>
            <p className="mt-5 text-pretty leading-relaxed text-slate-300">
              TBC AI Tools was designed and built by <span className="text-white">Richard Almroth</span>,
              the founder behind the TBC ecosystem. What started as a personal tool to build faster
              grew into a full operator platform — the same engine now runs every product under the
              TBC name.
            </p>
            <p className="mt-3 text-pretty leading-relaxed text-slate-400">
              Richard leads a small, senior team that obsesses over reliability, privacy and rapid
              model adoption. Because the team is lean, decisions are fast and new frontier models
              are integrated within days of release — never months.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-7">
            <Sparkles className="h-6 w-6 text-tbc-400" />
            <div className="mt-3 text-lg font-semibold text-white">A small team, on purpose</div>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              We stay small so we can stay sharp. Every line that ships is reviewed, every model is
              vetted, and every user talks to people who actually build the product — not a support
              queue.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-slate-300">
              <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-tbc-400" /> Privacy-first by design</li>
              <li className="flex items-center gap-2"><Rocket className="h-4 w-4 text-tbc-400" /> New models in days</li>
              <li className="flex items-center gap-2"><Code2 className="h-4 w-4 text-tbc-400" /> Operator-grade tooling</li>
            </ul>
          </div>
        </div>
      </section>

      {/* The TBC ecosystem */}
      <section className="mx-auto max-w-5xl px-5 py-10 pb-20">
        <h2 className="text-3xl font-bold tracking-tight text-white">One engine, a whole ecosystem</h2>
        <p className="mt-3 max-w-3xl text-pretty leading-relaxed text-slate-400">
          TBC AI Tools doesn&apos;t stand alone — it&apos;s the build engine powering a connected
          family of TBC products. Everything below is designed to work together, so members grow
          across the entire ecosystem instead of juggling disconnected tools.
        </p>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: Sparkles, title: 'TBC AI Tools', tag: 'The engine', desc: 'The AI build-and-deploy platform that powers everything else in the ecosystem.' },
            { icon: Network, title: 'TradeBridge Club', tag: 'The community', desc: 'The home base and member community the whole ecosystem is built around.' },
            { icon: Search, title: 'TBCAuditor', tag: 'Audit & insight', desc: 'Automated auditing and analysis that keeps projects healthy, compliant and sharp.' },
            { icon: Globe, title: 'TBCDomains', tag: 'Identity', desc: 'Domains and web identity so every project launches with a real, professional home.' },
            { icon: ShoppingBag, title: 'TBCStore', tag: 'Commerce', desc: 'Storefronts and commerce for selling products and services across the ecosystem.' },
            { icon: Gamepad2, title: 'TBC Games', tag: 'Play', desc: 'Interactive experiences and games that bring the community together.' },
          ].map((p) => (
            <div key={p.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 transition hover:border-tbc-500/40">
              <p.icon className="h-6 w-6 text-tbc-400" />
              <div className="mt-3 flex items-center gap-2">
                <span className="text-lg font-semibold text-white">{p.title}</span>
                <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tbc-300">{p.tag}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{p.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border border-tbc-500/30 bg-gradient-to-br from-tbc-500/10 to-slate-900/40 p-8 text-center">
          <h3 className="text-balance text-2xl font-bold text-white">Build your next idea on the same engine we do.</h3>
          <p className="mx-auto mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-300">
            Join the TBC ecosystem and turn what you can describe into something you can ship.
          </p>
          <Link
            to="/register"
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-tbc-500 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-tbc-400"
          >
            <Rocket className="h-4 w-4" /> Get started free
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}
