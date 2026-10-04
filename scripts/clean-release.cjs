// Only remove this repository's generated unpacked build. Never kill applications.
const { existsSync, realpathSync, rmSync, lstatSync } = require('node:fs')
const { resolve, dirname, sep } = require('node:path')
const root = realpathSync(resolve(__dirname, '..'))
const output = resolve(root, 'release', 'win-unpacked')
if (existsSync(output)) {
  const actual = realpathSync(output)
  if (lstatSync(output).isSymbolicLink() || !actual.startsWith(root + sep) || dirname(actual) !== resolve(root, 'release')) {
    throw new Error('Refusing to clean a build directory outside this repository')
  }
  try {
    rmSync(output, { recursive: true, force: true, maxRetries: 2, retryDelay: 400 })
  } catch (error) {
    throw new Error('无法清理 release/win-unpacked。请先从托盘退出该目录中的 TodoPet，再重新打包。', { cause: error })
  }
}
