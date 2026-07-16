import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronVersion = require(join(root, 'node_modules/electron/package.json')).version

function run(cmd, args, cwd = root) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`${cmd} failed with exit ${result.status}`)
  }
}

// Rebuild native modules for Electron (skip broken optional cpu-features).
run(
  'npx',
  ['@electron/rebuild', '-f', '--only', 'better-sqlite3,serialport,@serialport/bindings-cpp', '-v', electronVersion],
  root
)

if (process.platform === 'win32') {
  run(
    'npx',
    [
      'node-gyp',
      'rebuild',
      `--target=${electronVersion}`,
      '--arch=x64',
      '--dist-url=https://electronjs.org/headers',
    ],
    join(root, 'native/rdp-host')
  )
} else {
  console.log('[rebuild-natives] skipping RDP host (Windows only)')
}

console.log('[rebuild-natives] done')
