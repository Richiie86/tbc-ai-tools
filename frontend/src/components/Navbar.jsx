import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Button } from './ui/button';
import { useAuth } from '../context/AuthContext';
import { LayoutDashboard, LogOut, ShieldCheck, Sparkles, Bot } from 'lucide-react';
import Logo from './Logo';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from './ui/dropdown-menu';

export default function Navbar({ minimal = false }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const isActive = (p) => loc.pathname === p;

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800/80 bg-ink-950/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-ink-950 ring-1 ring-tbc-500/30 shadow-lg shadow-tbc-500/20">
            <img src="/brand/logo.jpg" alt="TBC AI Control" className="h-full w-full object-cover" draggable={false} />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-bold tracking-tight text-white">TBC AI Control</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-tbc-400/80">TradeBridge Club</div>
          </div>
        </Link>

        {!minimal && (
          <nav className="hidden items-center gap-1 md:flex">
            {[
              { to: '/', label: 'Home' },
              { to: '/about', label: 'About' },
              { to: '/pricing', label: 'Pricing' },
              { to: '/contact', label: 'Contact' },
            ].map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`rounded-md px-3.5 py-2 text-sm font-medium transition-colors ${
                  isActive(item.to)
                    ? 'text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        )}

        <div className="flex items-center gap-2">
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800 transition-colors">
                  <div className="grid h-6 w-6 place-items-center rounded-full bg-tbc-500/20 text-tbc-300 text-[11px] font-bold">
                    {(user.name?.[0] || user.email[0]).toUpperCase()}
                  </div>
                  <span className="hidden sm:inline">{user.name || user.email.split('@')[0]}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 border-slate-800 bg-slate-900 text-slate-100">
                <DropdownMenuLabel className="flex flex-col">
                  <span className="text-xs text-slate-400">Signed in as</span>
                  <span className="truncate text-sm">{user.email}</span>
                  <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-tbc-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-tbc-300">
                    <Sparkles className="h-3 w-3" /> {user.plan} plan
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-slate-800" />
                <DropdownMenuItem onClick={() => navigate('/dashboard')} className="focus:bg-slate-800 cursor-pointer">
                  <LayoutDashboard className="mr-2 h-4 w-4" /> TBC1 Dashboard
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/tbc2')} className="focus:bg-slate-800 cursor-pointer">
                  <Bot className="mr-2 h-4 w-4 text-tbc-400" /> TBC2 Dashboard
                </DropdownMenuItem>
                {user.role === 'operator' && (
                  <DropdownMenuItem onClick={() => navigate('/operator')} className="focus:bg-slate-800 cursor-pointer">
                    <ShieldCheck className="mr-2 h-4 w-4 text-tbc-400" /> Operator Console
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => navigate('/pricing')} className="focus:bg-slate-800 cursor-pointer">
                  <Sparkles className="mr-2 h-4 w-4" /> Upgrade
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-slate-800" />
                <DropdownMenuItem onClick={() => { logout(); navigate('/'); }} className="focus:bg-slate-800 cursor-pointer">
                  <LogOut className="mr-2 h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Link to="/login">
                <Button variant="ghost" className="text-slate-300 hover:bg-slate-800 hover:text-white">Sign in</Button>
              </Link>
              <Link to="/register">
                <Button className="bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold">Get started</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
