import React from 'react';
import { Link } from 'react-router-dom';
import { Github, Twitter, Linkedin } from 'lucide-react';
import Logo from './Logo';
import StatusPill from './StatusPill';

export default function Footer() {
  return (
    <footer className="border-t border-slate-800/80 bg-ink-950 py-12">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 md:grid-cols-4">
        <div>
          <Link to="/" className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-ink-950 ring-1 ring-tbc-500/30">
              <img src="/brand/logo.jpg" alt="TBC AI Tools" className="h-full w-full object-cover" draggable={false} />
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-bold text-white">TBC AI Tools</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-tbc-400/80">TradeBridge Club</div>
            </div>
          </Link>
          <p className="mt-4 max-w-xs text-sm text-slate-400">
            The AI engineer in your pocket. Design, build, and ship full-stack applications
            with a single conversation.
          </p>
        </div>

        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Product</div>
          <ul className="space-y-2 text-sm">
            <li><Link to="/pricing" className="text-slate-300 hover:text-tbc-300">Pricing</Link></li>
            <li><Link to="/about" className="text-slate-300 hover:text-tbc-300">About</Link></li>
            <li><Link to="/dashboard" className="text-slate-300 hover:text-tbc-300">Dashboard</Link></li>
          </ul>
        </div>

        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Company</div>
          <ul className="space-y-2 text-sm">
            <li><Link to="/contact" className="text-slate-300 hover:text-tbc-300">Contact</Link></li>
            <li><Link to="/changelog" className="text-slate-300 hover:text-tbc-300">Changelog</Link></li>
            <li><Link to="/status" className="text-slate-300 hover:text-tbc-300">Status</Link></li>
            <li><a href="#" className="text-slate-300 hover:text-tbc-300">Privacy</a></li>
            <li><a href="#" className="text-slate-300 hover:text-tbc-300">Terms</a></li>
          </ul>
        </div>

        <div>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Follow</div>
          <div className="flex items-center gap-3">
            <a href="#" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-800 text-slate-300 hover:border-tbc-500/50 hover:text-tbc-300"><Twitter className="h-4 w-4" /></a>
            <a href="#" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-800 text-slate-300 hover:border-tbc-500/50 hover:text-tbc-300"><Github className="h-4 w-4" /></a>
            <a href="#" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-800 text-slate-300 hover:border-tbc-500/50 hover:text-tbc-300"><Linkedin className="h-4 w-4" /></a>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-7xl border-t border-slate-800/60 px-5 pt-6 text-xs text-slate-500 flex flex-col sm:flex-row justify-between gap-3">
        <div className="flex items-center gap-3">
          <span>© {new Date().getFullYear()} TradeBridge Club. All rights reserved.</span>
          <StatusPill />
        </div>
        <div className="flex items-center gap-3">
          <span>tbctools.org</span>
          <span className="text-slate-700">·</span>
          <a
            href="https://emergent.sh"
            target="_blank"
            rel="noreferrer"
            className="text-slate-600 hover:text-tbc-400/80 transition-colors"
            data-testid="footer-emergent-credit"
          >
            Powered by Emergent
          </a>
        </div>
      </div>
    </footer>
  );
}
