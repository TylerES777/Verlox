import { useEffect, useState, type FormEvent } from 'react';
import type { ProviderFormat, SettingsInfo } from '@shared/types';
import {
  permissionFor,
  PERMISSION_CAPABILITIES,
  type Capability,
  type PermissionRule,
} from '@shared/risk';

// The app's Settings page — a centered modal opened from the gear in the top
// bar. It owns its own settings state (loaded via IPC) and, after any change,
// fires a `verlox:settings-changed` event so the agent panel re-reads its copy
// (provider list, auto-approve, permissions) without prop-drilling.

function defaultBaseUrl(format: ProviderFormat): string {
  return format === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
}
function modelPlaceholder(format: ProviderFormat): string {
  return format === 'anthropic' ? 'e.g. claude-sonnet-4-5' : 'e.g. gpt-4o';
}

function announceChange() {
  window.dispatchEvent(new Event('verlox:settings-changed'));
}

export function SettingsView({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);

  // Add-provider form.
  const [formName, setFormName] = useState('');
  const [formFormat, setFormFormat] = useState<ProviderFormat>('openai');
  const [formUrl, setFormUrl] = useState(defaultBaseUrl('openai'));
  const [formModel, setFormModel] = useState('');
  const [formKey, setFormKey] = useState('');
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  useEffect(() => {
    void window.api.settingsGet().then(setSettings);
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submitProvider = async (e: FormEvent) => {
    e.preventDefault();
    setAddBusy(true);
    setAddMsg('Checking…');
    const res = await window.api.settingsAddProvider({
      name: formName.trim(),
      format: formFormat,
      baseUrl: formUrl.trim(),
      model: formModel.trim(),
      key: formKey.trim(),
    });
    setSettings(res.settings);
    announceChange();
    if (res.ok) {
      setAddMsg('Added.');
      setFormName('');
      setFormModel('');
      setFormKey('');
    } else {
      setAddMsg(res.error ?? 'Could not add it.');
    }
    setAddBusy(false);
  };

  const removeProvider = async (id: string) => {
    const s = await window.api.settingsRemoveProvider(id);
    setSettings(s);
    announceChange();
  };

  const toggleAuto = async () => {
    if (!settings) return;
    const s = await window.api.settingsSetAutoApprove(!settings.autoApproveReadonly);
    setSettings(s);
    announceChange();
  };

  const changePermission = async (capability: Capability, rule: PermissionRule) => {
    const s = await window.api.settingsSetPermission(capability, rule);
    setSettings(s);
    announceChange();
  };

  const hasProviders = (settings?.providers.length ?? 0) > 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 p-6 pt-16"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-hairline bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3" stroke="#3A3A3A" strokeWidth="1.6" />
              <path
                d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
                stroke="#3A3A3A"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            <span className="text-sm font-semibold text-ink">Settings</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-0.5 text-sm text-ink-hint hover:bg-black/5 hover:text-ink"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {/* AI providers */}
          <section>
            <h3 className="text-sm font-semibold text-ink">AI providers</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-hint">
              Add any AI provider with an API key. Its model shows up in the
              chat-bar switcher and is called directly from your computer (no
              Verlox credits). Works with OpenAI, OpenRouter, Groq, local
              models, Anthropic, and more.
            </p>

            {hasProviders && (
              <div className="mt-2 space-y-1">
                {settings?.providers.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border border-black/10 px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-ink">{p.name}</div>
                      <div className="truncate text-[11px] text-ink-hint">{p.model}</div>
                    </div>
                    <button
                      onClick={() => removeProvider(p.id)}
                      className="shrink-0 text-[11px] text-[#B4632F] hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={submitProvider} className="mt-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-ink-hint">
                Add a provider
              </div>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Name (e.g. GPT-4o)"
                className="w-full rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <select
                value={formFormat}
                onChange={(e) => {
                  const f = e.target.value as ProviderFormat;
                  setFormFormat(f);
                  setFormUrl(defaultBaseUrl(f));
                }}
                className="w-full rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-black/20"
              >
                <option value="openai">OpenAI-compatible (most providers)</option>
                <option value="anthropic">Anthropic (Claude)</option>
              </select>
              <input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="Endpoint URL"
                className="w-full rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <input
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder={modelPlaceholder(formFormat)}
                className="w-full rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <input
                type="password"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                placeholder="API key"
                className="w-full rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-black/20"
              />
              <button
                type="submit"
                disabled={addBusy}
                className="w-full rounded-lg bg-[#3A3A3A] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-black disabled:opacity-50"
              >
                {addBusy ? 'Checking…' : 'Add & verify'}
              </button>
              {addMsg && (
                <div
                  className={`break-words text-[11px] ${
                    addMsg === 'Added.' || addMsg === 'Checking…'
                      ? 'text-[#3E7A53]'
                      : 'text-[#B4632F]'
                  }`}
                >
                  {addMsg}
                </div>
              )}
            </form>
          </section>

          {/* Agent behavior */}
          <section className="mt-6 border-t border-hairline pt-4">
            <h3 className="text-sm font-semibold text-ink">Agent behavior</h3>
            <button
              onClick={toggleAuto}
              disabled={!settings}
              className="mt-2 flex w-full items-center justify-between rounded-lg px-1 py-1 text-left hover:bg-black/5 disabled:opacity-50"
            >
              <div className="min-w-0 pr-2">
                <div className="text-xs text-ink">Run read-only steps automatically</div>
                <div className="text-[11px] text-ink-hint">
                  {settings?.autoApproveReadonly
                    ? 'Listing/reading runs without asking'
                    : 'Ask before every step'}
                </div>
              </div>
              <span
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                  settings?.autoApproveReadonly ? 'bg-[#3A3A3A]' : 'bg-black/15'
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                    settings?.autoApproveReadonly ? 'translate-x-3.5' : 'translate-x-0.5'
                  }`}
                />
              </span>
            </button>
          </section>

          {/* Permissions */}
          <section className="mt-6 border-t border-hairline pt-4">
            <h3 className="text-sm font-semibold text-ink">Permissions</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-hint">
              What Verlox may do on its own. <b>Always</b> runs without asking,
              <b> Ask</b> pauses for approval, <b>Never</b> refuses the step
              entirely.
            </p>
            <div className="mt-2 flex flex-col gap-1">
              {PERMISSION_CAPABILITIES.map(({ capability, label }) => {
                const current = permissionFor(settings?.permissions, capability);
                return (
                  <div key={capability} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs text-ink-label">{label}</span>
                    <div className="flex shrink-0 items-center rounded-md border border-hairline bg-surface-subtle p-0.5">
                      {(['always', 'ask', 'never'] as PermissionRule[]).map((rule) => (
                        <button
                          key={rule}
                          type="button"
                          disabled={!settings}
                          onClick={() => void changePermission(capability, rule)}
                          className={`rounded px-2 py-0.5 text-[10.5px] font-medium capitalize transition-colors disabled:opacity-50 ${
                            current === rule
                              ? rule === 'never'
                                ? 'bg-[#B4322B] text-white'
                                : rule === 'always'
                                  ? 'bg-[#3E7A53] text-white'
                                  : 'bg-[#3A3A3A] text-white'
                              : 'text-ink-hint hover:text-ink'
                          }`}
                        >
                          {rule}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Context boundaries — what Verlox can and can't see. */}
          <section className="mt-6 border-t border-hairline pt-4">
            <h3 className="text-sm font-semibold text-ink">What Verlox can see</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-hint">
              Verlox isn’t all-seeing. This is exactly what it has access to when
              it plans and runs actions — so its visibility is never a mystery.
            </p>
            <div className="mt-2 text-[10px] font-medium uppercase tracking-wide text-[#3E7A53]">
              Can see
            </div>
            <ul className="mt-1.5 space-y-1.5">
              {CONTEXT_VISIBLE.map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#EAF3EC] text-[9px] font-bold text-[#3E7A53]">
                    ✓
                  </span>
                  <span className="text-xs text-ink-label">{t}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 text-[10px] font-medium uppercase tracking-wide text-[#B4322B]">
              Can’t see
            </div>
            <ul className="mt-1.5 space-y-1.5">
              {CONTEXT_HIDDEN.map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#FBEAE8] text-[9px] font-bold text-[#B4322B]">
                    ✕
                  </span>
                  <span className="text-xs text-ink-label">{t}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

const CONTEXT_VISIBLE = [
  'The working folder shown in the chat bar (where its commands run)',
  'Your open terminal tabs — the text currently on screen',
  'What it has done this conversation (the steps it ran)',
  'Your operating system and shell',
  'Images you attach to a message',
];

const CONTEXT_HIDDEN = [
  'Files it hasn’t opened or created',
  'Apps, your browser, or anything outside the terminal',
  'Secrets or passwords, unless a command reveals them',
  'Anything before this conversation — it has no long-term memory',
  'Its own commands run in a separate shell from your visible terminal',
];
