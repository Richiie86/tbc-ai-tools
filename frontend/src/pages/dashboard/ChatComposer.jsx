import React, { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Send, Loader2, ImagePlus, X } from 'lucide-react';
import { toast } from 'sonner';

// Per-image hard cap. Each provider has token budgets that explode with
// large base64 payloads — keeping each image ≤4MB is a good balance
// between quality and cost.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Per-send cap. The backend also enforces 6 images; this is the UI guard.
const MAX_IMAGES = 6;

/** Bottom composer (textarea + attach + Send button). Enter sends, Shift+Enter newlines.
 *
 * Supports:
 * • Click the image button to pick files
 * • Paste images from clipboard (Ctrl/Cmd+V into the textarea)
 * • Drag-and-drop images onto the composer
 *
 * Selected images render as thumbnails ABOVE the textarea with a per-image
 * remove (×) and they're sent to the backend on the next Send.
 */
export function ChatComposer({ input, setInput, streaming, onSend, taRef }) {
  const fileRef = useRef(null);
  // attachments: [{ id, name, mime, content (base64 without data: prefix), previewUrl }]
  const [attachments, setAttachments] = useState([]);
  const [dragOver, setDragOver] = useState(false);

  const readFile = useCallback((file) => new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(`${file.name}: only images supported here`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 4MB cap`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name}: read failed`));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      // dataUrl is `data:image/png;base64,<b64>` — strip the prefix so the
      // backend gets just the base64 chars.
      const b64 = dataUrl.split(',', 2)[1] || '';
      resolve({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mime: file.type,
        content: b64,
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  }), []);

  const addFiles = useCallback(async (filesList) => {
    const remaining = MAX_IMAGES - attachments.length;
    if (remaining <= 0) {
      toast.error(`Max ${MAX_IMAGES} images per message`);
      return;
    }
    const files = Array.from(filesList || []).slice(0, remaining);
    const ok = [];
    for (const f of files) {
      try {
        const a = await readFile(f);
        ok.push(a);
      } catch (e) {
        toast.error(e.message || 'Image rejected');
      }
    }
    if (ok.length) setAttachments((prev) => [...prev, ...ok]);
  }, [attachments.length, readFile]);

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const onPaste = useCallback((e) => {
    const files = [];
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handleSend = () => {
    if (streaming) return;
    if (!input.trim() && attachments.length === 0) return;
    // Pass the bare-bones server payload — strip previewUrl, that's UI-only.
    onSend(attachments.map(({ name, mime, content }) => ({
      type: 'image', name, mime, content,
    })));
    setAttachments([]);
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className="border-t border-slate-800 bg-ink-950/80 px-5 py-4 backdrop-blur"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="mx-auto max-w-3xl">
        {/* Thumbnail strip — only renders when there are attachments. */}
        {attachments.length > 0 && (
          <div
            data-testid="chat-attachments-strip"
            className="mb-2 flex flex-wrap gap-2"
          >
            {attachments.map((a) => (
              <div
                key={a.id}
                data-testid={`chat-attachment-${a.id}`}
                className="group relative h-16 w-16 overflow-hidden rounded-md border border-slate-700 bg-slate-900"
              >
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  title={a.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  data-testid={`chat-attachment-remove-${a.id}`}
                  className="absolute right-0.5 top-0.5 rounded-full bg-ink-950/90 p-0.5 text-tbc-100 opacity-0 transition group-hover:opacity-100"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={`flex items-end gap-2 rounded-2xl border bg-slate-900 p-2 transition ${
            dragOver
              ? 'border-tbc-500 bg-tbc-500/[0.04]'
              : 'border-slate-700 focus-within:border-tbc-500/60'
          }`}
        >
          {/* Image upload button. Lives left of the textarea so it's the
              first thing the eye reaches when a user wants to add media. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif"
            multiple
            hidden
            data-testid="chat-attach-input"
            onChange={(e) => {
              addFiles(e.target.files);
              // Reset so picking the same file twice still fires onChange.
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            disabled={streaming || attachments.length >= MAX_IMAGES}
            data-testid="chat-attach-btn"
            title={attachments.length >= MAX_IMAGES
              ? `Max ${MAX_IMAGES} images per message`
              : 'Attach images (or paste / drag-and-drop)'}
            className="h-10 w-10 shrink-0 p-0 text-tbc-200 hover:bg-slate-800 hover:text-tbc-100"
          >
            <ImagePlus className="h-5 w-5" />
          </Button>
          <Textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={dragOver
              ? 'Drop images here…'
              : 'Ask TBC AI Tools anything… (Shift+Enter for newline, attach images with the +)'}
            className="min-h-[44px] max-h-40 resize-none border-0 bg-transparent text-[15px] text-slate-100 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Button
            onClick={handleSend}
            disabled={streaming || (!input.trim() && attachments.length === 0)}
            data-testid="chat-send-btn"
            className="h-10 shrink-0 bg-tbc-500 px-4 text-slate-950 hover:bg-tbc-400 font-semibold"
          >
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <div className="mt-2 text-center text-[11px] text-slate-500">
          TBC AI Tools may produce inaccurate information. Verify critical output.
          {attachments.length > 0 && (
            <> · <span className="text-tbc-300">{attachments.length} image{attachments.length > 1 ? 's' : ''} attached</span></>
          )}
        </div>
      </div>
    </div>
  );
}
