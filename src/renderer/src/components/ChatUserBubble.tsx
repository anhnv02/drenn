import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../shared/Markdown';
import { Codicon } from './Codicon';
import type { TranscriptBlock } from '../../../shared/types';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="#4ade80" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
    </svg>
  );
}

export function ChatUserBubble({ blocks }: { readonly blocks: TranscriptBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || expanded) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [blocks, expanded]);

  return (
    <div className="chat-bubble">
      <div ref={contentRef} className={`chat-bubble-content ${expanded ? '' : 'collapsed'}`}>
        {blocks.map((block, i) => {
          if (block.kind === 'image') {
            return <img key={i} className="chat-bubble-image" src={block.content} alt="attached" />;
          }
          if (block.kind === 'file') {
            return (
              <div key={i} className="chat-bubble-file">
                <span className="codicon codicon-file" style={{ fontSize: 12 }} />
                <span>{block.content}</span>
              </div>
            );
          }
          return <Markdown key={i} text={block.content} />;
        })}
      </div>
      <div
        style={{ display: 'flex', alignItems: 'center', marginTop: 15, justifyContent: 'flex-end' }}
      >
        {(overflowing || expanded) && (
          <button className="chat-bubble-toggle" onClick={() => setExpanded((v) => !v)}>
            <Codicon
              name="chevron-right"
              size={11}
              className={`chat-bubble-toggle-icon${expanded ? ' expanded' : ''}`}
            />
            {expanded ? 'show less' : 'more'}
          </button>
        )}
        <button
          title="Copy question"
          className="btn-copy-question"
          aria-label="Copy question"
          onClick={() => {
            const text = blocks
              .filter((b) => b.kind !== 'image' && b.kind !== 'file')
              .map((b) => b.content)
              .join('\n\n');
            navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  );
}
