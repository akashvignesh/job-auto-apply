import { useState } from 'preact/hooks';
import { formatMarkdown } from '../utils/format';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const onClick = (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch { /* ignore */ }
  };
  return (
    <button class={`copy-btn ${copied ? 'copied' : ''}`} onClick={onClick} title={copied ? 'Copied' : 'Copy message'} aria-label="Copy message">
      {copied ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      )}
    </button>
  );
}

export function Message({ message }) {
  const { type, text, images } = message;

  if (type === 'thinking') {
    return (
      <div class="message thinking">
        <div class="thinking-indicator">
          <div class="sparkle-container">
            <svg class="sparkle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <span>Thinking...</span>
        </div>
      </div>
    );
  }

  if (type === 'streaming') {
    return (
      <div class="message assistant streaming" aria-live="polite" aria-atomic="false">
        <div class="bullet" />
        <div
          class="content"
          dangerouslySetInnerHTML={{ __html: formatMarkdown(text) }}
        />
      </div>
    );
  }

  if (type === 'user') {
    return (
      <div class="message user">
        {images && images.length > 0 && (
          <div class="message-images">
            {images.map((img, i) => (
              <img key={i} src={img} alt={`Attached ${i + 1}`} />
            ))}
          </div>
        )}
        {text && <span>{text}</span>}
      </div>
    );
  }

  if (type === 'assistant') {
    return (
      <div class="message assistant">
        <div class="bullet" />
        <div
          class="content"
          dangerouslySetInnerHTML={{ __html: formatMarkdown(text) }}
        />
        {text && <CopyButton text={text} />}
      </div>
    );
  }

  if (type === 'error') {
    return (
      <div class="message error">
        {text}
      </div>
    );
  }

  if (type === 'system') {
    return (
      <div class="message system">
        {text}
      </div>
    );
  }

  return null;
}
