import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../components/ui/dialog';
import {
  Sparkles, Cpu, ShieldCheck, Zap, Code2, MessagesSquare,
  Bot, GitBranch, Layers, ArrowRight, Check, TrendingUp,
  LineChart, Lock, Globe, Share2, BrainCircuit, BookOpenCheck, Search,
} from 'lucide-react';
import ShareButtons from '../components/ShareButtons';

// Extended copy for each capability card. Clicking a card opens a detail
// dialog ("new view") so the homepage tiles are actually interactive instead
// of being dead decoration.
const FEATURES = [
  {
    icon: BrainCircuit,
    title: 'Automatic model routing (amAI)',
    desc: 'Never pick a model again — amAI sends each message to the right AI and saves you credits.',
    long: 'amAI reads every message and quietly routes it to the best model for the job: a fast, inexpensive model for quick questions and a powerful one for real engineering. You get great answers without overpaying, and a small note tells you which model was chosen and why.',
    points: [
      'Cheap-and-fast for simple questions, powerful for hard problems',
      'Automatic — no manual switching, no guesswork',
      'Transparent: see which model handled each message',
    ],
    cta: { label: 'Try Automatic mode', to: '/register' },
  },
  {
    icon: BookOpenCheck,
    title: 'Always-current code docs',
    desc: 'Fresh, version-specific documentation is pulled into coding answers automatically.',
    long: 'Ask about React, Next.js, Tailwind, or dozens of other libraries and TBC automatically fetches the newest official docs (via Context7) before answering. You even name a version — "Next.js 14 routing" — and it pins docs to exactly that release, so the code it writes actually runs.',
    points: [
      'Newest official docs folded into answers in real time',
      'Version-aware — target the exact release you use',
      'Far fewer outdated snippets and deprecated APIs',
    ],
    cta: { label: 'Build with current docs', to: '/register' },
  },
  {
    icon: Search,
    title: 'Live web search & step-by-step reasoning',
    desc: 'The AI can search the live web for current facts and plan complex tasks methodically.',
    long: 'When a question needs up-to-date, real-world information, TBC searches the live web and folds the results into its reply instead of relying only on training data. For big, multi-part tasks it can switch on structured step-by-step reasoning so nothing gets missed.',
    points: [
      'Live web results for current news, versions, and prices',
      'Structured step-by-step planning for complex builds',
      'You see exactly when each tool was used',
    ],
    cta: { label: 'See it in action', to: '/register' },
  },
  {
    icon: Code2,
    title: 'Full-stack code generation',
    desc: 'React, FastAPI, MongoDB, Stripe, auth, and beyond — clean, idiomatic code you can ship.',
    long: 'Describe a product and TBC scaffolds the whole stack — a React front end, a FastAPI backend, MongoDB models, Stripe billing, and JWT auth — wired together and ready to run.',
    points: [
      'Front end, backend, and database generated together and kept in sync',
      'Idiomatic, readable code you fully own and can export to GitHub',
      'Payments, auth, and email flows scaffolded, not stubbed',
    ],
    cta: { label: 'Start building', to: '/register' },
  },
  {
    icon: MessagesSquare,
    title: 'Multi-turn memory',
    desc: 'Persistent sessions remember every detail of your project as it evolves.',
    long: 'Every conversation is a persistent session. TBC remembers your architecture decisions, file layout, and prior instructions across turns, so you can keep refining instead of re-explaining.',
    points: [
      'Sessions persist across days — pick up exactly where you left off',
      'Earlier decisions inform later replies automatically',
      'Full project context travels between messages',
    ],
    cta: { label: 'Open your workspace', to: '/dashboard' },
  },
  {
    icon: Cpu,
    title: '300+ AI models in one place',
    desc: 'GPT-5, Claude Opus, Gemini, Llama, Mistral, DeepSeek, Grok and 300+ more — all under one login.',
    long: 'Every major AI lab, in a single searchable picker. Reach for Claude Opus on hard architecture, GPT-5 for breadth, Gemini Flash for speed, or explore open models like Llama, Mistral and DeepSeek — all included in your membership. Switch mid-conversation without losing context, or let amAI pick for you.',
    points: [
      '300+ models from OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek, xAI & more',
      'Search and switch models mid-session — memory carries over',
      'One membership, one bill — no separate provider accounts to manage',
    ],
    cta: { label: 'See the models', to: '/dashboard' },
  },
  {
    icon: ShieldCheck,
    title: 'TOTP 2FA',
    desc: 'Google Authenticator-grade security on every account. Operator console for admins.',
    long: 'Every account can be protected with time-based one-time passwords, compatible with Google Authenticator and Authy. Operators get a full console to manage members, payments, and security.',
    points: [
      'TOTP 2FA compatible with any standard authenticator app',
      'JWT-secured API with credit-based usage controls',
      'Operator console for member, payment, and security oversight',
    ],
    cta: { label: 'Secure your account', to: '/register' },
  },
  {
    icon: Zap,
    title: 'Token streaming',
    desc: 'Responses arrive word by word — no spinners, no waiting.',
    long: 'Replies stream token-by-token over Server-Sent Events, so you read and react as the model thinks. No more staring at a spinner waiting for a full response to land.',
    points: [
      'Server-Sent Events stream every reply in real time',
      'Start reading and steering before generation finishes',
      'Works consistently across all supported models',
    ],
    cta: { label: 'Try it live', to: '/dashboard' },
  },
  {
    icon: Layers,
    title: 'Architecture mode',
    desc: 'Ask for diagrams, schemas, contracts. TBC plans before it codes.',
    long: 'Before writing a line of code, TBC can plan: data models, API contracts, component trees, and diagrams. Approve the plan, then let it build against a shared blueprint.',
    points: [
      'Get schemas, API contracts, and diagrams up front',
      'Review and approve the plan before any code is written',
      'Fewer rewrites — the build follows an agreed blueprint',
    ],
    cta: { label: 'Plan a build', to: '/dashboard' },
  },
];

function Stat({ value, label }) {
  return (
    <div>
      <div className="text-3xl font-bold text-white tracking-tight">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-slate-400">{label}</div>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, desc, onOpen }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="group relative cursor-pointer overflow-hidden border-slate-800 bg-slate-900/60 p-6 transition-colors hover:border-tbc-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tbc-500/50"
    >
      <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-tbc-500/10 text-tbc-300 ring-1 ring-tbc-500/20 transition-colors group-hover:bg-tbc-500/20">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
      <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-tbc-300 opacity-0 transition-opacity group-hover:opacity-100">
        Learn more <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </Card>
  );
}

export default function Landing() {
  // Index of the capability card whose detail dialog is open (null = closed).
  const [openFeature, setOpenFeature] = useState(null);
  const active = openFeature != null ? FEATURES[openFeature] : null;

  return (
    <div className="min-h-screen bg-ink-950 text-slate-100">
      <Navbar />

      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-60" />
        <div className="absolute inset-0 bg-radial-fade" />
        <div className="relative mx-auto max-w-7xl px-5 pt-20 pb-24 md:pt-28 md:pb-32">
          <div className="inline-flex items-center gap-2 rounded-full border border-tbc-500/30 bg-tbc-500/10 px-3 py-1 text-xs font-medium text-tbc-300">
            <Sparkles className="h-3.5 w-3.5" /> 300+ AI models · amAI smart routing · live web search & always-current docs
          </div>
          <h1 className="mt-6 max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight text-white md:text-7xl">
            300+ AI models. <br />
            <span className="bg-gradient-to-r from-tbc-300 to-tbc-300 bg-clip-text text-transparent">
              One membership. Build anything.
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-300 md:text-xl">
            Design, code, debug, and ship production-grade apps through a single conversation —
            powered by <span className="font-semibold text-white">300+ AI models</span> from OpenAI, Anthropic,
            Google, Meta, Mistral, DeepSeek, xAI and more. amAI picks the best one for every task automatically,
            so you get the smartest answer at the lowest cost — no juggling accounts, no separate bills.
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
            <Stat value="300+" label="AI Models Included" />
            <Stat value="Auto" label="Smart Model Routing" />
            <Stat value="Live" label="Web Search & Docs" />
            <Stat value="100%" label="Code Ownership" />
          </div>
        </div>
      </section>

      {/* MODEL STRIP */}
      <section className="border-y border-slate-800/80 bg-slate-900/40 py-8">
        <div className="mx-auto max-w-7xl px-5">
          <div className="text-center text-xs uppercase tracking-[0.25em] text-slate-500">300+ models on tap — let amAI choose, or pick any one yourself.</div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-6 text-slate-300">
            {[
              { name: 'Automatic (amAI)', sub: 'Smart routing', featured: true },
              { name: 'Claude Opus 4.7', sub: 'Anthropic' },
              { name: 'GPT-5', sub: 'OpenAI' },
              { name: 'Gemini 3.1 Pro', sub: 'Google' },
              { name: 'Llama 3.1 405B', sub: 'Meta' },
              { name: 'Mistral Large', sub: 'Mistral' },
              { name: 'DeepSeek V3', sub: 'DeepSeek' },
              { name: 'Grok', sub: 'xAI' },
            ].map((m) => (
              <div
                key={m.name}
                className={`flex items-center gap-2 rounded-lg border px-3.5 py-2 ${
                  m.featured
                    ? 'border-tbc-500/50 bg-tbc-500/10 ring-1 ring-tbc-500/30'
                    : 'border-slate-800 bg-ink-950/60'
                }`}
              >
                {m.featured
                  ? <BrainCircuit className="h-4 w-4 text-tbc-300" />
                  : <Bot className="h-4 w-4 text-tbc-400" />}
                <div className="leading-tight">
                  <div className={`text-sm font-semibold ${m.featured ? 'text-tbc-100' : 'text-white'}`}>{m.name}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">{m.sub}</div>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 rounded-lg border border-tbc-500/40 bg-tbc-500/10 px-3.5 py-2">
              <Layers className="h-4 w-4 text-tbc-300" />
              <div className="leading-tight">
                <div className="text-sm font-semibold text-tbc-100">+300 more</div>
                <div className="text-[10px] uppercase tracking-wider text-tbc-300/70">Every major lab</div>
              </div>
            </div>
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
          <p className="mt-3 text-sm text-slate-500">Tap any capability to see how it works.</p>
          <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <FeatureCard
                key={f.title}
                icon={f.icon}
                title={f.title}
                desc={f.desc}
                onOpen={() => setOpenFeature(i)}
              />
            ))}
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
          <h2 className="text-4xl font-bold tracking-tight text-white md:text-5xl">300+ AI models. One price.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
            Join the TradeBridge Club and unlock every major AI model — GPT-5, Claude, Gemini, Llama and 300+ more —
            plus a full engineering team in your browser. One membership replaces a stack of separate AI subscriptions.
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

      {/* Capability detail — opens as a focused "new view" over the page. */}
      <Dialog open={openFeature != null} onOpenChange={(o) => { if (!o) setOpenFeature(null); }}>
        <DialogContent className="border-slate-800 bg-ink-950 text-slate-100 sm:max-w-lg">
          {active && (
            <>
              <DialogHeader>
                <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-tbc-500/10 text-tbc-300 ring-1 ring-tbc-500/20">
                  <active.icon className="h-6 w-6" />
                </div>
                <DialogTitle className="text-2xl font-bold text-white">{active.title}</DialogTitle>
                <DialogDescription className="text-base leading-relaxed text-slate-300">
                  {active.long}
                </DialogDescription>
              </DialogHeader>
              <ul className="mt-2 space-y-3">
                {active.points.map((p) => (
                  <li key={p} className="flex items-start gap-3 text-slate-200">
                    <Check className="mt-1 h-4 w-4 shrink-0 text-tbc-400" />
                    <span className="text-sm leading-relaxed">{p}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <Link to={active.cta.to} onClick={() => setOpenFeature(null)}>
                  <Button className="w-full bg-tbc-500 font-semibold text-slate-950 hover:bg-tbc-400">
                    {active.cta.label} <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Footer />
    </div>
  );
}
