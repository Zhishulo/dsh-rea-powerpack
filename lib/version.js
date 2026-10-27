/**
 * Single source of truth for the plugin's own identity.
 *
 * The published package.json is the only version number in the repository:
 * /state, the engine download User-Agent and the MCP handshake clientInfo all
 * read it from here so they cannot drift after a release bump.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = require('../package.json')

export const PACKAGE_NAME = manifest.name
export const PACKAGE_VERSION = manifest.version
