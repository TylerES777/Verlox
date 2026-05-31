import { useEffect, useRef, useState } from 'react';
import type { ModelChoice } from '@shared/types';
import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { Tooltip } from './Tooltip';

interface ModelSwitcherProps {
  value: ModelChoice;
  onChange: (value: ModelChoice) => void;
  // Locks the switcher while the AI is mid-turn — the model can't change
  // under a turn already in flight (it was captured at submit time).
  disabled: boolean;
}

interface ModelMeta {
  id: ModelChoice;
  label: string;
  blurb: string;
  // Per-turn credit weight, shown so the cost trade-off is legible at the
  // point of choice. Mirrors the backend env weights (Haiku 1 / Sonnet 4 /
  // Opus 6); display-only.
  credits: number;
  // Pro-only models are locked for free users (lock glyph + Go Pro wall).
  pro: boolean;
}

const MODELS: ModelMeta[] = [
  { id: 'haiku', label: 'Haiku', blurb: 'Fast, everyday answers', credits: 1, pro: false },
  { id: 'sonnet', label: 'Sonnet', blurb: 'Balanced depth and speed', credits: 4, pro: true },
  { id: 'opus', label: 'Opus', blurb: 'Most capable, deepest reasoning', credits: 6, pro: true },
];

// Input-bar control for the session-wide model selection. Free users are
// pinned to Haiku server-side; the menu surfaces Sonnet/Opus as locked
// (lock glyph + Go Pro wall on click). Pro users freely pick any of the
// three. The selection persists via useModelChoice in ConversationsShell.
//
// Glass language matches the rest of the input row: tinted frame, white
// inner surface, 1px top-edge highlight, gold lit-pip for the premium
// (Pro) accent on locked rows.
export function ModelSwitcher({ value, onChange, disabled }: ModelSwitcherProps) {
  const { isPro } = useTier();
  const { openUpgrade } = useUpgrade();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // A free user with a stale 'sonnet'/'opus' choice is served Haiku
  // server-side; reflect that in the trigger so the label never lies.
  const effective = MODELS.find((m) => m.id === value) ?? MODELS[1];
  const shown = !isPro && effective.pro ? MODELS[0] : effective;

  // Close on click-outside / Escape while open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleSelect(model: ModelMeta) {
    // Locked for free users — route to the upgrade path instead of
    // selecting. The menu stays a calm one-click step from going Pro.
    if (model.pro && !isPro) {
      openUpgrade({ feature: `${model.label} model` });
      setOpen(false);
      return;
    }
    onChange(model.id);
    setOpen(false);
  }

  const frameStyle: React.CSSProperties = {
    background:
      'linear-gradient(180deg, rgba(245,246,249,0.96) 0%, rgba(238,240,245,0.95) 100%)',
    backdropFilter: 'blur(14px) saturate(140%)',
    WebkitBackdropFilter: 'blur(14px) saturate(140%)',
    boxShadow:
      '0 1px 0 rgba(255,255,255,0.7) inset, 0 0 0 0.5px rgba(0,0,0,0.05), 0 14px 34px -14px rgba(20,30,60,0.32)',
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      {open && (
        <div
          className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-64 overflow-hidden rounded-2xl border border-subtle-border"
          style={frameStyle}
          role="listbox"
          aria-label="Model"
        >
          {/* Top-edge highlight — same treatment as the rest of the app. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/85 to-transparent"
            aria-hidden="true"
          />
          <div className="m-1.5 rounded-xl border border-subtle-border/70 bg-white p-1">
            {MODELS.map((model) => {
              const locked = model.pro && !isPro;
              const active = model.id === shown.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => handleSelect(model)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus:outline-none ${
                    active ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.035]'
                  }`}
                >
                  {/* Leading mark — checkmark for the active model, gold
                      lit-pip for a locked premium model, else a spacer so
                      labels align. */}
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {active ? (
                      <CheckGlyph />
                    ) : locked ? (
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{
                          background:
                            'linear-gradient(135deg, #F2D283 0%, #C8962E 100%)',
                          boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.5)',
                        }}
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-ink">
                        {model.label}
                      </span>
                      {locked && <LockGlyph />}
                    </span>
                    <span className="block truncate text-[11px] text-ink-hint">
                      {model.blurb}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10.5px] font-medium tabular-nums text-ink-micro">
                    {model.credits} cr
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Tooltip label={`Model: ${shown.label}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Model: ${shown.label}`}
          className={`flex h-12 items-center gap-1.5 rounded-xl border-[0.5px] px-3 text-[12.5px] font-medium transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
            open
              ? 'border-input-border bg-surface-subtle text-ink'
              : 'border-subtle-border bg-surface-subtle text-ink-label hover:text-ink'
          }`}
        >
          <SparkGlyph />
          <span>{shown.label}</span>
          <ChevronGlyph open={open} />
        </button>
      </Tooltip>
    </div>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3 text-ink"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="2.5,6.5 5,9 9.5,3.5" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5 text-ink-micro"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
    </svg>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3,4.5 6,7.5 9,4.5" />
    </svg>
  );
}

function SparkGlyph() {
  // Small 4-point star — the same premium accent glyph used on the
  // limit notification's Go Pro pill, tying the model control to the
  // upgrade language.
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    </svg>
  );
}
