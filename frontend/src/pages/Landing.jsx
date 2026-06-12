import React from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import {
  Sparkles, Cpu, ShieldCheck, Zap, Code2, MessagesSquare,
  Bot, GitBranch, Layers, ArrowRight, Check, TrendingUp,
  LineChart, Lock, Globe, Share2,
} from 'lucide-react';
import ShareButtons from '../components/ShareButtons';

function Stat({ value, label }) {
  return (
    <div>
      <div className="text-3xl font-bold text-white tracking-tight">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-slate-400">{label}</div>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, desc }) {
  return (
    <Card className="group relative overflow-hidden border-slate-800 bg-slate-900/60 p-6 hover:border-tbc-500/40 transition-colors">
      <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-tbc-500/10 text-tbc-300 ring-1 ring-tbc-500/20 group-hover:bg-tbc-500/20 transition-colors">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
    </Card>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-ink-950 text-slate-100">
      <Navbar />

      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-60" />
        <div className="absolute inset-0 bg-radial-fade" />
        <div className="relative mx-auto max-w-7xl px-5 pt-20 pb-24 md:pt-28 md:pb-32">
          <div className="inline-flex items-center gap-2 rounded-full border border-tbc-500/30 bg-tbc-500/10 px-3 py-1 text-xs font-medium text-tbc-300">
            <Sparkles className="h-3.5 w-3.5" /> Powered by Claude, GPT-5 & Gemini
          </div>
          <h1 className="mt-6 max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight text-white md:text-7xl">
            Your AI engineer. <br />
            <span className="bg-gradient-to-r from-tbc-300 to-tbc-300 bg-clip-text text-transparent">
              Build full apps by talking.
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-300 md:text-xl">
            TBC AI Tools is a complete copy of an elite AI builder — design, code, debug, and ship
            production-grade applications through a single conversation. Now available to the TradeBridge Club.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/register">
              <Button className="bg-tbc-500 px-6 py-6 text-base font-semibold text-slate-950 hover:bg-tbc-400 shadow-lg shadow-tbc-500/20">
                Start building free <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/pricing">
              <Button variant="outline" className="border-slate-700 bg-slate-900/50 px-6 py-6 text-base text-slate-100 hover:bg-slate-800 hover:text-white">
                See pricing
              </Button>
            </Link>
          </div>

          <div className="mt-14 grid grid-cols-2 gap-8 border-t border-slate-800/80 pt-8 sm:grid-cols-4 max-w-3xl">
            <Stat value="3+" label="Frontier Models" />
            <Stat value="<150ms" label="Avg. Token Latency" />
            <Stat value="100%" label="Code Ownership" />
            <Stat value="2FA" label="Secure by Default" />
          </div>
        </div>
      </section>

      {/* MODEL STRIP */}
      <section className="border-y border-slate-800/80 bg-slate-900/40 py-8">
        <div className="mx-auto max-w-7xl px-5">
          <div className="text-center text-xs uppercase tracking-[0.25em] text-slate-500">Choose any model. One conversation.</div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-6 text-slate-300">
            {[
              { name: 'Claude Opus 4.7', sub: 'Anthropic' },
              { name: 'Claude Sonnet 4.6', sub: 'Anthropic' },
              { name: 'GPT-5', sub: 'OpenAI' },
              { name: 'Gemini 3.1 Pro', sub: 'Google' },
              { name: 'Gemini 3 Flash', sub: 'Google' },
              { name: 'GPT-4.1', sub: 'OpenAI' },
            ].map((m) => (
              <div key={m.name} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-ink-950/60 px-3.5 py-2">
                <Bot className="h-4 w-4 text-tbc-400" />
                <div className="leading-tight">
                  <div className="text-sm font-semibold text-white">{m.name}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">{m.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="py-20">
        <div className="mx-auto max-w-7xl px-5">
          <div className="max-w-2xl">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Capabilities</div>
            <h2 className="mt-3 text-4xl font-bold tracking-tight text-white md:text-5xl">
              The fastest path from idea to production.
            </h2>
            <p className="mt-4 text-lg text-slate-400">
              Built on the same operating principles as elite engineering teams — architecture-first, secure by
              default, and obsessively practical.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={Code2} title="Full-stack code generation" desc="React, FastAPI, MongoDB, Stripe, auth, and beyond — clean, idiomatic code you can ship." />
            <FeatureCard icon={MessagesSquare} title="Multi-turn memory" desc="Persistent sessions remember every detail of your project as it evolves." />
            <FeatureCard icon={Cpu} title="Pick your model" desc="Switch between GPT-5, Claude Sonnet/Opus, and Gemini Pro/Flash in a single click." />
            <FeatureCard icon={ShieldCheck} title="TOTP 2FA" desc="Google Authenticator-grade security on every account. Operator console for admins." />
            <FeatureCard icon={Zap} title="Token streaming" desc="Responses arrive word by word — no spinners, no waiting." />
            <FeatureCard icon={Layers} title="Architecture mode" desc="Ask for diagrams, schemas, contracts. TBC plans before it codes." />
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="border-t border-slate-800/80 bg-slate-900/30 py-20">
        <div className="mx-auto max-w-7xl px-5">
          <div className="text-center">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Workflow</div>
            <h2 className="mt-3 text-4xl font-bold text-white md:text-5xl">Ship in three steps.</h2>
          </div>
          <div className="mt-14 grid gap-8 md:grid-cols-3">
            {[
              { n: '01', title: 'Describe', desc: 'Tell TBC AI Tools what you want to build. Be vague — it will ask the right questions.', icon: MessagesSquare },
              { n: '02', title: 'Refine', desc: 'Iterate on architecture, schemas, and UI. Switch models mid-conversation as needed.', icon: GitBranch },
              { n: '03', title: 'Deploy', desc: 'Export production code, push to GitHub, or ship to your VPS. You own everything.', icon: TrendingUp },
            ].map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-slate-800 bg-ink-950/50 p-7">
                <div className="text-5xl font-bold text-tbc-500/20">{s.n}</div>
                <s.icon className="absolute right-6 top-6 h-5 w-5 text-tbc-400" />
                <h3 className="mt-3 text-xl font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-sm text-slate-400">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* TRUST */}
      <section className="py-20">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 md:grid-cols-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Security & Privacy</div>
            <h2 className="mt-3 text-4xl font-bold tracking-tight text-white">Built for operators who can&apos;t afford mistakes.</h2>
            <p className="mt-4 text-slate-400">
              Every session is encrypted in transit, every account is protected with TOTP 2FA, and the
              operator console gives administrators full oversight of users, payments, and conversations.
            </p>
            <ul className="mt-6 space-y-3">
              {['TOTP two-factor authentication (Google Authenticator compatible)',
                'JWT-secured API with credit-based usage controls',
                'Stripe-managed payments — we never touch your card data',
                'Operator console for member management & revenue analytics'].map((t) => (
                <li key={t} className="flex items-start gap-3 text-slate-200">
                  <Check className="mt-1 h-4 w-4 text-tbc-400 shrink-0" />
                  <span className="text-sm">{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="relative">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl shadow-tbc-500/5">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-tbc-400" />
                  <span className="text-sm font-medium text-slate-200">Two-Factor Verification</span>
                </div>
                <span className="rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-tbc-300">Active</span>
              </div>
              <div className="mt-5">
                <div className="text-xs text-slate-400">Enter the 6-digit code</div>
                <div className="mt-3 flex gap-2">
                  {['9','2','8','3','4','1'].map((d, i) => (
                    <div key={`totp-digit-${i}-${d}`} className="grid h-12 w-10 place-items-center rounded-md border border-slate-700 bg-ink-950 text-lg font-bold text-tbc-300">{d}</div>
                  ))}
                </div>
                <Button className="mt-5 w-full bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">Verify & continue</Button>
              </div>
            </div>
            <div className="absolute -inset-x-6 -bottom-10 -z-10 h-32 bg-tbc-500/10 blur-3xl" />
          </div>
        </div>
      </section>

      {/* TBC2 PROMO */}
      <section className="border-t border-tbc-900/60 py-16">
        <div className="mx-auto max-w-7xl px-5">
          <div className="grid gap-6 rounded-2xl border border-tbc-900/60 bg-ink-900/60 p-8 md:grid-cols-[1.4fr_1fr] md:p-12">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-tbc-500/30 bg-tbc-500/10 px-3 py-1 text-xs font-medium text-tbc-300">
                <Bot className="h-3.5 w-3.5" /> New · TBC2 AI Control
              </div>
              <h2 className="mt-4 text-4xl font-bold tracking-tight text-tbc-50 md:text-5xl">
                Two AI engineers, one membership.
              </h2>
              <p className="mt-4 max-w-xl text-lg text-tbc-200/70">
                Open <span className="font-semibold text-tbc-200">TBC1</span> for full-stack app building, and <span className="font-semibold text-tbc-200">TBC2</span> as a separate workspace for trading research and strategy. Same accounts, same models — different rooms.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/dashboard">
                  <Button className="bg-tbc-500 px-5 py-5 text-sm font-semibold text-ink-950 hover:bg-tbc-400">
                    <Cpu className="mr-2 h-4 w-4" /> Open TBC1
                  </Button>
                </Link>
                <Link to="/tbc2">
                  <Button variant="outline" className="border-tbc-500/40 bg-transparent px-5 py-5 text-sm text-tbc-100 hover:bg-tbc-500/10">
                    <Bot className="mr-2 h-4 w-4" /> Open TBC2 (new window)
                  </Button>
                </Link>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'TBC1', tag: 'Builder', icon: Cpu },
                { label: 'TBC2', tag: 'Trader', icon: Bot },
              ].map((t) => (
                <div key={t.label} className="rounded-xl border border-tbc-900/60 bg-ink-950/80 p-5">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-tbc-300 to-tbc-500">
                    <t.icon className="h-5 w-5 text-ink-950" strokeWidth={2.4} />
                  </div>
                  <div className="mt-3 text-lg font-bold text-tbc-50">{t.label}</div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-tbc-300/80">{t.tag}</div>
                  <div className="mt-3 text-xs text-tbc-200/60">All frontier models • SSE streaming • Session history</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-slate-800/80 py-20">
        <div className="mx-auto max-w-5xl px-5 text-center">
          <h2 className="text-4xl font-bold tracking-tight text-white md:text-5xl">Ready to ship faster?</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
            Join the TradeBridge Club and put a full engineering team in your browser. No credit card required to start.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/register">
              <Button className="bg-tbc-500 px-7 py-6 text-base font-semibold text-slate-950 hover:bg-tbc-400 shadow-lg shadow-tbc-500/20">
                Create free account <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/pricing">
              <Button variant="outline" className="border-slate-700 bg-transparent px-7 py-6 text-base text-slate-100 hover:bg-slate-800">
                View plans
              </Button>
            </Link>
          </div>

          {/* Share row */}
          <div className="mx-auto mt-12 max-w-2xl">
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-tbc-900/60 bg-ink-900 px-3 py-1 text-xs text-tbc-300">
              <Share2 className="h-3.5 w-3.5" /> Share TBC AI Tools
            </div>
            <div className="flex justify-center">
              <ShareButtons url="https://www.tbctools.org" text="I'm using TBC AI Tools to build apps faster. Try it:" />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
