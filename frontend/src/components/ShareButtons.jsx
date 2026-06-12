import React from 'react';
import { Facebook, Twitter, Instagram, Youtube, Music2, Link as LinkIcon } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Social share row. By default shares the brand share URL.
 * Pass `url` to share a custom link (e.g., a personal referral link).
 */
export default function ShareButtons({ url = 'https://www.tbctools.org', text = 'I’m using TBC AI Tools to build apps faster. Try it:', compact = false }) {
  const encoded = encodeURIComponent(url);
  const encodedText = encodeURIComponent(text);

  const facebook = `https://www.facebook.com/sharer/sharer.php?u=${encoded}`;
  const twitter  = `https://twitter.com/intent/tweet?url=${encoded}&text=${encodedText}`;
  // Native sharing not supported on the web for these — redirect users to their landing pages
  const instagram = 'https://www.instagram.com/';
  const youtube   = 'https://www.youtube.com/';
  const tiktok    = 'https://www.tiktok.com/';

  const copy = () => {
    navigator.clipboard.writeText(url);
    toast.success('Link copied');
  };

  const items = [
    { name: 'Facebook',   icon: Facebook,  href: facebook,  bg: 'hover:bg-[#1877f2]/20',   color: 'text-[#5b9cff]' },
    { name: 'X / Twitter', icon: Twitter,  href: twitter,   bg: 'hover:bg-white/10',       color: 'text-tbc-100' },
    { name: 'YouTube',    icon: Youtube,   href: youtube,   bg: 'hover:bg-[#ff0000]/20',   color: 'text-[#ff6b6b]' },
    { name: 'Instagram',  icon: Instagram, href: instagram, bg: 'hover:bg-[#e1306c]/20',   color: 'text-[#f47ab2]' },
    { name: 'TikTok',     icon: Music2,    href: tiktok,    bg: 'hover:bg-white/10',       color: 'text-tbc-100' },
  ];

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'mt-3'}`}>
      {items.map((it) => (
        <a
          key={it.name}
          href={it.href}
          target="_blank"
          rel="noreferrer"
          title={`Share on ${it.name}`}
          className={`group inline-flex items-center gap-1.5 rounded-lg border border-tbc-900/60 bg-ink-950 px-3 py-1.5 text-xs text-tbc-200/80 transition-colors ${it.bg}`}
        >
          <it.icon className={`h-3.5 w-3.5 ${it.color}`} />
          <span>{it.name}</span>
        </a>
      ))}
      <button
        onClick={copy}
        title="Copy link"
        className="inline-flex items-center gap-1.5 rounded-lg border border-tbc-500/40 bg-tbc-500/10 px-3 py-1.5 text-xs text-tbc-200 hover:bg-tbc-500/20"
      >
        <LinkIcon className="h-3.5 w-3.5 text-tbc-300" />
        <span>Copy link</span>
      </button>
    </div>
  );
}
