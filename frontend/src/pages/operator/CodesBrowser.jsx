import React, { useEffect, useState } from 'react';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';
import { ScrollArea } from '../../components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Loader2, FileCode, Folder, FolderOpen,
  ChevronDown, ChevronRight, Copy, Check, Download,
} from 'lucide-react';

function flattenTree(nodes, depth, expanded, acc) {
  for (const n of nodes) {
    acc.push({ ...n, depth });
    if (n.type === 'dir' && expanded.has(n.path) && n.children) {
      flattenTree(n.children, depth + 1, expanded, acc);
    }
  }
  return acc;
}

function CodeTree({ tree, expanded, toggle, onFile, selected }) {
  const flat = [];
  flattenTree(tree, 0, expanded, flat);
  return (
    <div>
      {flat.map((n) => {
        const padding = { paddingLeft: 6 + n.depth * 14 };
        if (n.type === 'dir') {
          const isOpen = expanded.has(n.path);
          return (
            <button
              key={n.path} onClick={() => toggle(n.path)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-tbc-200 hover:bg-ink-900/80"
              style={padding}
            >
              {isOpen ? <ChevronDown className="h-3 w-3 text-tbc-400" /> : <ChevronRight className="h-3 w-3 text-tbc-400" />}
              {isOpen ? <FolderOpen className="h-3.5 w-3.5 text-tbc-300" /> : <Folder className="h-3.5 w-3.5 text-tbc-400" />}
              <span className="truncate">{n.name}</span>
            </button>
          );
        }
        const isSelected = selected === n.path;
        return (
          <button
            key={n.path} onClick={() => onFile(n.path)}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-ink-900/80 ${
              isSelected ? 'bg-tbc-500/15 text-tbc-200' : 'text-tbc-200/80'
            }`}
            style={padding}
          >
            <span className="w-3" />
            <FileCode className="h-3.5 w-3.5 shrink-0 text-tbc-200/60" />
            <span className="truncate">{n.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Two-pane source-code browser used by the Operator → Codes tab. */
export default function CodesBrowser() {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [expanded, setExpanded] = useState(
    new Set(['/app/backend', '/app/frontend/src']),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/operator/codes/tree')
      .then((r) => setTree(r.data))
      .catch(() => toast.error('Failed to load file tree'))
      .finally(() => setLoading(false));
  }, []);

  const openFile = async (path) => {
    setSelected(path);
    setContentLoading(true);
    try {
      const { data } = await api.get('/operator/codes/file', { params: { path } });
      setContent(data.content);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to read file');
      setContent('');
    } finally {
      setContentLoading(false);
    }
  };

  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const copyContent = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadFile = () => {
    if (!selected) return;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selected.split('/').pop();
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <div className="border-b border-tbc-900/60 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-tbc-300">
          Source files
        </div>
        <ScrollArea className="h-[640px] p-2">
          <CodeTree
            tree={tree} expanded={expanded} toggle={toggle}
            onFile={openFile} selected={selected}
          />
        </ScrollArea>
      </div>
      <div className="rounded-xl border border-tbc-900/60 bg-ink-900/40">
        <div className="flex items-center justify-between border-b border-tbc-900/60 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <FileCode className="h-3.5 w-3.5 text-tbc-300" />
            <span className="font-mono text-tbc-200">
              {selected ? selected.replace('/app/', '') : 'Select a file'}
            </span>
          </div>
          {selected && (
            <div className="flex items-center gap-1">
              <Button
                size="sm" variant="outline"
                className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
                onClick={copyContent}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-tbc-300" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button
                size="sm" variant="outline"
                className="border-tbc-900/60 bg-ink-900 text-tbc-100 hover:bg-ink-950"
                onClick={downloadFile}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
        <div className="relative h-[640px] overflow-auto">
          {contentLoading ? (
            <div className="grid h-full place-items-center">
              <Loader2 className="h-6 w-6 animate-spin text-tbc-400" />
            </div>
          ) : selected ? (
            <pre className="m-0 p-4 text-xs leading-relaxed text-tbc-100"><code>{content}</code></pre>
          ) : (
            <div className="grid h-full place-items-center text-sm text-tbc-200/40">
              Pick a file on the left to view its source code
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
