import './style.css'
import {
  createEndUser,
  createSolanaVault,
  createTransfer,
  getTransaction,
  getVaultAssets,
  issueAuthToken,
  type OwnedAsset,
  type TransactionRecord,
} from './devApi'
import {
  backupWithExternalKey,
  formatThrown,
  initFordefi,
  login,
  recoverWithExternalKey,
  signTransaction,
} from './fordefi'
import {
  generateBackupKey,
  keyCameFromEnv,
  loadStoredKey,
  storeKey,
  validateBackupKey,
} from './backupKey'
import {
  fromBaseUnits,
  getSolBalance,
  getSplBalances,
  isBase58Address,
  shortenAddress,
  SOL_DECIMALS,
  toBaseUnits,
} from './solana'

const LAST_USER_KEY = 'waas-demo:lastUserId'
const LAST_VAULT_ID_KEY = 'waas-demo:lastVaultId'
const LAST_VAULT_ADDRESS_KEY = 'waas-demo:lastVaultAddress'

// A transaction sits here until a policy rule (or nothing at all) lets it through to
// `approved`. Signing before that just fails, so the transfer flow waits it out.
const PRE_APPROVAL_STATES = ['waiting_for_approval', 'waiting_for_signing_trigger', 'queued']
const SUCCESS_STATES = ['mined', 'completed']
const TERMINAL_STATES = [
  ...SUCCESS_STATES,
  'aborted',
  'cancelled',
  'dropped',
  'insufficient_funds',
  'error_signing',
  'error_pushing_to_blockchain',
  'mined_reverted',
  'completed_reverted',
]

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <h1>WaaS initialization harness</h1>
  <p class="sub">
    Onboards an end user via the dev server, runs <code>getInstance()</code> →
    <code>login()</code>, then backs up or recovers key shares with an
    external AES-256 key. Creates a Solana vault, reads its devnet balances, and runs a
    transfer through <code>signTransaction()</code>.
  </p>

  <div class="row">
    <label>
      External ID
      <input id="external-id" type="text" placeholder="e.g. danj-test-1" />
    </label>
    <label>
      Existing end-user ID <span class="hint">(optional — skips user creation)</span>
      <input id="user-id" type="text" placeholder="uuid" />
    </label>
  </div>

  <div class="actions">
    <button id="run" type="button">Onboard &amp; login</button>
    <button id="init-only" type="button" class="secondary">Init SDK only</button>
    <button id="clear" type="button" class="secondary">Clear log</button>
  </div>

  <p id="state" class="state"></p>

  <fieldset id="backup">
    <legend>External-key backup</legend>
    <label>
      AES-256 key <span class="hint">base64, decodes to exactly 32 bytes</span>
      <input id="backup-key" type="text" spellcheck="false" placeholder="base64 key" />
    </label>
    <p id="key-status" class="key-status"></p>
    <div class="actions">
      <button id="gen-key" type="button" class="secondary">Generate key</button>
      <button id="do-backup" type="button">Back up keys</button>
      <button id="do-recover" type="button" class="secondary">Recover keys</button>
    </div>
    <p class="warn-note">
      This key is the only way to recover the shares. Stored in localStorage for
      dev convenience — in production it belongs in your backend or a user-held secret.
    </p>
  </fieldset>

  <fieldset id="vault">
    <legend>Solana vault</legend>
    <div class="row">
      <label>
        Vault ID <span class="hint">(filled on create; paste to reuse)</span>
        <input id="vault-id" type="text" spellcheck="false" placeholder="uuid" />
      </label>
      <label>
        Vault address <span class="hint">(base58, used for devnet RPC)</span>
        <input id="vault-addr" type="text" spellcheck="false" placeholder="base58 address" />
      </label>
    </div>
    <div class="actions">
      <button id="create-vault" type="button">Create Solana vault</button>
    </div>
    <p id="vault-address" class="vault-address"></p>
    <p class="warn-note">
      <code>POST /api/v1/vaults</code> for the end-user ID above. The Web SDK has no vault
      API, so the dev server makes this call with the org-wide API user token — the end user
      never does. Keys come from that user's keyset, which needs an EdDSA key. A vault is
      scoped to a chain <em>family</em>, so this same vault works on devnet.
    </p>
  </fieldset>

  <fieldset id="balances">
    <legend>Devnet balances</legend>
    <div class="actions">
      <button id="refresh-balances" type="button" class="secondary">Refresh balances</button>
    </div>
    <table class="balances">
      <thead>
        <tr><th>Asset</th><th>On chain</th><th>Fordefi</th></tr>
      </thead>
      <tbody id="balances-body"></tbody>
    </table>
    <p class="warn-note">
      Two independent views of the same address: a direct <code>getBalance</code> /
      <code>getTokenAccountsByOwner</code> against devnet, and Fordefi's indexed
      <code>GET /api/v1/vaults/{id}/assets?chains=solana_devnet</code>. They can disagree —
      indexing lags, and devnet has to be enabled for your org under Manage Chains.
      Fund the vault at <a href="https://faucet.solana.com" target="_blank"
      rel="noreferrer">faucet.solana.com</a>; it needs SOL for fees and for the rent on any
      token account a transfer has to create.
    </p>
  </fieldset>

  <fieldset id="transfer">
    <legend>Transfer</legend>
    <div class="row">
      <label>
        Destination address
        <input id="dest-addr" type="text" spellcheck="false" placeholder="base58 address" />
      </label>
      <label>
        Amount <span class="hint">(display units)</span>
        <input id="amount" type="text" spellcheck="false" placeholder="0.01" />
      </label>
    </div>
    <div class="row">
      <label>
        SPL mint <span class="hint">(blank = native SOL)</span>
        <input id="mint" type="text" spellcheck="false" placeholder="base58 mint" />
      </label>
      <label>
        Decimals <span class="hint">(of the asset being sent)</span>
        <input id="decimals" type="text" spellcheck="false" value="9" />
      </label>
    </div>
    <div class="actions">
      <button id="do-transfer" type="button">Create &amp; sign transfer</button>
    </div>
    <p id="tx-result" class="vault-address"></p>
    <p class="warn-note">
      The dev server creates the transaction with <code>signer_type: "end_user"</code>, then
      this page calls <code>signTransaction(id)</code> — the end user's key share and
      Fordefi's enclave each produce a partial signature. Requires a
      <code>login()</code> in <em>this</em> page session, so re-run "Onboard &amp; login"
      after a reload. Decimals are not looked up on chain: get them wrong and you send the
      wrong amount.
    </p>
  </fieldset>

  <pre id="log" aria-live="polite"></pre>
`

const els = {
  externalId: app.querySelector<HTMLInputElement>('#external-id')!,
  userId: app.querySelector<HTMLInputElement>('#user-id')!,
  run: app.querySelector<HTMLButtonElement>('#run')!,
  initOnly: app.querySelector<HTMLButtonElement>('#init-only')!,
  clear: app.querySelector<HTMLButtonElement>('#clear')!,
  state: app.querySelector<HTMLParagraphElement>('#state')!,
  backupKey: app.querySelector<HTMLInputElement>('#backup-key')!,
  keyStatus: app.querySelector<HTMLParagraphElement>('#key-status')!,
  genKey: app.querySelector<HTMLButtonElement>('#gen-key')!,
  doBackup: app.querySelector<HTMLButtonElement>('#do-backup')!,
  doRecover: app.querySelector<HTMLButtonElement>('#do-recover')!,
  vaultId: app.querySelector<HTMLInputElement>('#vault-id')!,
  vaultAddr: app.querySelector<HTMLInputElement>('#vault-addr')!,
  createVault: app.querySelector<HTMLButtonElement>('#create-vault')!,
  vaultAddress: app.querySelector<HTMLParagraphElement>('#vault-address')!,
  refreshBalances: app.querySelector<HTMLButtonElement>('#refresh-balances')!,
  balancesBody: app.querySelector<HTMLTableSectionElement>('#balances-body')!,
  destAddr: app.querySelector<HTMLInputElement>('#dest-addr')!,
  amount: app.querySelector<HTMLInputElement>('#amount')!,
  mint: app.querySelector<HTMLInputElement>('#mint')!,
  decimals: app.querySelector<HTMLInputElement>('#decimals')!,
  doTransfer: app.querySelector<HTMLButtonElement>('#do-transfer')!,
  txResult: app.querySelector<HTMLParagraphElement>('#tx-result')!,
  log: app.querySelector<HTMLPreElement>('#log')!,
}

els.externalId.value = `waas-demo-${new Date().toISOString().slice(0, 10)}`
els.userId.value = localStorage.getItem(LAST_USER_KEY) ?? ''
els.vaultId.value = localStorage.getItem(LAST_VAULT_ID_KEY) ?? ''
els.vaultAddr.value = localStorage.getItem(LAST_VAULT_ADDRESS_KEY) ?? ''
const keyFromEnv = keyCameFromEnv()
els.backupKey.value = loadStoredKey()

const started = performance.now()

function log(level: string, message: string): void {
  const t = ((performance.now() - started) / 1000).toFixed(2).padStart(6)
  els.log.textContent += `[${t}s] ${level.padEnd(11)} ${message}\n`
  els.log.scrollTop = els.log.scrollHeight
}

function setState(text: string, kind: 'ok' | 'warn' | 'err' | 'busy'): void {
  els.state.textContent = text
  els.state.dataset.kind = kind
}

/** Reflects key validity next to the field, using the same rule the SDK applies. */
function refreshKeyStatus(): boolean {
  const key = els.backupKey.value.trim()
  if (!key) {
    els.keyStatus.textContent = 'No key yet — generate one, or paste an existing key to recover.'
    els.keyStatus.dataset.kind = 'warn'
    return false
  }
  const result = validateBackupKey(key)
  if (result.ok) {
    els.keyStatus.textContent = 'Valid: base64, 32 bytes.'
    els.keyStatus.dataset.kind = 'ok'
    return true
  }
  els.keyStatus.textContent = `Invalid: ${result.reason}`
  els.keyStatus.dataset.kind = 'err'
  return false
}

async function withBusy(label: string, fn: () => Promise<void>): Promise<void> {
  const buttons = [
    els.run,
    els.initOnly,
    els.doBackup,
    els.doRecover,
    els.createVault,
    els.refreshBalances,
    els.doTransfer,
  ]
  for (const b of buttons) b.disabled = true
  setState(`${label}…`, 'busy')
  try {
    await fn()
  } catch (err) {
    const message = formatThrown(err)
    log('error', message)
    setState(message, 'err')
  } finally {
    for (const b of buttons) b.disabled = false
  }
}

/** Reads and validates the key, throwing before we reach the SDK. */
function requireKey(): string {
  const key = els.backupKey.value.trim()
  const result = validateBackupKey(key)
  if (!result.ok) throw new Error(`encryption key rejected: ${result.reason}`)
  return key
}

function requireVaultId(): string {
  const id = els.vaultId.value.trim()
  if (!id) throw new Error('Vault ID is required — create a Solana vault first, or paste one')
  return id
}

function requireVaultAddress(): string {
  const address = els.vaultAddr.value.trim()
  if (!address) throw new Error('Vault address is required — create a Solana vault first')
  if (!isBase58Address(address)) throw new Error(`vault address is not valid base58: ${address}`)
  return address
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Polls until `isDone(state)`, logging only on a state *change* so the log reads as a
 * lifecycle rather than a stream of identical lines.
 */
async function pollTransaction(
  id: string,
  isDone: (state: string) => boolean,
  timeoutMs: number,
  timeoutHint = '',
): Promise<TransactionRecord> {
  const deadline = performance.now() + timeoutMs
  let lastState = ''

  for (;;) {
    const tx = await getTransaction(id)
    if (tx.state !== lastState) {
      log('info', `tx state=${tx.state}`)
      lastState = tx.state
    }
    if (isDone(tx.state)) return tx
    if (performance.now() > deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s with tx ${id} in state ` +
          `"${tx.state}"${timeoutHint ? ` — ${timeoutHint}` : ''}`,
      )
    }
    await sleep(2000)
  }
}

// ── Balances ────────────────────────────────────────────────────────────────────────────

interface BalanceCell {
  label: string
  amount: string
}

/** Key native SOL apart from every mint so the two sources merge onto the same rows. */
const NATIVE_KEY = 'native'

function fordefiAssetKey(asset: OwnedAsset): { key: string; label: string; decimals: number } {
  const info = asset.priced_asset?.asset_info
  const mint = info?.base58_repr ?? info?.contract?.base58_repr ?? null
  const symbol = info?.symbol ?? info?.name ?? null
  const decimals = typeof info?.decimals === 'number' ? info.decimals : SOL_DECIMALS

  if (mint) return { key: mint, label: `${symbol ?? 'SPL'} (${shortenAddress(mint)})`, decimals }
  if (info?.type === 'native' || symbol === 'SOL') {
    return { key: NATIVE_KEY, label: 'SOL', decimals }
  }
  return { key: symbol ?? 'unknown', label: symbol ?? 'unknown asset', decimals }
}

function renderBalances(
  chain: Map<string, BalanceCell> | string,
  fordefi: Map<string, BalanceCell> | string,
): void {
  els.balancesBody.replaceChildren()

  const keys = new Set<string>()
  if (typeof chain !== 'string') for (const k of chain.keys()) keys.add(k)
  if (typeof fordefi !== 'string') for (const k of fordefi.keys()) keys.add(k)

  // Native first, then mints alphabetically — a stable order so a refresh does not reshuffle.
  const ordered = [...keys].sort((a, b) => {
    if (a === NATIVE_KEY) return -1
    if (b === NATIVE_KEY) return 1
    return a.localeCompare(b)
  })

  const cell = (
    source: Map<string, BalanceCell> | string,
    key: string,
  ): { text: string; muted: boolean } => {
    if (typeof source === 'string') return { text: source, muted: true }
    const found = source.get(key)
    return found ? { text: found.amount, muted: false } : { text: '—', muted: true }
  }

  if (ordered.length === 0) {
    const bothFailed = typeof chain === 'string' && typeof fordefi === 'string'
    const row = els.balancesBody.insertRow()
    const td = row.insertCell()
    td.colSpan = 3
    td.className = 'muted'
    td.textContent = bothFailed
      ? 'Both sources failed — see the log.'
      : 'No assets found on either source.'
    return
  }

  for (const key of ordered) {
    const label =
      (typeof chain !== 'string' ? chain.get(key)?.label : undefined) ??
      (typeof fordefi !== 'string' ? fordefi.get(key)?.label : undefined) ??
      key

    const row = els.balancesBody.insertRow()
    row.insertCell().textContent = label

    for (const source of [chain, fordefi]) {
      const { text, muted } = cell(source, key)
      const td = row.insertCell()
      td.textContent = text
      td.className = muted ? 'num muted' : 'num'
    }
  }
}

async function readChainBalances(address: string): Promise<Map<string, BalanceCell>> {
  const [lamports, spl] = await Promise.all([getSolBalance(address), getSplBalances(address)])

  const out = new Map<string, BalanceCell>()
  out.set(NATIVE_KEY, { label: 'SOL', amount: fromBaseUnits(lamports.toString(), SOL_DECIMALS) })
  for (const token of spl) {
    out.set(token.mint, {
      label: `SPL (${shortenAddress(token.mint)})`,
      amount: fromBaseUnits(token.amount, token.decimals),
    })
  }
  return out
}

async function readFordefiBalances(vaultId: string): Promise<Map<string, BalanceCell>> {
  const res = await getVaultAssets(vaultId)
  const out = new Map<string, BalanceCell>()

  for (const asset of res.owned_assets ?? []) {
    const { key, label, decimals } = fordefiAssetKey(asset)
    const raw = asset.balances?.total_mined
    if (raw === undefined) continue
    out.set(key, { label, amount: fromBaseUnits(raw, decimals) })
  }
  return out
}

/**
 * Both sources, rendered independently. `allSettled` rather than `all` because a failure of
 * one is the interesting case — devnet not enabled for the org, or the public RPC rate
 * limiting — and it should show up as one empty column, not an empty table.
 */
async function refreshBalances(): Promise<void> {
  const vaultId = requireVaultId()
  const address = requireVaultAddress()

  log('info', `reading balances for ${address}`)
  const [chainResult, fordefiResult] = await Promise.allSettled([
    readChainBalances(address),
    readFordefiBalances(vaultId),
  ])

  let chain: Map<string, BalanceCell> | string
  if (chainResult.status === 'fulfilled') {
    chain = chainResult.value
  } else {
    chain = 'rpc error'
    log('error', `devnet rpc: ${formatThrown(chainResult.reason)}`)
  }

  let fordefi: Map<string, BalanceCell> | string
  if (fordefiResult.status === 'fulfilled') {
    fordefi = fordefiResult.value
  } else {
    fordefi = 'unavailable'
    log('error', `fordefi assets: ${formatThrown(fordefiResult.reason)}`)
  }

  renderBalances(chain, fordefi)

  if (typeof chain !== 'string' && typeof fordefi !== 'string' && fordefi.size === 0) {
    log(
      'info',
      'fordefi reported no assets — expected while indexing catches up, but if it persists ' +
        'check that Solana Devnet is enabled for the org under Manage Chains',
    )
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────────────────

els.run.addEventListener('click', () => {
  void withBusy('Onboarding', async () => {
    let userId = els.userId.value.trim()

    if (userId) {
      log('info', `reusing end user ${userId}`)
    } else {
      const externalId = els.externalId.value.trim()
      if (!externalId) throw new Error('External ID is required to create a new end user')
      log('info', `creating end user external_id=${externalId}`)
      const user = await createEndUser(externalId)
      userId = user.id
      els.userId.value = userId
      log('info', `created end user ${userId}`)
    }

    localStorage.setItem(LAST_USER_KEY, userId)

    log('info', 'issuing end-user auth token')
    const token = await issueAuthToken(userId)
    log('info', `token issued, expires ${token.expired_at}`)

    const res = await login(token.access_token, log)

    switch (res.deviceState) {
      case 'BACKUP_REQUIRED':
        setState('BACKUP_REQUIRED — back up keys below to enable signing', 'warn')
        log('info', 'next: generate a key and press "Back up keys"')
        break
      case 'RECOVERY_REQUIRED':
        setState('RECOVERY_REQUIRED — recover keys below', 'warn')
        log('info', 'next: paste the original backup key and press "Recover keys"')
        break
      case 'NO_OPERATION_REQUIRED':
        setState('NO_OPERATION_REQUIRED — ready to sign', 'ok')
        break
      default:
        setState(`deviceState=${res.deviceState}`, 'err')
    }
  })
})

els.doBackup.addEventListener('click', () => {
  void withBusy('Backing up', async () => {
    const key = requireKey()
    storeKey(key)
    await backupWithExternalKey(key, log)
    setState('Backup complete — device should now be ready to sign', 'ok')
  })
})

els.doRecover.addEventListener('click', () => {
  void withBusy('Recovering', async () => {
    const key = requireKey()
    storeKey(key)
    await recoverWithExternalKey(key, log)
    setState('Recovery complete — key shares provisioned on this device', 'ok')
  })
})

els.createVault.addEventListener('click', () => {
  void withBusy('Creating vault', async () => {
    const userId = els.userId.value.trim()
    if (!userId) throw new Error('End-user ID is required — run "Onboard & login" first')

    const name = `waas-demo-solana-${Date.now()}`
    log('info', `creating solana vault name=${name} end_user_id=${userId}`)
    const vault = await createSolanaVault(userId, name)
    log('info', `vault created id=${vault.id} state=${vault.state} address=${vault.address || '—'}`)

    els.vaultId.value = vault.id
    localStorage.setItem(LAST_VAULT_ID_KEY, vault.id)

    // The address is derived from the keyset, so it should come back on the create response.
    // If it ever doesn't, show the id rather than an empty line.
    if (vault.address) {
      els.vaultAddr.value = vault.address
      localStorage.setItem(LAST_VAULT_ADDRESS_KEY, vault.address)
      els.vaultAddress.textContent = vault.address
      els.vaultAddress.dataset.kind = 'ok'
      setState(`Solana vault created — ${vault.address}`, 'ok')
      log('info', 'next: fund it at https://faucet.solana.com, then "Refresh balances"')
    } else {
      els.vaultAddress.textContent = `${vault.id} — no address in the response`
      els.vaultAddress.dataset.kind = 'warn'
      setState('Vault created, but the response carried no address', 'warn')
    }
  })
})

for (const [input, key] of [
  [els.vaultId, LAST_VAULT_ID_KEY],
  [els.vaultAddr, LAST_VAULT_ADDRESS_KEY],
] as const) {
  input.addEventListener('input', () => {
    localStorage.setItem(key, input.value.trim())
  })
}

els.refreshBalances.addEventListener('click', () => {
  void withBusy('Reading balances', async () => {
    await refreshBalances()
    setState('Balances refreshed', 'ok')
  })
})

// Decimals cannot be inferred without a chain lookup, so this only nudges the common cases:
// 9 for native SOL, 6 for the typical SPL. Anything else is on the operator.
els.mint.addEventListener('input', () => {
  const hasMint = els.mint.value.trim() !== ''
  if (hasMint && els.decimals.value.trim() === String(SOL_DECIMALS)) els.decimals.value = '6'
  if (!hasMint && els.decimals.value.trim() === '6') els.decimals.value = String(SOL_DECIMALS)
})

els.doTransfer.addEventListener('click', () => {
  void withBusy('Transferring', async () => {
    const vaultId = requireVaultId()

    const to = els.destAddr.value.trim()
    if (!isBase58Address(to)) {
      throw new Error(`destination is not a valid base58 address: "${to}"`)
    }

    const mint = els.mint.value.trim()
    if (mint && !isBase58Address(mint)) {
      throw new Error(`mint is not a valid base58 address: "${mint}"`)
    }

    const decimals = Number(els.decimals.value.trim())
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`decimals must be an integer between 0 and 18, got "${els.decimals.value}"`)
    }

    const value = toBaseUnits(els.amount.value, decimals)
    const asset = mint ? `SPL ${mint}` : 'native SOL'
    log('info', `transfer ${els.amount.value.trim()} ${asset} = ${value} base units → ${to}`)

    els.txResult.textContent = ''
    const created = await createTransfer({
      vaultId,
      to,
      value,
      ...(mint ? { mint } : {}),
      note: 'waas-demo transfer',
    })
    log('info', `transaction created id=${created.id} state=${created.state}`)
    els.txResult.textContent = created.id
    els.txResult.dataset.kind = 'warn'

    // Wait for the platform to hand the transaction to its signer. If a policy rule holds it
    // in waiting_for_approval, signing now would fail with a confusing precondition error.
    setState('Waiting for approval…', 'busy')
    const ready = await pollTransaction(
      created.id,
      (state) => !PRE_APPROVAL_STATES.includes(state),
      60_000,
      'a policy rule is holding it for a human approver, so the end user cannot sign it yet',
    )
    if (TERMINAL_STATES.includes(ready.state) && !SUCCESS_STATES.includes(ready.state)) {
      throw new Error(`transaction ended in "${ready.state}" before it could be signed`)
    }

    if (ready.state === 'approved') {
      setState('Signing…', 'busy')
      await signTransaction(created.id, log)
    } else {
      log('info', `state is already "${ready.state}" — skipping signTransaction`)
    }

    setState('Waiting for the network…', 'busy')
    const final = await pollTransaction(
      created.id,
      (state) => TERMINAL_STATES.includes(state),
      120_000,
    )

    if (final.hash) log('info', `signature ${final.hash}`)
    if (final.explorer_url) log('info', `explorer ${final.explorer_url}`)

    if (SUCCESS_STATES.includes(final.state)) {
      els.txResult.textContent = final.hash ?? final.id
      els.txResult.dataset.kind = 'ok'
      setState(`Transfer ${final.state}`, 'ok')
    } else {
      els.txResult.textContent = `${final.id} — ${final.state}`
      els.txResult.dataset.kind = 'warn'
      setState(`Transfer ended in "${final.state}"`, 'err')
      return
    }

    await refreshBalances()
  })
})

els.genKey.addEventListener('click', () => {
  const key = generateBackupKey()
  els.backupKey.value = key
  storeKey(key)
  refreshKeyStatus()
  log('info', 'generated a new AES-256 key (base64, 32 bytes) and saved it to localStorage')
})

els.backupKey.addEventListener('input', () => {
  refreshKeyStatus()
})

els.initOnly.addEventListener('click', () => {
  void withBusy('Initializing', async () => {
    initFordefi(log)
    setState('SDK initialized', 'ok')
  })
})

els.clear.addEventListener('click', () => {
  els.log.textContent = ''
  els.vaultAddress.textContent = ''
  els.txResult.textContent = ''
  els.balancesBody.replaceChildren()
  setState('', 'ok')
})

refreshKeyStatus()
if (keyFromEnv) log('info', 'backup key prefilled from FORDEFI_TEST_BACKUP_KEY in .env')
log('info', 'harness ready')
