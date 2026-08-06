// Direct devnet chain access, deliberately dependency-free.
//
// This is the *ground truth* half of the balance panel: what the chain says, independent of
// whether Fordefi has indexed the vault yet. @solana/kit would give a nicer API, but the two
// RPC methods used here are a few lines each and the repo's one-dependency footprint is worth
// more than the ergonomics.

import { solanaDevnetRpcUrl } from 'virtual:fordefi-config'

// Both token programs. A devnet mint can live under either, and querying only the original
// silently reports a zero balance for any Token-2022 mint.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

export const SOL_DECIMALS = 9

export interface SplBalance {
  mint: string
  /** Base units, as a decimal string — matches how Fordefi reports balances. */
  amount: string
  decimals: number
}

interface RpcEnvelope<T> {
  result?: T
  error?: { code: number; message: string }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(solanaDevnetRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`solana rpc ${method} failed: HTTP ${res.status}`)

  const payload = (await res.json()) as RpcEnvelope<T>
  if (payload.error) {
    throw new Error(`solana rpc ${method} failed: ${payload.error.message}`)
  }
  if (payload.result === undefined) {
    throw new Error(`solana rpc ${method} returned no result`)
  }
  return payload.result
}

/** Native SOL balance in lamports. */
export async function getSolBalance(address: string): Promise<bigint> {
  const result = await rpc<{ value: number }>('getBalance', [
    address,
    { commitment: 'confirmed' },
  ])
  return BigInt(result.value)
}

interface ParsedTokenAccounts {
  value: Array<{
    account: {
      data: {
        parsed: {
          info: {
            mint: string
            tokenAmount: { amount: string; decimals: number }
          }
        }
      }
    }
  }>
}

/** Every SPL balance held by `address`, across both token programs. */
export async function getSplBalances(address: string): Promise<SplBalance[]> {
  const perProgram = await Promise.all(
    [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
      rpc<ParsedTokenAccounts>('getTokenAccountsByOwner', [
        address,
        { programId },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]),
    ),
  )

  const balances: SplBalance[] = []
  for (const program of perProgram) {
    for (const entry of program.value) {
      const info = entry.account.data.parsed.info
      balances.push({
        mint: info.mint,
        amount: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
      })
    }
  }
  return balances
}

/**
 * Display units → base units, as a decimal string.
 *
 * String/BigInt math rather than `Number`: 0.1 SOL has to become exactly 100000000, and
 * `0.1 * 1e9` does not reliably produce an integer.
 */
export function toBaseUnits(amount: string, decimals: number): string {
  const trimmed = amount.trim()
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`amount is not a decimal number: "${amount}"`)
  }

  const [whole = '', fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places: "${amount}"`)
  }

  const base = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  if (base === '' || base === '0') throw new Error('amount must be greater than zero')
  return base
}

/** Base units → display units, trailing zeros kept so columns line up. */
export function fromBaseUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw
  if (decimals === 0) return raw

  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals)
  return `${whole}.${fraction}`
}

/** The spec's own base58 pattern. Catches a bad paste before it reaches the API. */
export function isBase58Address(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim())
}

/** `EPjFWdd5…TDt1v` — keeps the balance table's asset column narrow. */
export function shortenAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`
}
