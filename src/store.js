// Small JSON files under the plugin's state directory. Writes go through a temp file and rename,
// so a crash never leaves a half-written file.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** @param {string} file */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 * @param {{ secret?: boolean }} [options] secret files are readable by the owner only
 */
export async function writeJson(file, value, options = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: options.secret ? 0o600 : 0o644 })
  if (options.secret) await chmod(tmp, 0o600)
  await rename(tmp, file)
}

/** @param {string} file */
export async function removeFile(file) {
  await rm(file, { force: true })
}

/**
 * Where the plugin keeps its files.
 * - `connection.json`: Ripple URL and agent token written by `ripple_connect` (mode 0600).
 * - `<actor id>.json`: event cursor, room → session map, recently seen event ids.
 * - `workspace/`: the working directory of Ripple sessions.
 * @param {string} root
 */
export function statePaths(root) {
  return {
    root,
    connection: join(root, 'connection.json'),
    actorState: (/** @type {string} */ actorId) => join(root, `${actorId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
    workspace: join(root, 'workspace'),
  }
}
