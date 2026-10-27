# dev/ — acceptance harness (repository only)

These scripts are how the plugin is verified before it is installed into a DSH
profile. They are **not** part of the npm package (`package.json#files` omits
`dev`), because they spawn REA, touch a profile, and assume a developer checkout.

Every script works in two layouts: this repository (`<repo>/dev`) and the
original development checkout (<workspace>/dev next to <workspace>/rea-powerpack).
`dev/_layout.mjs` resolves the package root for both — pass `--repo <dir>` to
override it.

| script | what it proves | exit codes |
| --- | --- | --- |
| `gate.mjs` | runs the three stages below in one command and prints a single verdict | 0 green · 1 fail · 2 warn |
| `acceptance.mjs` | package.json shape, every `lib/` file parses, `cordis.patch.yml` rows + the `!!js` argv actually evaluates to a real file in the profile, and the launcher brings REA up with 229 tools and no affordable provider gap | 0 · 1 · 2 |
| `http-probe.mjs` | imports `lib/index.js` the way the DSH loader does, hands it a stub context, and drives every `/rea-powerpack/*` route with synthetic req/res (writes are redirected to a scratch home) | 0 · 1 · 3 |
| `verify-mcp.mjs` | independent stdio MCP handshake against the real launcher, then reads `binary_session` → `tool_availability` for the group/reason report | 0 · 1 (handshake) · 2 (gaps) · 3 (usage) |
| `install-plugin.mjs` | `pnpm add link:<repo>` into a profile, bundle list surgery, stale `rea-agents*` patch entry cleanup, with backups | 0 · 1 |

## Commands

```bash
node dev/gate.mjs            # everything (spawns REA twice, ~90 s)
node dev/gate.mjs --fast     # skips the two REA stages
node dev/acceptance.mjs --skip-mcp
node dev/verify-mcp.mjs --launcher "$PROFILE/node_modules/dsh-rea-powerpack/lib/rea-mcp.mjs" --list-tools
node dev/install-plugin.mjs --dry-run
```

Baseline numbers and their reproduction recipes: [BASELINES.md](BASELINES.md).
