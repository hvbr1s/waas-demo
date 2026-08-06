declare module 'virtual:fordefi-config' {
  /** Fordefi API base URL, from FORDEFI_API_BASE_URL (default https://api.fordefi.com). */
  export const baseURL: string
  /** Test-only AES-256 backup key from FORDEFI_TEST_BACKUP_KEY; '' when unset. */
  export const testBackupKey: string
}
