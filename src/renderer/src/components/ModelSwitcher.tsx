import { useEffect, useRef, useState } from 'react';
import type { ModelChoice } from '@shared/types';
import { useTier } from '../contexts/TierContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { Tooltip } from './Tooltip';
import iconAnthropic from '../assets/providers/anthropic.png';
import iconOpenAI from '../assets/providers/openai.png';
import iconGoogle from '../assets/providers/google.png';
import iconMeta from '../assets/providers/meta.png';
import iconGrok from '../assets/providers/grok.png';
import iconDeepSeek from '../assets/providers/deepseek.png';
import iconQwen from '../assets/providers/qwen.png';

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
  // point of choice. Mirrors the backend env weights; display-only.
  credits: number;
  // Pro-only models are locked for free users (lock glyph + Go Pro wall).
  pro: boolean;
  // Which lab makes it — drives the logo on the row and the trigger.
  icon: string;
}

// The full hosted lineup, same order as the terminal's model picker:
// free models first, Pro models after. Kept in sync with the backend
// registry (tier.ts) and AgentPanel's buildBrains.
const MODELS: ModelMeta[] = [
  { id: 'haiku', label: 'Haiku', blurb: 'Fast, everyday answers', credits: 1, pro: false, icon: iconAnthropic },
  { id: 'gpt-mini', label: 'GPT-4o mini', blurb: 'Quick and light', credits: 1, pro: false, icon: iconOpenAI },
  { id: 'gpt', label: 'GPT-4o', blurb: 'OpenAI all-rounder', credits: 4, pro: false, icon: iconOpenAI },
  { id: 'gemini-flash', label: 'Gemini Flash', blurb: 'Fast Google model', credits: 1, pro: false, icon: iconGoogle },
  { id: 'grok', label: 'Grok 4.3', blurb: 'xAI, up to date', credits: 4, pro: false, icon: iconGrok },
  { id: 'llama', label: 'Llama 3.3 70B', blurb: 'Open weights, solid', credits: 1, pro: false, icon: iconMeta },
  { id: 'deepseek', label: 'DeepSeek V3', blurb: 'Strong and cheap', credits: 1, pro: false, icon: iconDeepSeek },
  { id: 'qwen', label: 'Qwen 2.5 72B', blurb: 'Capable open model', credits: 1, pro: false, icon: iconQwen },
  { id: 'sonnet', label: 'Sonnet', blurb: 'Balanced depth and speed', credits: 4, pro: true, icon: iconAnthropic },
  { id: 'opus', label: 'Opus', blurb: 'Most capable, deepest reasoning', credits: 6, pro: true, icon: iconAnthropic },
  { id: 'gpt-reasoning', label: 'o3 (reasoning)', blurb: 'Thinks before answering', credits: 8, pro: true, icon: iconOpenAI },
  { id: 'gemini', label: 'Gemini 2.5 Pro', blurb: 'Google flagship', credits: 4, pro: true, icon: iconGoogle },
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
          <div className="picker-scroll m-1.5 max-h-[340px] overflow-y-auto rounded-xl border border-subtle-border/70 bg-white p-1">
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
                  <img
                    src={model.icon}
                    alt=""
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 object-contain opacity-80"
                  />
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
          <img
            src={shown.icon}
            alt=""
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 object-contain opacity-80"
          />
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

