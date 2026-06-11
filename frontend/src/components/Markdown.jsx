import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Markdown({ children }) {
  return (
    <div className="markdown-body text-[15px] text-slate-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ''}</ReactMarkdown>
    </div>
  );
}
