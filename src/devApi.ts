// Calls the dev-only endpoints in vite.config.ts. In production these two steps
// belong on your backend, which is the only place the API user token should exist.

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    const detail =
      payload && typeof payload === 'object'
        ? JSON.stringify(payload)
        : `HTTP ${res.status}`
    throw new Error(`${path} failed: ${detail}`)
  }
  return payload as T
}

export interface EndUser {
  id: string
  external_id: string
  created_at: string
}

export interface AuthToken {
  access_token: string
  user_id: string
  expired_at: string
}

/** Narrowed to what this harness shows; the real payload also carries balances and groups. */
export interface Vault {
  id: string
  name: string
  type: string
  address: string
  state: string
  created_at: string
}

/** Step 1 — create an end user (API user action). */
export function createEndUser(externalId: string): Promise<EndUser> {
  return post<EndUser>('/api/dev/end-users', { external_id: externalId })
}

/** Step 2 — issue an auth token on that user's behalf (API user action). */
export function issueAuthToken(userId: string): Promise<AuthToken> {
  return post<AuthToken>('/api/dev/auth-tokens', { user_id: userId })
}

/**
 * Optional step — create a Solana vault owned by the end user (API user action).
 *
 * Not something the Web SDK can do: it has no vault API, so this goes through the dev
 * server. The vault's keys come from the end user's keyset, which must already hold an
 * EdDSA key — see the key-type list in `login()`.
 */
export function createSolanaVault(endUserId: string, name: string): Promise<Vault> {
  return post<Vault>('/api/dev/vaults', { end_user_id: endUserId, name })
}
