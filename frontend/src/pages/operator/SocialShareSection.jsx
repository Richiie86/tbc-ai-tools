import React, { useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Share2, Facebook, Youtube, Instagram, Music2, Camera, Upload,
  Download, Copy, Loader2, Send, ExternalLink,
} from 'lucide-react';

// Direct account posting needs each platform's approved developer app + OAuth
// (see the Social Accounts tab). Until an account is linked, these buttons open
// the platform's own composer/upload page with your caption ready to paste —
// which works today with zero approvals.
const PLATFORMS = [
  {
    id: 'facebook', label: 'Facebook', icon: Facebook,
    color: 'text-[#1877F2]',
    // Facebook has a real web share dialog for a URL.
    share: ({ url }) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url || window.location.origin)}`,
    note: 'Opens Facebook’s share dialog for your link.',
  },
  {
    id: 'youtube', label: 'YouTube', icon: Youtube,
    color: 'text-[#FF0000]',
    share: () => 'https://studio.youtube.com/channel/upload',
    note: 'Opens YouTube Studio upload — paste your caption & attach the media.',
  },
  {
    id: 'instagram', label: 'Instagram', icon: Instagram,
    color: 'text-[#E4405F]',
    share: () => 'https://www.instagram.com/',
    note: 'Opens Instagram — download the screenshot, then upload with your caption.',
  },
  {
    id: 'tiktok', label: 'TikTok', icon: Music2,
    color: 'text-tbc-100',
    share: () => 'https://www.tiktok.com/upload',
    note: 'Opens TikTok upload — download the screenshot, then upload with your caption.',
  },
];

export default function SocialShareSection() {
  const [caption, setCaption] = useState('');
  const [url, setUrl] = useState(typeof window !== 'undefined' ? window.location.origin : '');
  const [shot, setShot] = useState(null);        // { dataUrl, blob }
  const [capturing, setCapturing] = useState(false);
  const fileRef = useRef(null);

  const captureScreen = async () => {
    setCapturing(true);
    try {
      const canvas = await html2canvas(document.body, {
        backgroundColor: '#0a0a0a',
        logging: false,
        useCORS: true,
        scale: window.devicePixelRatio > 1 ? 2 : 1,
      });
      const dataUrl = canvas.toDataURL('image/png');
      canvas.toBlob((blob) => setShot({ dataUrl, blob }), 'image/png');
      setShot((s) => ({ ...(s || {}), dataUrl }));
      toast.success('Screenshot captured.');
    } catch {
      toast.error('Could not capture the screen. Try uploading an image instead.');
    } finally {
      setCapturing(false);
    }
  };

  const onUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setShot({ dataUrl: reader.result, blob: file });
    reader.readAsDataURL(file);
  };

  const download = () => {
    if (!shot?.dataUrl) return;
    const a = document.createElement('a');
    a.href = shot.dataUrl;
    a.download = `tbc-share-${Date.now()}.png`;
    a.click();
  };

  const copyCaption = async () => {
    const text = [caption, url].filter(Boolean).join('\n\n');
    if (!text) { toast.error('Write a caption first.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Caption copied — paste it into the app.');
    } catch {
      toast.error('Could not copy.');
    }
  };

  // Native share sheet (mobile) — the ONLY way to push an image straight into
  // the Instagram / TikTok apps without an approved API integration.
  const nativeShare = async () => {
    const text = [caption, url].filter(Boolean).join('\n\n');
    try {
      if (shot?.blob && navigator.canShare?.({ files: [new File([shot.blob], 'share.png', { type: 'image/png' })] })) {
        await navigator.share({
          text,
          files: [new File([shot.blob], 'share.png', { type: 'image/png' })],
        });
        return;
      }
      if (navigator.share) {
        await navigator.share({ text, url: url || undefined });
        return;
      }
      toast.info('Your browser has no share sheet — use a platform button below.');
    } catch {
      /* user cancelled — ignore */
    }
  };

  const openPlatform = async (p) => {
    // Put the caption on the clipboard so it's ready to paste after the tab opens.
    if (caption) {
      try { await navigator.clipboard.writeText([caption, url].filter(Boolean).join('\n\n')); } catch { /* noop */ }
    }
    window.open(p.share({ url }), '_blank', 'noopener,noreferrer');
    toast.success(`${p.label} opened — caption copied, ready to paste.`);
  };

  return (
    <div className="space-y-4" data-testid="social-share-section">
      <div>
        <h3 className="flex items-center gap-2 text-base font-bold text-tbc-100">
          <Share2 className="h-4 w-4 text-tbc-300" /> Share to social media
        </h3>
        <p className="mt-1 text-sm text-tbc-200/60">
          Capture a screenshot of the preview (or upload one), write a caption, and push it to Facebook, YouTube,
          Instagram or TikTok. Once you link an account in the <span className="font-semibold text-tbc-100">Social Accounts</span> tab,
          posting becomes fully automatic.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Composer */}
        <div className="space-y-3 rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Caption</label>
            <Textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)}
              className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
              placeholder="Meet TBC AI — your all-in-one AI toolset. Try it free today!" />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Link</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)}
              className="mt-1.5 bg-ink-950 border-tbc-900/60 text-tbc-100"
              placeholder="https://tbctools.org" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={captureScreen} disabled={capturing}
              className="bg-tbc-500 font-semibold text-ink-950 hover:bg-tbc-400">
              {capturing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Camera className="mr-1.5 h-4 w-4" />}
              Capture screenshot
            </Button>
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}
              className="border-tbc-900/60 text-tbc-100 hover:bg-ink-800">
              <Upload className="mr-1.5 h-4 w-4" /> Upload image
            </Button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onUpload} />
            <Button type="button" variant="outline" onClick={copyCaption}
              className="border-tbc-900/60 text-tbc-100 hover:bg-ink-800">
              <Copy className="mr-1.5 h-4 w-4" /> Copy caption
            </Button>
          </div>
        </div>

        {/* Preview + share */}
        <div className="space-y-3 rounded-xl border border-tbc-900/60 bg-ink-900 p-4">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-tbc-200/60">Preview</label>
          <div className="grid min-h-[140px] place-items-center overflow-hidden rounded-lg border border-tbc-900/60 bg-ink-950">
            {shot?.dataUrl
              ? <img src={shot.dataUrl} alt="Share preview" className="max-h-64 w-full object-contain" />
              : <span className="p-6 text-center text-xs text-tbc-200/40">No image yet — capture a screenshot or upload one.</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={nativeShare}
              className="bg-emerald-500 font-semibold text-ink-950 hover:bg-emerald-400">
              <Send className="mr-1.5 h-4 w-4" /> Share via device
            </Button>
            {shot?.dataUrl && (
              <Button type="button" variant="outline" onClick={download}
                className="border-tbc-900/60 text-tbc-100 hover:bg-ink-800">
                <Download className="mr-1.5 h-4 w-4" /> Download
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Platform buttons */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PLATFORMS.map((p) => (
          <button key={p.id} type="button" onClick={() => openPlatform(p)}
            data-testid={`share-${p.id}`}
            className="flex flex-col items-start gap-2 rounded-xl border border-tbc-900/60 bg-ink-900 p-4 text-left transition hover:border-tbc-500/40 hover:bg-ink-800">
            <div className="flex w-full items-center justify-between">
              <p.icon className={`h-6 w-6 ${p.color}`} />
              <ExternalLink className="h-3.5 w-3.5 text-tbc-200/30" />
            </div>
            <span className="font-semibold text-tbc-100">{p.label}</span>
            <span className="text-[11px] leading-snug text-tbc-200/50">{p.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
