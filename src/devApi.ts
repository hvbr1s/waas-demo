// Calls the dev-only endpoints in vite.config.ts. In production these steps
// belong on your backend, which is the only place the API user token should exist.

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init)
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

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
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

/**
 * Narrowed transaction record.
 *
 * `state` walks `waiting_for_approval → approved → signed → pushed_to_blockchain → mined →
 * completed`; `approved` is the point at which the browser must call `signTransaction`.
 * `hash` is the base58 Solana signature and only appears once the tx has been pushed.
 */
export interface TransactionRecord {
  id: string
  state: string
  hash?: string | null
  explorer_url?: string | null
}

export interface TransferInput {
  vaultId: string
  /** Destination base58 address. */
  to: string
  /** Base units, decimal string — convert with `toBaseUnits` before calling. */
  value: string
  /** SPL mint. Omit for native SOL. */
  mint?: string
  note?: string
}

/**
 * Step 3 — create the transfer (API user action), leaving the end user to sign it.
 *
 * The dev route builds the Fordefi payload itself and pins `signer_type: "end_user"` and
 * the chain; the browser only supplies the transfer's parameters.
 */
export function createTransfer(input: TransferInput): Promise<TransactionRecord> {
  return post<TransactionRecord>('/api/dev/transactions', {
    vault_id: input.vaultId,
    to: input.to,
    value: input.value,
    ...(input.mint ? { mint: input.mint } : {}),
    ...(input.note ? { note: input.note } : {}),
  })
}

/** Step 5 — poll for the state the SDK's `signTransaction()` never returns. */
export function getTransaction(id: string): Promise<TransactionRecord> {
  return get<TransactionRecord>(`/api/dev/transactions?id=${encodeURIComponent(id)}`)
}

/**
 * Fordefi's indexed view of a vault's assets, scoped to devnet by the dev route.
 *
 * Read `balances.total_mined`, never the sibling flat `balance` string — the spec marks that
 * one `deprecated: true`. `asset_info` varies in shape by chain, so everything on it is
 * optional here and callers fall back to the raw base-unit figure.
 */
export interface OwnedAsset {
  priced_asset?: {
    asset_info?: {
      type?: string
      name?: string
      symbol?: string
      decimals?: number
      /** Present for SPL tokens; the mint address. */
      base58_repr?: string
      contract?: { base58_repr?: string }
    }
  }
  balances?: {
    total_mined?: string
    available_mined?: string
  }
}

export function getVaultAssets(vaultId: string): Promise<{ owned_assets?: OwnedAsset[] }> {
  return get<{ owned_assets?: OwnedAsset[] }>(
    `/api/dev/vault-assets?vault_id=${encodeURIComponent(vaultId)}`,
  )
}
