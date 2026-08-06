/// <reference types="@fordefi/web-sdk/dist/index" />

// @fordefi/web-sdk ships a webpack UMD bundle whose .d.ts is a global
// `declare namespace fordefiWebSDK` with no module export — `import { Fordefi } from
// '@fordefi/web-sdk'` fails with TS2306 ("not a module"). The bundle is loaded by the
// classic <script> tag in index.html, which is also what makes its worker resolve
// correctly (see scripts/sync-sdk-assets.mjs). So we read it off the global here.

import { baseURL } from 'virtual:fordefi-config'

export type LogSink = (level: string, message: string) => void

/** The SDK global, or a clear error if the <script> tag has not executed yet. */
function sdk(): typeof fordefiWebSDK {
  if (typeof fordefiWebSDK === 'undefined') {
    throw new Error(
      'fordefiWebSDK global is missing. Is /fordefi/index.bundle.js loaded? ' +
        'Run `npm run sync-sdk` to populate public/fordefi/.',
    )
  }
  return fordefiWebSDK
}

let instance: fordefiWebSDK.Fordefi | null = null

/**
 * Initialize the SDK singleton and attach the logger + error handler.
 * Safe to call repeatedly; only the first call does work.
 */
export function initFordefi(onLog: LogSink): fordefiWebSDK.Fordefi {
  if (instance) return instance

  const api = sdk()
  const fordefi = api.Fordefi.getInstance({ baseURL })

  // The SDK prints nothing on its own; without setLogger you get no diagnostics.
  fordefi.setLogger({
    log(level, message) {
      onLog(`sdk:${level}`, message)
    },
  })

  // Catches errors surfaced outside of a rejected promise (e.g. token expiry
  // during a background refresh).
  fordefi.setErrorHandler({
    handleError(error) {
      onLog('sdk:error', `code=${error.code} ${describeErrorCode(error.code)} — ${formatDetails(error)}`)
    },
  })

  instance = fordefi
  onLog('info', `SDK initialized against ${baseURL}`)
  return fordefi
}

/**
 * Log in with an end-user auth token and report the resulting device state.
 * `deviceState` must be NO_OPERATION_REQUIRED before signing is possible.
 */
export async function login(
  authToken: string,
  onLog: LogSink,
): Promise<fordefiWebSDK.LoginResponse> {
  const api = sdk()
  const fordefi = initFordefi(onLog)

  onLog('info', 'login() — generating/loading ECDSA key shares, this can take a while…')

  // Only request the key types you actually need; each one costs key-generation time.
  const res = await fordefi.login(authToken, [api.FordefiKeyType.ECDSA])

  onLog('info', `login ok — userID=${res.userID} keysetID=${res.keysetID}`)
  onLog('info', `deviceState=${res.deviceState} — ${describeDeviceState(res.deviceState)}`)

  return res
}

/**
 * Builds the external-encryption backup option.
 *
 * Deliberately the only option constructor in this file: nothing here can produce a
 * `FordefiBackupOptionCloudProvider`, and `FordefiBackupCloudProviders.initialize()`
 * is never called, so the cloud provider registry stays empty for the process
 * lifetime. See the audit note in README-BACKUP.md for why that means no Google
 * code path is reachable.
 */
function externalEncryptionOption(key: string): fordefiWebSDK.FordefiBackupOptionExternalEncryption {
  const api = sdk()
  return {
    type: api.FordefiBackupOptionType.ExternalEncryption,
    encryption: {
      key,
      type: api.FordefiExternalEncryptionKeyType.AES256,
    },
  }
}

/**
 * Back up this device's key shares, encrypted with a caller-supplied AES-256 key.
 * An encrypted copy is stored on the Fordefi platform; the key itself never leaves
 * the browser. Replaces any existing backup.
 */
export async function backupWithExternalKey(key: string, onLog: LogSink): Promise<void> {
  const fordefi = initFordefi(onLog)
  const option = externalEncryptionOption(key)

  onLog('info', `backupKeys(type=${option.type}, encryption.type=${option.encryption.type})`)
  await fordefi.backupKeys(option)
  onLog('info', 'backupKeys ok — encrypted share uploaded to Fordefi')
}

/**
 * Recover key shares onto this device from the platform-stored encrypted backup,
 * decrypting with the same AES-256 key used to create it.
 */
export async function recoverWithExternalKey(key: string, onLog: LogSink): Promise<void> {
  const fordefi = initFordefi(onLog)
  const option = externalEncryptionOption(key)

  onLog('info', `recoverKeys(type=${option.type}, encryption.type=${option.encryption.type})`)
  await fordefi.recoverKeys(option)
  onLog('info', 'recoverKeys ok — key shares provisioned on this device')
}

export function describeDeviceState(state: fordefiWebSDK.DeviceState): string {
  const api = sdk()
  switch (state) {
    case api.DeviceState.NoOperationRequired:
      return 'ready to sign'
    case api.DeviceState.DeviceStateBackupRequired:
      return 'new user — backupKeys() required before signing'
    case api.DeviceState.DeviceStateRecoveryRequired:
      return 'new device — recoverKeys() required before signing'
    case api.DeviceState.DeviceStateError:
      return 'device is in an error state'
    default:
      return 'unrecognized device state'
  }
}

/** Maps a numeric FordefiErrorCode back to its name for readable logs. */
export function describeErrorCode(code: number): string {
  const codes = sdk().FordefiErrorCode as unknown as Record<string, unknown>
  for (const [name, value] of Object.entries(codes)) {
    if (value === code) return name
  }
  return 'UnknownErrorCode'
}

function formatDetails(error: fordefiWebSDK.FordefiError): string {
  const text = error.details?.text ?? ''
  const internal = error.details?.details?.internal_error_code
  return internal ? `${text} (internal_error_code=${internal})` : text || 'no details'
}

/** Normalizes a thrown value into something loggable, unwrapping FordefiError. */
export function formatThrown(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && 'details' in err) {
    const e = err as fordefiWebSDK.FordefiError
    return `FordefiError code=${e.code} ${describeErrorCode(e.code)} — ${formatDetails(e)}`
  }
  return err instanceof Error ? err.message : String(err)
}
