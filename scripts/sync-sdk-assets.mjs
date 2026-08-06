// Copies the Fordefi Web SDK's runtime assets into public/fordefi/.
//
// Why this is needed: dist/index.bundle.js is a webpack UMD bundle that derives its
// publicPath from `document.currentScript.src` at load time, then loads its MPC worker
// from `<publicPath>/worker.bundle.js`. The worker in turn fetches `./main.wasm`
// *relative to itself*, with a hardcoded subresource-integrity hash.
//
// Consequences, both of which this script exists to satisfy:
//   1. All three files must sit in the SAME directory, served same-origin.
//   2. main.wasm must be byte-identical to the shipped file, or SRI rejects it.
//
// The files are copied rather than committed, so they always match the installed
// version of @fordefi/web-sdk. public/fordefi/ is gitignored.

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const ASSETS = ['index.bundle.js', 'worker.bundle.js', 'main.wasm']

const require = createRequire(import.meta.url)
const pkgPath = require.resolve('@fordefi/web-sdk/package.json')
const distDir = join(dirname(pkgPath), 'dist')
const outDir = new URL('../public/fordefi/', import.meta.url)

const { version } = JSON.parse(await readFile(pkgPath, 'utf8'))

await mkdir(outDir, { recursive: true })

for (const name of ASSETS) {
  const from = join(distDir, name)
  const to = new URL(name, outDir)
  const { size } = await stat(from)
  await copyFile(from, to)
  console.log(`  public/fordefi/${name.padEnd(18)} ${(size / 1024).toFixed(0)} KiB`)
}

console.log(`Synced @fordefi/web-sdk@${version} runtime assets.`)
