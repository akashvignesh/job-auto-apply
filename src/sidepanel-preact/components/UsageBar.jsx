import { useMemo, useState } from 'preact/hooks';

/**
 * Compact one-line token / call meter rendered between the header and the
 * messages list. Shows the running task's totals; hover for session totals
 * and a per-bucket breakdown.
 *
 * Layout (right-aligned, monospaced numerals):
 *   14 calls · in 12.3K (4.2K cached · 65%) · out 1.8K · $0.04
 */

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Render a count as 12.3K / 1.2M etc., or the raw number when small. */
function fmtTokens(n) {
  if (n == null || n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return NUMBER_FORMAT.format(n / 1000) + 'K';
  return NUMBER_FORMAT.format(n / 1_000_000) + 'M';
}

function fmtCost(usd) {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return '$' + usd.toFixed(2);
  return '$' + usd.toFixed(2);
}

// Per-1M-token pricing in USD. Conservative defaults — pricing always varies
// by provider; the UI tag this as "est." so users don't read it as billing.
const PRICING = {
  'claude-opus-4-7':       { in: 15,  out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6':     { in: 3,   out: 15, cacheRead: 0.3, cacheWrite: 3.75  },
  'claude-haiku-4-5':      { in: 1,   out: 5,  cacheRead: 0.1, cacheWrite: 1.25  },
  'claude-opus-4-5-20250514':   { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-20250514':   { in: 3,  out: 15, cacheRead: 0.3, cacheWrite: 3.75  },
  'claude-haiku-4-20250414':    { in: 1,  out: 5,  cacheRead: 0.1, cacheWrite: 1.25  },
  default: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function estimateCost(usage, modelId) {
  if (!usage) return 0;
  const p = PRICING[modelId] || PRICING.default;
  const freshIn = Math.max(0, (usage.inputTokens || 0) - (usage.cacheReadTokens || 0) - (usage.cacheCreationTokens || 0));
  return (
    (freshIn / 1_000_000) * p.in +
    ((usage.outputTokens || 0) / 1_000_000) * p.out +
    ((usage.cacheReadTokens || 0) / 1_000_000) * p.cacheRead +
    ((usage.cacheCreationTokens || 0) / 1_000_000) * p.cacheWrite
  );
}

export function UsageBar({ taskUsage, sessionUsage, isRunning, modelId }) {
  const [showSession, setShowSession] = useState(false);
  const active = showSession ? sessionUsage : taskUsage;

  const cacheHitRate = useMemo(() => {
    const denom = (active.inputTokens || 0);
    if (denom === 0) return 0;
    return ((active.cacheReadTokens || 0) / denom) * 100;
  }, [active]);

  const cost = useMemo(() => estimateCost(active, modelId), [active, modelId]);

  // Hide entirely when nothing has happened yet — first-load chrome should
  // stay quiet until a meter is meaningful.
  const isEmpty = !active || (active.apiCalls === 0 && active.inputTokens === 0 && active.outputTokens === 0);
  if (isEmpty && !isRunning) return null;

  const tip = showSession
    ? 'Showing session totals (all tasks since panel opened). Click to switch.'
    : 'Showing current task totals. Click to switch to session totals.';

  return (
    <div class="usage-bar" role="status" aria-live="polite" title={tip}>
      <button
        type="button"
        class={`usage-toggle ${showSession ? 'session' : 'task'}`}
        onClick={() => setShowSession((s) => !s)}
        aria-pressed={showSession}
      >
        {showSession ? 'session' : 'task'}
      </button>
      <span class={`usage-chip ${isRunning && !showSession ? 'live' : ''}`}>
        <span class="usage-num">{active.apiCalls || 0}</span>
        <span class="usage-label">calls</span>
      </span>
      <span class="usage-chip">
        <span class="usage-label">in</span>
        <span class="usage-num">{fmtTokens(active.inputTokens)}</span>
        {(active.cacheReadTokens || 0) > 0 && (
          <span class="usage-sub" title={`${fmtTokens(active.cacheReadTokens)} cache reads — billed at ~10% of fresh input`}>
            <span class="usage-cache">{fmtTokens(active.cacheReadTokens)}</span>
            <span class="usage-cache-pct">{Math.round(cacheHitRate)}%</span>
          </span>
        )}
      </span>
      <span class="usage-chip">
        <span class="usage-label">out</span>
        <span class="usage-num">{fmtTokens(active.outputTokens)}</span>
      </span>
      <span class="usage-chip usage-cost" title="Estimated provider cost. Always $0 on Claude OAuth (subscription).">
        <span class="usage-num">{fmtCost(cost)}</span>
        <span class="usage-label">est</span>
      </span>
    </div>
  );
}
