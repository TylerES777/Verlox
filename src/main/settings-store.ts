import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { AgentProviderMeta, ProviderFormat } from '@shared/types';

// Agent Mode settings: a list of user-added AI providers plus the
// auto-approve toggle. Each provider's API key is encrypted at rest with the
// OS keychain (same approach as the session token in auth-store.ts). Keys are
// never returned over IPC; only the metadata (name/format/url/model) is.

interface SettingsSchema {
  providers: AgentProviderMeta[];
  // provider id -> base64 of the OS-encrypted key
  encryptedKeys: Record<string, string>;
  autoApproveReadonly: boolean;
}

const store = new Store<SettingsSchema>({
  name: 'settings',
  defaults: { providers: [], encryptedKeys: {}, autoApproveReadonly: true },
});

export function listProviders(): AgentProviderMeta[] {
  return store.get('providers');
}

export function getProviderKey(id: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const blob = store.get('encryptedKeys')[id];
  if (!blob) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    return null;
  }
}

export function getProvider(id: string): AgentProviderMeta | undefined {
  return store.get('providers').find((p) => p.id === id);
}

// Save a new provider + its key, returning the created metadata.
export function addProvider(
  meta: Omit<AgentProviderMeta, 'id'>,
  key: string,
): AgentProviderMeta {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption unavailable; cannot store your AI key securely.',
    );
  }
  const id = randomUUID();
  const full: AgentProviderMeta = { id, ...meta };
  const providers = [...store.get('providers'), full];
  const encryptedKeys = { ...store.get('encryptedKeys') };
  encryptedKeys[id] = safeStorage.encryptString(key).toString('base64');
  store.set('providers', providers);
  store.set('encryptedKeys', encryptedKeys);
  return full;
}

export function removeProvider(id: string): void {
  store.set(
    'providers',
    store.get('providers').filter((p) => p.id !== id),
  );
  const encryptedKeys = { ...store.get('encryptedKeys') };
  delete encryptedKeys[id];
  store.set('encryptedKeys', encryptedKeys);
}

export function getAutoApprove(): boolean {
  return store.get('autoApproveReadonly');
}

export function setAutoApprove(enabled: boolean): void {
  store.set('autoApproveReadonly', enabled);
}

// Sensible default base URL for a freshly-chosen format (used to prefill the
// add-provider form).
export function defaultBaseUrl(format: ProviderFormat): string {
  return format === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
}
