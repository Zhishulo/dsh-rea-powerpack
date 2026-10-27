# Availability baselines (REA 6.8.0 on this Windows host)

Every number below is reproducible from a clone of this repository. The launcher
under test is the one this package ships (`lib/rea-mcp.mjs`), and the probe is
`dev/verify-mcp.mjs` — an independent stdio MCP client that asks REA's own
`binary_session` which tool groups are available and why. Raw output sits next to
this file: `baseline-no-engines.json` and `baseline-with-engines.json`.

Run both from the repository root (`<repo>` below); `dev/` is not part of the npm
package, it ships with the source repository only.

## 1. No engines — bare startup (42 / 77 groups)

Point `REA_POWERPACK_HOME` at an **empty** directory: the launcher then finds no
`engines.json`, synthesises no `REA_*` at all, and REA sees only the user's own
environment. That is the "before" picture.

```powershell
$env:REA_POWERPACK_HOME = Join-Path $env:TEMP 'rea-powerpack-empty'   # an empty dir = no engine manifest
node dev/verify-mcp.mjs --launcher "<repo>\lib\rea-mcp.mjs" --list-tools
```

```json
{
  "server": { "name": "rea", "version": "6.8.0" },
  "toolCount": 229,
  "available": 42,
  "groups": 77,
  "toolsInAvailableGroups": 110,
  "byReason": {
    "target_required": 11,
    "provider_unavailable": 7,
    "unsupported_host": 13,
    "provider_missing": 4
  }
}
```

This is the same shape REA itself reports through `binary_session` →
`result.tool_availability`.

## 2. With the engine pack (50 / 76 groups)

Unset the override so the launcher reads the real manifest
(`%LOCALAPPDATA%\rea-powerpack\engines.json`):

```powershell
Remove-Item Env:\REA_POWERPACK_HOME -ErrorAction SilentlyContinue
node dev/verify-mcp.mjs --launcher "<repo>\lib\rea-mcp.mjs" --list-tools
```

```json
{
  "toolCount": 229,
  "available": 50,
  "groups": 76,
  "toolsInAvailableGroups": 142,
  "byReason": { "target_required": 11, "unsupported_host": 13, "provider_missing": 2 }
}
```

No extra environment variables are set by hand: the launcher reads the engine
manifest and synthesises `REA_ADB_PATH`, `REA_APKTOOL_COMMAND`,
`REA_JADX_MCP_JAR`, `REA_WABT_BIN_DIRECTORY`, `REA_OBJDUMP_COMMAND`,
`REA_RIZIN_COMMAND`, `REA_ILSPY_CMD_PATH`, `REA_MITMDUMP_COMMAND` plus the
Python/frida `PATH` prefix itself.

Observed on this host: `OK: 229 tools, 50/76 groups available, 142 tools in
available groups`, launcher stderr empty, handshake ~0.45 s.

## What changed

| reason | no engines | with engines |
| --- | --- | --- |
| `provider_unavailable` | 7 | 0 |
| `provider_missing` | 4 | 2 (JEB only) |
| `target_required` | 11 | 11 |
| `unsupported_host` | 13 | 13 |

- The total tool count never changes: **229**.
- The group count drops 77 → 76 because the two JEB-backed groups collapse into
  one surface once JEB is the only missing provider; it is not a capability loss.
- `target_required` groups are healthy — they unblock when a target is opened.
- `unsupported_host` groups are macOS/Linux-only tooling (Apple native utilities,
  tshark, binwalk/unblob, sigrok, pwntools, EVM, wakaru, process capture) and are
  not fixable on Windows.
- `provider_missing` after the pack is **JEB only**, a commercial client that REA
  does not download and this plugin deliberately does not bundle it: set
  `REA_JEB_MCP_URL` if you own one.

## Engine manifest on the host used for these numbers

13 records, all `verified: true` — java 25.0.4, ghidra 12.1.4, adb 37.0.1,
apktool 3.0.3, jadx-headless-mcp 0.7.1, wabt 1.0.42, python 3.12.10, frida 17.24.3,
objdump 2.47, rizin 0.9.1, mitmproxy 12.3.1, dotnet 8.0.414, ilspy 8.2.0.

## Runtime note (Node version)

REA 6.8.0's `rea doctor` wants Node **>= 24.22.1**. Observed on this host:

| runtime | version | doctor |
| --- | --- | --- |
| system Node before upgrade | 24.19.0 | `node missing_dependency` |
| Electron 44.7.0 bundled Node (what `process.execPath` runs) | 24.21.0 | `node missing_dependency` |
| system Node after `winget upgrade OpenJS.NodeJS.LTS` | 24.22.1 | healthy |

All 229 tools worked on every one of those versions; the doctor check is a
version-range assertion, not a functional gate. The launcher therefore re-execs
itself under a suitable system Node when it finds one, and continues with a
warning when it does not.
