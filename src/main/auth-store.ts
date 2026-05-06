import { safeStorage } from 'electron';
import Store from 'electron-store';

interface AuthSchema {
  encryptedToken: string | null;
}

// Separate file from the cwd store to keep concerns isolated.
// Default path: <userData>/auth.json
const store = new Store<AuthSchema>({
  name: 'auth',
  defaults: { encryptedToken: null },
});

/**
 * Returns the decrypted session token, or null if no token is stored
 * or decryption is unavailable.
 *
 * safeStorage uses the OS keychain on macOS, libsecret on Linux, and
 * DPAPI on Windows. On Linux without a keychain (rare on dev machines),
 * isEncryptionAvailable() returns false and we refuse to operate rather
 * than fall back to plaintext.
 */
export function getToken(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const encrypted = store.get('encryptedToken');
  if (!encrypted) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    // Decryption failed — most likely the OS-level encryption key changed
    // (user reset login keychain, reinstalled, etc.). Treat as no token
    // and clear the bad blob.
    store.set('encryptedToken', null);
    return null;
  }
}

export function setToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption unavailable; cannot persist session token securely',
    );
  }
  const encrypted = safeStorage.encryptString(token);
  store.set('encryptedToken', encrypted.toString('base64'));
}

export function clearToken(): void {
  store.set('encryptedToken', null);
}

export function hasToken(): boolean {
  return store.get('encryptedToken') != null;
}
