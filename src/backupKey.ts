// AES-256 key handling for the external-encryption backup flow.
//
// The SDK's validation is exact and undocumented. From index.bundle.js:
//
//     let r = !1
//     try { r = 32 === atob(e.encryption.key).length } catch {}
//     if (!r) reject(InvalidArgs, "encryption key is invalid. expected a base64
//                                  encoded string of a key matching the selected key type")
//
// So the key must be BASE64 that decodes to EXACTLY 32 bytes. A 64-char hex string
// decodes to 48 bytes under atob() and is rejected. The docs don't state the encoding.

import { testBackupKey } from 'virtual:fordefi-config'

const KEY_BYTES = 32
const STORAGE_KEY = 'waas-demo:backupKey'

/** Generates a fresh AES-256 key as base64 (44 chars). */
export function generateBackupKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Mirrors the SDK's check so we fail with an actionable message before calling in.
 * Also used before recoverKeys, which — unlike backupKeys — performs no validation
 * of its own and would otherwise fail deeper with an opaque error.
 */
export function validateBackupKey(key: string): { ok: true } | { ok: false; reason: string } {
  if (!key) return { ok: false, reason: 'no key provided' }

  let decoded: string
  try {
    decoded = atob(key)
  } catch {
    return {
      ok: false,
      reason: 'not valid base64 — the SDK requires base64, not hex',
    }
  }

  if (decoded.length !== KEY_BYTES) {
    const looksHex = /^[0-9a-f]+$/i.test(key)
    return {
      ok: false,
      reason:
        `decodes to ${decoded.length} bytes, need exactly ${KEY_BYTES}` +
        (looksHex ? ' — this looks like hex; base64-encode the raw 32 bytes instead' : ''),
    }
  }

  return { ok: true }
}

/**
 * Dev-only persistence so backup and recovery can be exercised across reloads.
 * In production this key is the sole means of recovering the user's key shares:
 * it belongs in your backend or a user-held secret, never in localStorage.
 *
 * Falls back to FORDEFI_TEST_BACKUP_KEY from .env so the key survives clearing
 * site data — otherwise a wiped localStorage strands any existing backup.
 */
export function loadStoredKey(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) return stored
  return testBackupKey
}

/** True when the field is populated from .env rather than localStorage. */
export function keyCameFromEnv(): boolean {
  return !localStorage.getItem(STORAGE_KEY) && Boolean(testBackupKey)
}

export function storeKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key)
}
