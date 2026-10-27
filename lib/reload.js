/**
 * Restart-free reload of the MCP row this plugin installed.
 *
 * The row lives in the host's loader, not in this plugin's fiber, so the only
 * supported way to restart it is disable -> enable on the loader entry. The
 * cordis patch file is snapshotted first: when the host rewrites it during the
 * reload (normalisation, a concurrent plugin install) the snapshot is written
 * back so the row definition never drifts.
 *
 * @see ARCHITECTURE.md §5 (lib/reload.js)
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { coded } from './engines.js'

/** How long we wait for the loader to rebuild the row's fiber. */
export const RELOAD_TIMEOUT_MS = 15 * 1000

/** Resolve the DSH profile directory the same way the host does. */
export function profileDir(ctx) {
  const fromContext = ctx && ctx.profileContext && typeof ctx.profileContext.dir === 'string' ? ctx.profileContext.dir : null
  if (fromContext && fromContext !== '') return fromContext
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
}

function patchFileFor(ctx, opts) {
  return (opts && opts.patchFile) || join(profileDir(ctx), 'cordis.patch.yml')
}

/** Read the patch file as exact bytes plus its mtime. */
async function snapshotPatch(file) {
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file)])
    return { file, bytes, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/** Write the snapshot back when the file changed; returns whether we did. */
async function restorePatch(snapshot) {
  if (!snapshot) return false
  let current = null
  try {
    current = await readFile(snapshot.file)
  } catch {
    current = null
  }
  if (current && Buffer.compare(current, snapshot.bytes) === 0) return false
  const temporary = snapshot.file + '.' + process.pid + '.restore'
  await writeFile(temporary, snapshot.bytes)
  await rename(temporary, snapshot.file)
  return true
}

function findRow(loader, rowId) {
  if (!loader || typeof loader.entries !== 'function') return null
  const wanted = String(rowId)
  for (const entry of loader.entries()) {
    if (!entry) continue
    if (entry.id === wanted) return entry
    if (entry.options && entry.options.id === wanted) return entry
    const name = entry.options && entry.options.name
    if (typeof name === 'string' && name === wanted) return entry
  }
  return null
}

async function setDisabled(loader, entry, disabled) {
  if (loader && typeof loader.update === 'function') {
    await loader.update(entry.id, { disabled })
    return
  }
  if (entry && typeof entry.update === 'function') {
    await entry.update({ disabled })
    return
  }
  throw coded('reload_failed', 'The host loader does not expose an update API.')
}

/**
 * Restart one loader row in place.
 * @param {object} ctx host plugin context (must expose ctx.loader)
 * @param {string} rowId loader entry id, e.g. 'rea-powerpack-mcp'
 * @param {{patchFile?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, mode: 'hot'|'restart-required', reason?: string, restoredPatch: boolean}>}
 */
export async function reloadMcpRow(ctx, rowId, opts = {}) {
  const timeoutMs = opts.timeoutMs || RELOAD_TIMEOUT_MS
  const loader = ctx && ctx.loader
  const snapshot = await snapshotPatch(patchFileFor(ctx, opts))
  if (!loader || typeof loader.entries !== 'function') {
    const restoredPatch = await restorePatch(snapshot).catch(() => false)
    return { ok: false, mode: 'restart-required', reason: 'The host loader is unavailable (restart DeepSeek Harness).', restoredPatch }
  }
  const row = findRow(loader, rowId)
  if (!row) {
    const restoredPatch = await restorePatch(snapshot).catch(() => false)
    return { ok: false, mode: 'restart-required', reason: 'Loader row ' + rowId + ' is not present.', restoredPatch }
  }
  const beforeFiber = row.fiber || null
  const seen = new Set()
  let rebuilt = false
  let watcher = null
  try {
    if (ctx && typeof ctx.on === 'function') {
      watcher = ctx.on('internal/plugin', (fiber) => {
        if (!fiber) return
        if (fiber === beforeFiber) return
        if (fiber.entry === row || (row.fiber && fiber === row.fiber)) {
          seen.add(fiber.uid)
          if (row.fiber && row.fiber === fiber && row.disabled === false) rebuilt = true
        }
      })
    }
  } catch {
    watcher = null
  }
  try {
    await setDisabled(loader, row, true)
    await setDisabled(loader, row, false)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (row.disabled === false && row.fiber && row.fiber !== beforeFiber) {
        rebuilt = true
        break
      }
      if (typeof loader.await === 'function') {
        await Promise.race([loader.await(), new Promise((resolvePromise) => setTimeout(resolvePromise, 100))])
      } else {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    }
    if (typeof loader.await === 'function') {
      await Promise.race([loader.await(), new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))]).catch(() => {})
    }
    const restoredPatch = await restorePatch(snapshot).catch(() => false)
    if (rebuilt || (row.disabled === false && row.fiber)) {
      return { ok: true, mode: 'hot', restoredPatch }
    }
    return { ok: false, mode: 'restart-required', reason: 'The row did not rebuild within ' + Math.round(timeoutMs / 1000) + 's.', restoredPatch }
  } catch (error) {
    const restoredPatch = await restorePatch(snapshot).catch(() => false)
    const message = error && error.message ? error.message : String(error)
    return { ok: false, mode: 'restart-required', reason: message, restoredPatch }
  } finally {
    if (typeof watcher === 'function') {
      try {
        watcher()
      } catch {
        /* already disposed with the fiber */
      }
    }
  }
}
