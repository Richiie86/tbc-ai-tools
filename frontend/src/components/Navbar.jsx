import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Button } from './ui/button';
import { useAuth } from '../context/AuthContext';
import { Cpu, LayoutDashboard, LogOut, ShieldCheck, Sparkles } from 'lucide-react';
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
    <header className="sticky top-0 z-40 w-full border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="relative grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-lg shadow-emerald-500/30">
            <Cpu className="h-5 w-5 text-slate-950" strokeWidth={2.4} />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-bold tracking-tight text-white">TBC AI Control</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-400/80">TradeBridge Club</div>
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
                  <div className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500/20 text-emerald-300 text-[11px] font-bold">
                    {(user.name?.[0] || user.email[0]).toUpperCase()}
                  </div>
                  <span className="hidden sm:inline">{user.name || user.email.split('@')[0]}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 border-slate-800 bg-slate-900 text-slate-100">
                <DropdownMenuLabel className="flex flex-col">
                  <span className="text-xs text-slate-400">Signed in as</span>
                  <span className="truncate text-sm">{user.email}</span>
                  <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                    <Sparkles className="h-3 w-3" /> {user.plan} plan
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-slate-800" />
                <DropdownMenuItem onClick={() => navigate('/dashboard')} className="focus:bg-slate-800 cursor-pointer">
                  <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
                </DropdownMenuItem>
                {user.role === 'operator' && (
                  <DropdownMenuItem onClick={() => navigate('/operator')} className="focus:bg-slate-800 cursor-pointer">
                    <ShieldCheck className="mr-2 h-4 w-4 text-emerald-400" /> Operator Console
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
                <Button className="bg-emerald-500 text-slate-950 hover:bg-emerald-400 font-semibold">Get started</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
