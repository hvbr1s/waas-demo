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

/** Step 1 — create an end user (API user action). */
export function createEndUser(externalId: string): Promise<EndUser> {
  return post<EndUser>('/api/dev/end-users', { external_id: externalId })
}

/** Step 2 — issue an auth token on that user's behalf (API user action). */
export function issueAuthToken(userId: string): Promise<AuthToken> {
  return post<AuthToken>('/api/dev/auth-tokens', { user_id: userId })
}
