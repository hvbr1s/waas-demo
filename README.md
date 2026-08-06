# waas-demo

Scratch harness for the Fordefi WaaS Web SDK (`@fordefi/web-sdk`): onboards an end
user, runs `login()`, and exercises external-key backup and recovery.

Vite + TypeScript. The Vite dev server doubles as a stand-in backend so the API user
token stays server-side.

## Setup

```bash
cp .env.example .env      # then fill in FORDEFI_API_USER_TOKEN
npm install
npm run dev               # http://localhost:5173
```

Stop the server with `Ctrl-C`, or `pkill -f vite` if it was backgrounded and you've
lost the foreground job. `lsof -ti:5173 | xargs kill` if port 5173 stays occupied.

`predev` runs `npm run sync-sdk`, which copies the SDK's three runtime assets into
`public/fordefi/`. Re-run it after bumping `@fordefi/web-sdk`.

### .env

| Variable | Reaches browser | Purpose |
| --- | --- | --- |
| `FORDEFI_API_USER_TOKEN` | **no** | Creates end users, issues end-user tokens. Org-wide authority. |
| `FORDEFI_API_BASE_URL` | yes | Defaults to `https://api.fordefi.com`. |
| `FORDEFI_TEST_BACKUP_KEY` | yes | Test AES-256 key. `openssl rand -base64 32` |

Only the last two are exported by the `virtual:fordefi-config` module. The API user
token is read in Node-side plugin code only, and is deliberately *not* `VITE_`-prefixed
— that prefix is what makes Vite inline a value into the client bundle.

> [!IMPORTANT]
> **The backup key must be base64 that decodes to exactly 32 bytes.** The SDK enforces
> `32 === atob(key).length` and nothing in the docs says so — the packaged README shows
> only `key: "xxxxx"` (`node_modules/@fordefi/web-sdk/README.md:169`).
>
> | Input | chars | `atob()` | accepted |
> | --- | --- | --- | --- |
> | base64 of 32 bytes — `openssl rand -base64 32` | 44 | 32 bytes | **yes** |
> | the same key as hex — `openssl rand -hex 32` | 64 | 48 bytes | no |
> | base64 of 16 bytes (AES-128) | 24 | 16 bytes | no |
> | `"xxxxx"` | 5 | throws | no |
>
> Hex is the natural guess and it fails. Surrounding quotes or stray whitespace in
> `.env` make `atob()` throw too, so the value is trimmed and unquoted when the
> virtual module is built. `src/backupKey.ts` mirrors the check so the harness names
> the problem instead of surfacing the SDK's generic `InvalidArgs`.
>
> `backupKeys()` applies this check; **`recoverKeys()` does not** — see Gotchas.

## Playbook

1. **Onboard & login.** Leave *Existing end-user ID* blank for a fresh user, or paste
   one to reuse it. Runs create-user → issue-token → `login()`.
2. Confirm the key field reads **"Valid: base64, 32 bytes"**.
3. **Back up keys** when the state is `BACKUP_REQUIRED`.
4. Reload and log in again — should now be `NO_OPERATION_REQUIRED`.
5. **Recovery:** clear site data, log in → `RECOVERY_REQUIRED` → **Recover keys**.
   The key survives the clear only because of the `.env` prefill.

Everything is timestamped in the log panel. `Init SDK only` isolates
`getInstance()` from the network steps when you need to narrow a failure down.

### Device states

| State | Meaning | Next |
| --- | --- | --- |
| `BACKUP_REQUIRED` | Shares exist, no backup | `backupKeys()` |
| `RECOVERY_REQUIRED` | Shares absent on this device | `recoverKeys()` |
| `NO_OPERATION_REQUIRED` | Ready to sign | — |
| `ERROR` | Unexpected device state | check the log |

## Gotchas

These are all things that cost time once already.

- **CORS whitelisting.** Fordefi must whitelist your domain. If login fails with a
  network error rather than a `FordefiError`, this is why — not the code.
- **The SDK is loaded by a classic `<script>` tag, not `import`.** It's a webpack UMD
  bundle that derives its publicPath from `document.currentScript.src`. Under an ESM
  import that's `null`, webpack scans for script tags instead, and the MPC worker 404s.
  `import { Fordefi } from '@fordefi/web-sdk'` also fails to typecheck (TS2306) — the
  `.d.ts` declares a global namespace with no module export. Read it off the global.
- **`index.bundle.js`, `worker.bundle.js`, `main.wasm` must share one directory.** The
  worker fetches `./main.wasm` relative to itself with a pinned SRI hash, so the file
  must be byte-identical and same-origin. That's what `sync-sdk` guarantees.
- **The backup key is base64 decoding to exactly 32 bytes**, not hex. The SDK checks
  `32 === atob(key).length`. Stray quotes or whitespace make `atob()` throw.
- **`recoverKeys()` validates nothing** — no key check, no type check. Validate before
  calling or you get an opaque MPC-layer failure.
- **Don't use Vite `define` for config.** It substitutes at build but not in dev, giving
  a `ReferenceError` under `npm run dev`. Hence `virtual:fordefi-config`.
- **Google Drive is not involved** and its `<script>` tags stay commented out in
  `index.html`. `FordefiBackupCloudProviders.initialize()` is never called; the package
  README's no-arg call for this flow both throws and is unnecessary.

`README-BACKUP.md` has the deminified SDK source behind the last two points.

## Scripts

| | |
| --- | --- |
| `npm run dev` | Sync assets, start dev server |
| `npm run build` | Sync assets, typecheck, build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run sync-sdk` | Copy SDK assets to `public/fordefi/` |

## Layout

```
vite.config.ts               dev backend + virtual:fordefi-config
scripts/sync-sdk-assets.mjs  copies SDK runtime assets
src/fordefi.ts               getInstance, login, backup, recover
src/backupKey.ts             AES-256 key generate/validate/persist
src/devApi.ts                calls to the dev endpoints
src/main.ts                  UI and flow wiring
```

Not production code. The dev endpoints, the localStorage'd backup key, and the
`.env`-supplied test key all exist to make failures reproducible, and all of them are
the wrong choice in a real app.
