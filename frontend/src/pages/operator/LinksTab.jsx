import React from 'react';
import {
  Github, Rocket, Server, Globe, Database, CreditCard, Cloud,
  Mail, Wallet, ExternalLink, BarChart3, ShieldCheck,
} from 'lucide-react';

/**
 * Operator → Links
 * A single, sorted place with one-click shortcuts to every external service
 * this app is wired up to (code, hosting, domain, database, payments, email).
 * Purely client-side — every entry is a plain external link, so there's
 * nothing to break and nothing sensitive stored here.
 */

const REPO = 'Richiie86/tbc-ai-tools';

const GROUPS = [
  {
    title: 'Code & Deploy',
    blurb: 'Source code and the platforms that host the frontend & backend.',
    links: [
      { label: 'GitHub repo', desc: REPO, href: `https://github.com/${REPO}`, icon: Github },
      { label: 'GitHub — commits', desc: 'Recent pushes & history', href: `https://github.com/${REPO}/commits`, icon: Github },
      { label: 'GitHub — pull requests', desc: 'Open & merged PRs', href: `https://github.com/${REPO}/pulls`, icon: Github },
      { label: 'Vercel', desc: 'Frontend hosting & deploys', href: 'https://vercel.com/dashboard', icon: Rocket },
      { label: 'Render', desc: 'Backend API hosting', href: 'https://dashboard.render.com', icon: Server },
    ],
  },
  {
    title: 'Domain & Network',
    blurb: 'Where the tbctools.org domain and DNS/CDN are managed.',
    links: [
      { label: 'IONOS', desc: 'Domain & DNS registrar', href: 'https://my.ionos.com', icon: Globe },
      { label: 'Cloudflare', desc: 'DNS, CDN & proxy', href: 'https://dash.cloudflare.com', icon: Cloud },
    ],
  },
  {
    title: 'Database',
    blurb: 'The MongoDB cluster that stores users, sessions and projects.',
    links: [
      { label: 'MongoDB Atlas', desc: 'Database cluster & collections', href: 'https://cloud.mongodb.com', icon: Database },
    ],
  },
  {
    title: 'Payments',
    blurb: 'Checkout, subscriptions and crypto/PayPal payouts.',
    links: [
      { label: 'Stripe', desc: 'Card payments & subscriptions', href: 'https://dashboard.stripe.com', icon: CreditCard },
      { label: 'NOWPayments', desc: 'Crypto payments', href: 'https://account.nowpayments.io', icon: Wallet },
      { label: 'PayPal', desc: 'PayPal payouts', href: 'https://www.paypal.com/signin', icon: Wallet },
    ],
  },
  {
    title: 'Email & Monitoring',
    blurb: 'Transactional email and app analytics.',
    links: [
      { label: 'Resend', desc: 'Transactional email', href: 'https://resend.com/overview', icon: Mail },
      { label: 'Google Analytics', desc: 'Traffic & usage', href: 'https://analytics.google.com', icon: BarChart3 },
    ],
  },
];

function LinkCard({ label, desc, href, icon: Icon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={`operator-link-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className="group flex items-center gap-3 rounded-xl border border-tbc-900/50 bg-ink-950/60 p-3.5 transition hover:border-tbc-500/50 hover:bg-ink-900"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-tbc-500/10 text-tbc-300 ring-1 ring-tbc-900/60 group-hover:bg-tbc-500/20">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-tbc-100">
          <span className="truncate">{label}</span>
          <ExternalLink className="h-3 w-3 shrink-0 text-tbc-200/40 group-hover:text-tbc-300" />
        </div>
        <div className="truncate text-xs text-tbc-200/60">{desc}</div>
      </div>
    </a>
  );
}

export default function LinksTab() {
  return (
    <div className="space-y-8" data-testid="operator-links-tab">
      <header className="flex items-start gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-tbc-500/15 text-tbc-300">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-lg font-bold text-tbc-100">Links</h2>
          <p className="text-sm text-tbc-200/60">
            Quick shortcuts to every service this app is connected to. Opens in a new tab.
          </p>
        </div>
      </header>

      {GROUPS.map((group) => (
        <section key={group.title}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-tbc-300">{group.title}</h3>
            <p className="text-xs text-tbc-200/50">{group.blurb}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.links.map((l) => (
              <LinkCard key={l.label} {...l} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
