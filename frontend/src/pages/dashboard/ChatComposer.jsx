import React from 'react';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Send, Loader2 } from 'lucide-react';

/** Bottom composer (textarea + Send button) of the chat. Enter sends, Shift+Enter newlines. */
export function ChatComposer({ input, setInput, streaming, onSend, taRef }) {
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };
  return (
    <div className="border-t border-slate-800 bg-ink-950/80 px-5 py-4 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 focus-within:border-tbc-500/60">
          <Textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask TBC AI Tools anything… (Shift+Enter for newline)"
            className="min-h-[44px] max-h-40 resize-none border-0 bg-transparent text-[15px] text-slate-100 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Button
            onClick={onSend}
            disabled={streaming || !input.trim()}
            className="h-10 shrink-0 bg-tbc-500 px-4 text-slate-950 hover:bg-tbc-400 font-semibold"
          >
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <div className="mt-2 text-center text-[11px] text-slate-500">
          TBC AI Tools may produce inaccurate information. Verify critical output.
        </div>
      </div>
    </div>
  );
}
