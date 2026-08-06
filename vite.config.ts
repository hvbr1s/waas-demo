import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

const DEFAULT_BASE_URL = 'https://api.fordefi.com'

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

  async function callFordefi(path: string, body: unknown) {
    const res = await fetch(`${baseURL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiUserToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
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
        const route = (req.url ?? '').split('?')[0]?.replace(/\/$/, '') || '/'

        if (req.method !== 'POST') return next()
        if (route !== '/end-users' && route !== '/auth-tokens' && route !== '/vaults') {
          return next()
        }

        if (!apiUserToken) {
          return sendJson(res, 500, {
            error: 'FORDEFI_API_USER_TOKEN is not set in .env',
          })
        }

        try {
          const payload = await readJsonBody(req)

          if (route === '/end-users') {
            const externalId =
              typeof payload.external_id === 'string' && payload.external_id
                ? payload.external_id
                : null
            if (!externalId) {
              return sendJson(res, 400, { error: 'external_id (string) is required' })
            }
            const result = await callFordefi('/api/v1/end-users', {
              external_id: externalId,
            })
            return sendJson(res, result.ok ? 200 : result.status, result.body)
          }

          if (route === '/vaults') {
            const endUserId =
              typeof payload.end_user_id === 'string' && payload.end_user_id
                ? payload.end_user_id
                : null
            if (!endUserId) {
              return sendJson(res, 400, { error: 'end_user_id (string) is required' })
            }
            const name = typeof payload.name === 'string' && payload.name ? payload.name : null
            if (!name) {
              return sendJson(res, 400, { error: 'name (string) is required' })
            }
            // `type` is fixed here rather than taken from the request: the browser gets to ask
            // for a vault, not to pick which chain the API user creates one on.
            const result = await callFordefi('/api/v1/vaults', {
              type: 'solana',
              name,
              end_user_id: endUserId,
            })
            return sendJson(res, result.ok ? 200 : result.status, result.body)
          }

          // route === '/auth-tokens'
          const userId =
            typeof payload.user_id === 'string' && payload.user_id ? payload.user_id : null
          if (!userId) {
            return sendJson(res, 400, { error: 'user_id (string) is required' })
          }
          const result = await callFordefi('/api/v1/authorization-tokens', {
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

      return [
        `export const baseURL = ${JSON.stringify(env.FORDEFI_API_BASE_URL || DEFAULT_BASE_URL)}`,
        `export const testBackupKey = ${JSON.stringify(testBackupKey)}`,
      ].join('\n')
    },
  }
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
