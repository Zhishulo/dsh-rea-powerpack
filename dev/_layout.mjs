// dev/_layout.mjs — resolve the package root for the dev harness.
//
// The harness ships inside the package repository (<repo>/dev), but the original
// development checkout kept it in a sibling directory (<workspace>/dev next to
// <workspace>/rea-powerpack). Every script must work in both layouts, so they all
// ask here instead of hardcoding '..'.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const isPackageRoot = (dir) => {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-rea-powerpack'
  } catch {
    return false
  }
}

/** Package root for a dev script that lives in <root>/dev. */
export const locateRepo = (here) => {
  const parent = resolve(here, '..')
  return isPackageRoot(parent) ? parent : join(parent, 'rea-powerpack')
}

/** Package root plus the workspace directory that contains it. */
export const locateLayout = (here) => {
  const repo = locateRepo(here)
  return { repo, workspace: resolve(repo, '..') }
}
