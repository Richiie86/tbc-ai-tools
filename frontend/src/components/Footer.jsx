import React from 'react';
import { Link } from 'react-router-dom';
import { Cpu, Github, Twitter, Linkedin } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t border-slate-800/80 bg-ink-950 py-12">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 md:grid-cols-4">
        <div>
          <Link to="/" className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-tbc-300 to-tbc-500">
              <Cpu className="h-5 w-5 text-slate-950" strokeWidth={2.4} />
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-bold text-white">TBC AI Control</div>
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
      <div className="mx-auto mt-10 max-w-7xl border-t border-slate-800/60 px-5 pt-6 text-xs text-slate-500 flex flex-col sm:flex-row justify-between gap-2">
        <div>© {new Date().getFullYear()} TradeBridge Club. All rights reserved.</div>
        <div>Built with TBC AI Control • tbctools.org</div>
      </div>
    </footer>
  );
}
