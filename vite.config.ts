import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

const DEFAULT_BASE_URL = 'https://api.fordefi.com'
const DEFAULT_SOLANA_RPC_URL = 'https://api.devnet.solana.com'

// Every Solana call this harness makes is pinned to devnet, and the pin lives here rather
// than in the browser for the same reason `type: 'solana'` does on the vault route: the
// browser gets to ask for a transfer, not to pick which network the API user sends it on.
const SOLANA_CHAIN = 'solana_devnet'

// Split by method so the allowlist stays a literal you have to edit deliberately. A new
// endpoint needs an entry here *and* its own branch below.
const POST_ROUTES = ['/end-users', '/auth-tokens', '/vaults', '/transactions']
const GET_ROUTES = ['/vault-assets', '/transactions']

/**
 * Dev-only backend for the WaaS onboarding handshake.
 *
 * FORDEFI_API_USER_TOKEN is an *API user* credential with org-wide authority. It must
 * never reach the browser, so it is deliberately read WITHOUT a `VITE_` prefix: Vite
 * only inlines `VITE_*` vars into the client bundle. These endpoints run in the Node
 * dev server, hold the token, and hand the browser nothing but a short-lived end-user
 * access token and the vaults it creates on that user's behalf.
 *
 * This stands in for your real backend. Do not ship it.
 */
function fordefiDevApi(env: Record<string, string>): Plugin {
  const apiUserToken = env.FORDEFI_API_USER_TOKEN ?? ''
  const baseURL = env.FORDEFI_API_BASE_URL || DEFAULT_BASE_URL

  /**
   * Bearer token only — no `x-signature`/`x-timestamp`.
   *
   * Fordefi's OpenAPI says of `x-signature`: "If the request is made programatically by an
   * API user, signing of the request is required." Nothing in the WaaS docs exempts
   * `signer_type: "end_user"`, so POST /transactions may yet reject an unsigned request.
   * If it does, the fix goes here and nowhere else: sign `${path}|${timestamp}|${body}`
   * with an ECDSA P-256 key (SHA-256, DER, base64, valid 120s) and add the two headers.
   * Serialize the body once and sign that exact string — it must go out byte-identical.
   */
  async function callFordefi(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiUserToken}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON error body; pass the raw text through */
    }
    return { ok: res.ok, status: res.status, body: parsed }
  }

  return {
    name: 'fordefi-dev-api',
    apply: 'serve',
    configureServer(server) {
      if (!apiUserToken) {
        server.config.logger.warn(
          '[fordefi] FORDEFI_API_USER_TOKEN is not set — /api/dev/* will return 500. ' +
            'Copy .env.example to .env and fill it in.',
        )
      }

      server.middlewares.use('/api/dev', async (req, res, next) => {
        const [rawPath, rawQuery] = (req.url ?? '').split('?')
        const route = rawPath?.replace(/\/$/, '') || '/'
        const query = new URLSearchParams(rawQuery ?? '')

        const isPost = req.method === 'POST'
        const isGet = req.method === 'GET'
        if (!isPost && !isGet) return next()
        if (!(isPost ? POST_ROUTES : GET_ROUTES).includes(route)) return next()

        if (!apiUserToken) {
          return sendJson(res, 500, {
            error: 'FORDEFI_API_USER_TOKEN is not set in .env',
          })
        }

        try {
          if (isGet) {
            if (route === '/transactions') {
              const id = requiredString(query.get('id'))
              if (!id) return sendJson(res, 400, { error: 'id (query param) is required' })
              const result = await callFordefi('GET', `/api/v1/transactions/${id}`)
              return sendJson(res, result.ok ? 200 : result.status, result.body)
            }

            // route === '/vault-assets'
            const vaultId = requiredString(query.get('vault_id'))
            if (!vaultId) {
              return sendJson(res, 400, { error: 'vault_id (query param) is required' })
            }
            const result = await callFordefi(
              'GET',
              `/api/v1/vaults/${vaultId}/assets?chains=${SOLANA_CHAIN}`,
            )
            return sendJson(res, result.ok ? 200 : result.status, result.body)
          }

          const payload = await readJsonBody(req)

          if (route === '/end-users') {
            const externalId = requiredString(payload.external_id)
            if (!externalId) {
              return sendJson(res, 400, { error: 'external_id (string) is required' })
            }
            const result = await callFordefi('POST', '/api/v1/end-users', {
              external_id: externalId,
            })
            return sendJson(res, result.ok ? 200 : result.status, result.body)
          }

          if (route === '/vaults') {
            const endUserId = requiredString(payload.end_user_id)
            if (!endUserId) {
              return sendJson(res, 400, { error: 'end_user_id (string) is required' })
            }
            const name = requiredString(payload.name)
            if (!name) {
              return sendJson(res, 400, { error: 'name (string) is required' })
            }
            // `type` is fixed here rather than taken from the request: the browser gets to ask
            // for a vault, not to pick which chain the API user creates one on.
            const result = await callFordefi('POST', '/api/v1/vaults', {
              type: 'solana',
              name,
              end_user_id: endUserId,
            })
            return sendJson(res, result.ok ? 200 : result.status, result.body)
          }

          if (route === '/transactions') {
            const vaultId = requiredString(payload.vault_id)
            if (!vaultId) return sendJson(res, 400, { error: 'vault_id (string) is required' })
            const to = requiredString(payload.to)
            if (!to) return sendJson(res, 400, { error: 'to (string) is required' })
            // Base units as a decimal string. The browser does the display-unit conversion
            // (src/solana.ts) because only it knows the token's decimals.
            const value = requiredString(payload.value)
            if (!value || !/^\d+$/.test(value)) {
              return sendJson(res, 400, { error: 'value (decimal string, base units) is required' })
            }
            // Absent mint means native SOL. Present mint means an SPL transfer; Fordefi
            // creates the destination ATA if it is missing, and this vault pays its rent.
            const mint = requiredString(payload.mint)
            const note = requiredString(payload.note)

            const assetIdentifier = mint
              ? {
                  type: 'solana',
                  details: {
                    type: 'spl_token',
                    // The mint goes in `token.base58_repr`, not `token.mint` — the spec's
                    // SolanaAddressRequest requires both `chain` and `base58_repr`.
                    token: { chain: SOLANA_CHAIN, base58_repr: mint },
                  },
                }
              : { type: 'solana', details: { type: 'native', chain: SOLANA_CHAIN } }

            const result = await callFordefi('POST', '/api/v1/transactions', {
              vault_id: vaultId,
              signer_type: 'end_user',
              type: 'solana_transaction',
              ...(note ? { note } : {}),
              details: {
                type: 'solana_transfer',
                to: { 
                  type: 'address', 
                  address: to 
                },
                value: { 
                  type: 'value', 
                  value 
                },
                asset_identifier: assetIdentifier,
              },
            })
            return sendJson(res, result.ok ? 200 : result.status, result.body)
          }

          // route === '/auth-tokens'
          const userId = requiredString(payload.user_id)
          if (!userId) {
            return sendJson(res, 400, { error: 'user_id (string) is required' })
          }
          const result = await callFordefi('POST', '/api/v1/authorization-tokens', {
            user_type: 'end_user',
            user_id: userId,
          })
          return sendJson(res, result.ok ? 200 : result.status, result.body)
        } catch (err) {
          return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
    },
  }
}

const VIRTUAL_ID = 'virtual:fordefi-config'
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID

/**
 * Exposes browser-safe config as a virtual module.
 *
 * Deliberately not `define`: Vite substitutes `define` identifiers during build but not
 * in the dev server, so a bare `__FOO__` becomes a ReferenceError under `npm run dev`.
 * A virtual module resolves identically in both modes.
 *
 * This is also an explicit allowlist of what crosses into the browser. Everything else
 * in .env — FORDEFI_API_USER_TOKEN above all — stays in the Node process.
 */
function fordefiConfigModule(env: Record<string, string>): Plugin {
  return {
    name: 'fordefi-config-module',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null

      // Stray quotes or whitespace in the key make the SDK's atob() throw.
      const testBackupKey = (env.FORDEFI_TEST_BACKUP_KEY ?? '')
        .trim()
        .replace(/^['"]|['"]$/g, '')

      // Overridable because the public devnet endpoint rate-limits aggressively; point this
      // at Helius/QuickNode/etc. if the balance panel starts returning 429s.
      const solanaRpcUrl = (env.SOLANA_DEVNET_RPC_URL ?? '').trim() || DEFAULT_SOLANA_RPC_URL

      return [
        `export const baseURL = ${JSON.stringify(env.FORDEFI_API_BASE_URL || DEFAULT_BASE_URL)}`,
        `export const testBackupKey = ${JSON.stringify(testBackupKey)}`,
        `export const solanaDevnetRpcUrl = ${JSON.stringify(solanaRpcUrl)}`,
      ].join('\n')
    },
  }
}

/** Non-empty string or null, so every route's validation reads the same way. */
function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('body must be a JSON object')
  return parsed as Record<string, unknown>
}

export default defineConfig(({ mode }) => {
  // '' prefix loads every var, not just VITE_*. Safe here: this value is used only in
  // Node-side plugin code above and is never passed to `define` or the client bundle.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [fordefiDevApi(env), fordefiConfigModule(env)],
  }
})
