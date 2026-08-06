declare module 'virtual:fordefi-config' {
  /** Fordefi API base URL, from FORDEFI_API_BASE_URL (default https://api.fordefi.com). */
  export const baseURL: string
  /** Test-only AES-256 backup key from FORDEFI_TEST_BACKUP_KEY; '' when unset. */
  export const testBackupKey: string
  /** Solana devnet JSON-RPC endpoint, from SOLANA_DEVNET_RPC_URL (default the public one). */
  export const solanaDevnetRpcUrl: string
}
