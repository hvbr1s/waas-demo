import './style.css'
import { createEndUser, issueAuthToken } from './devApi'
import {
  backupWithExternalKey,
  formatThrown,
  initFordefi,
  login,
  recoverWithExternalKey,
} from './fordefi'
import {
  generateBackupKey,
  keyCameFromEnv,
  loadStoredKey,
  storeKey,
  validateBackupKey,
} from './backupKey'

const LAST_USER_KEY = 'waas-demo:lastUserId'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <h1>WaaS initialization harness</h1>
  <p class="sub">
    Onboards an end user via the dev server, runs <code>getInstance()</code> →
    <code>login()</code>, then backs up or recovers key shares with an
    external AES-256 key.
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
  log: app.querySelector<HTMLPreElement>('#log')!,
}

els.externalId.value = `waas-demo-${new Date().toISOString().slice(0, 10)}`
els.userId.value = localStorage.getItem(LAST_USER_KEY) ?? ''
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
  const buttons = [els.run, els.initOnly, els.doBackup, els.doRecover]
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
  setState('', 'ok')
})

refreshKeyStatus()
if (keyFromEnv) log('info', 'backup key prefilled from FORDEFI_TEST_BACKUP_KEY in .env')
log('info', 'harness ready')
