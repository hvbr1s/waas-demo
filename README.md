# waas-demo

Scratch harness for the Fordefi WaaS Web SDK (`@fordefi/web-sdk`): onboards an end
user, runs `login()`, exercises external-key backup and recovery, then creates a Solana
vault, reads its devnet balances, and transfers out of it via `signTransaction()`.

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

### Browser

Until `localhost` is whitelisted on Fordefi's side, the SDK's calls to `api.fordefi.com`
fail CORS preflight. Open the harness in a throwaway Chrome profile with web security
off — `--disable-web-security` is ignored unless `--user-data-dir` points somewhere
other than your real profile:

```bash
mkdir -p /tmp/chrome-user-data      # any directory, just not your default profile

open -n -a /Applications/Google\ Chrome.app --args \
  --user-data-dir=/tmp/chrome-user-data \
  --disable-web-security
```

Dev only, and only for this harness. The profile has every same-origin protection off,
so don't browse anything else in it — close the window when you're done.

### .env

| Variable | Reaches browser | Purpose |
| --- | --- | --- |
| `FORDEFI_API_USER_TOKEN` | **no** | Creates end users, issues end-user tokens. Org-wide authority. |
| `FORDEFI_API_BASE_URL` | yes | Defaults to `https://api.fordefi.com`. |
| `FORDEFI_TEST_BACKUP_KEY` | yes | Test AES-256 key. `openssl rand -base64 32` |
| `SOLANA_DEVNET_RPC_URL` | yes | Defaults to `https://api.devnet.solana.com`. |

Only the last three are exported by the `virtual:fordefi-config` module. The API user
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
6. **Create Solana vault** — `POST /api/v1/vaults` with `end_user_id`, via the dev server.
   The id and base58 address fill the two fields and persist to localStorage, so the
   panels below still work after a reload. Paste them by hand to reuse an existing vault.
7. **Fund it.** Drip devnet SOL to the address at
   [faucet.solana.com](https://faucet.solana.com). Nothing below works on an empty vault —
   it pays the network fee, and the rent on any token account a transfer has to create.
8. **Refresh balances.** Two columns for the same address: a direct devnet RPC read, and
   Fordefi's indexed `GET /api/v1/vaults/{id}/assets?chains=solana_devnet`. Expect the RPC
   column to move first. A persistently empty Fordefi column means devnet isn't enabled for
   the org — see Gotchas.
9. **Transfer.** Leave *SPL mint* blank for native SOL, or paste a mint and set its
   decimals. The log narrates the whole lifecycle:
   `waiting_for_approval → approved → signed → pushed_to_blockchain → mined → completed`,
   with `signTransaction()` running at `approved`. The signature and a Solscan link land in
   the log on success, and balances refresh automatically.

Everything is timestamped in the log panel. `Init SDK only` isolates
`getInstance()` from the network steps when you need to narrow a failure down.

### Transaction lifecycle

The dev server creates the transaction; the browser signs it. Those are two different
credentials doing two different jobs, which is the whole point of WaaS.

| Step | Who | Call |
| --- | --- | --- |
| 1 | dev server | `POST /api/v1/transactions` with `signer_type: "end_user"` → `id` |
| 2 | browser | poll until `approved` |
| 3 | browser | `fordefi.signTransaction(id)` — MPC with the enclave, resolves `void` |
| 4 | browser | poll to `completed`, read `hash` and `explorer_url` |

Step 3 returning nothing is why steps 2 and 4 exist: the signature never comes back through
the SDK, only through the platform API.

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
  network error rather than a `FordefiError`, this is why — not the code. For local runs,
  use the CORS-disabled Chrome profile from [Setup → Browser](#browser).
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
- **Changing the `login()` key-type list changes the keyset.** `login()` requests
  `[ECDSA, EDDSA]` — EdDSA because a Solana vault derives from an ed25519 key. An end user
  onboarded before EdDSA was added comes back as `BACKUP_REQUIRED` on the next login and
  must back up again; each extra key type also costs keygen time.
- **The Web SDK cannot create vaults.** Its surface is `login`, `backupKeys`, `recoverKeys`,
  `exportKeys`, `signTransaction`. Vault creation is an API-user call, hence the dev-server
  route, and it needs the bearer token only.
- **Transaction creation may need `x-signature`/`x-timestamp`; this harness doesn't send
  them.** Fordefi's OpenAPI says of `x-signature`: *"If the request is made programatically
  by an API user, signing of the request is required."* No WaaS page exempts
  `signer_type: "end_user"`, and Fordefi's own demo repos disagree with each other on it —
  so this is unsettled, and running the transfer flow is what settles it. **Symptom:** the
  transfer fails at *create*, before anything reaches `signTransaction`, with a 401/403
  naming the signature. **Fix:** in `callFordefi` (`vite.config.ts`), sign
  `` `${path}|${timestamp}|${body}` `` with an ECDSA P-256 key — SHA-256, DER, base64, valid
  120 seconds — and add the two headers. Serialize the body once and sign that exact string.
  The public key can only be registered through the API Signer container's *Register API
  user key* CLI; there's no documented console path, which is the real cost.
- **Solana Devnet has to be enabled for the org.** Chain visibility is a workspace setting
  (Manage Chains → Customize Chain Visibility). If the chain column shows a balance and the
  Fordefi column stays empty, that's the setting — not a bug in the request. Devnet token
  prices are meaningless either way; only `balances.total_mined` matters here.
- **`signTransaction()` needs a `login()` in the same page session.** The SDK singleton holds
  the session, and nothing in localStorage substitutes for it. Vault id, address and backup
  key all survive a reload; the ability to sign does not. Re-run *Onboard & login* first.
- **A vault needs SOL even for a pure SPL transfer.** If the destination has no associated
  token account, Fordefi creates one and the *source* vault pays its rent exemption on top
  of the fee.
- **SPL decimals are operator-supplied.** The harness doesn't read the mint, so the
  *Decimals* field is the only thing standing between you and an amount off by orders of
  magnitude. It nudges 9 ↔ 6 as the mint field fills and empties; that's a guess, not a
  lookup.
- **The mint goes in `asset_identifier.details.token.base58_repr`** — not `token.mint`, not
  `token.address`, both of which appear in unofficial examples and neither of which exists
  in the spec. Same for `to`: the spec wants `{type: "address", address}`, though Fordefi's
  own docs examples pass a bare string.
- **Balances live under `balances.total_mined`.** The flat `balance` sibling on `OwnedAsset`
  is marked `deprecated: true` in the spec.
- **Don't use Vite `define` for config.** It substitutes at build but not in dev, giving
  a `ReferenceError` under `npm run dev`. Hence `virtual:fordefi-config`.
- **Google Drive is not involved** and its `<script>` tags stay commented out in
  `index.html`. `FordefiBackupCloudProviders.initialize()` is never called; the package
  README's no-arg call for this flow both throws and is unnecessary.


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
src/fordefi.ts               getInstance, login, backup, recover, signTransaction
src/backupKey.ts             AES-256 key generate/validate/persist
src/devApi.ts                calls to the dev endpoints
src/solana.ts                devnet RPC reads + base-unit conversion (no deps)
src/main.ts                  UI and flow wiring
```

Not production code. The dev endpoints, the localStorage'd backup key, and the
`.env`-supplied test key all exist to make failures reproducible, and all of them are
the wrong choice in a real app.
