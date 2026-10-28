# DSH market listing — submission record

Status: **PR open, CI green, awaiting maintainer review.**

| item | value |
| --- | --- |
| PR | [awesome-dsh-plugin/awesome-dsh-plugin#10097](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10097) |
| title | `Add Zhishulo/dsh-rea-powerpack` |
| head commit | `77e31ba015e8ec0c9dc280d35d620ca0c353a2e3` (fork `Zhishulo:main`) |
| base commit | `0b3d3606b217699e7097a3c4d531bb90c6c3887c` (upstream `main` at submission time) |
| diff | 1 file, +6 / -0 |
| check run | [40666578481](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/40666578481) — `PR check`, 15/15 steps success |
| plugin version submitted | 0.1.4 (published on npm) |

## Entry file

`data/plugins/Zhishulo__dsh-rea-powerpack.yml` (exactly one directory level deep, as the path test requires):

```yaml
url: https://github.com/Zhishulo/dsh-rea-powerpack
name: Zhishulo/dsh-rea-powerpack
category: tools
description:
  en: "Installs and verifies the reverse-engineering engines REA needs on Windows (Ghidra, JADX, apktool, adb, WABT, frida and more), pins the rea-agents MCP server version, and reports capability gaps in a settings card."
  zh: "在 Windows 上安装并校验 REA 所需的逆向引擎（Ghidra、JADX、apktool、adb、WABT、frida 等），固定 rea-agents 的 MCP 服务版本，并在设置卡片里体检能力缺口。"
```

Notes: only `description.en` is mandatory upstream; a value containing `: ` must be quoted (both of ours are); the generated READMEs are never edited by hand.

## Why the fork was fast-forwarded first

The fork was `ahead 1 / behind 369` when the entry was prepared. `pr-check.yml` contains a **Stale-fork guard**: a PR that deletes more than two existing `data/plugins/*.yml` files, and more deletions than additions, fails. A stale fork silently deletes entries that landed upstream after it forked. So the fork's `main` was reset to upstream `main`, and only then was the single entry file added:

```
PATCH /repos/Zhishulo/awesome-dsh-plugin/git/refs/heads/main   {"sha": "<upstream main>", "force": true}
PUT   /repos/Zhishulo/awesome-dsh-plugin/contents/data/plugins/Zhishulo__dsh-rea-powerpack.yml
```

Resulting compare: `ahead 1 / behind 0`, one file changed.

## Pre-flight checks that were run

- `GET /repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/Zhishulo__dsh-rea-powerpack.yml` → 404 (not already listed).
- `GET /search/code?q=repo:awesome-dsh-plugin/awesome-dsh-plugin+Zhishulo/dsh-rea-powerpack` → `total_count: 0` (no duplicate entry).
- Repository age ≥ 1 day (upstream requirement), `dsh-plugin` topic present (9 topics total).
- `dsh.bundle` is declared in this package's `package.json`, so the directory is a real DSH bundle, not just a CLI wrapper.

## How to monitor / unblock

```bash
# PR state (state, merged, mergeable_state, labels)
curl -sS -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls/10097

# CI for the submitted head commit — use the FULL sha, a short sha returns 0 runs
curl -sS -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs?head_sha=77e31ba015e8ec0c9dc280d35d620ca0c353a2e3'
```

If upstream `main` advances so far that the PR turns `mergeable_state: dirty`, or `PR check` goes red because the generated READMEs changed, refresh the fork again (`PATCH .../git/refs/heads/main` with the new upstream sha), re-add the entry file on top, and push. The entry content itself does not need to change.

Approximate upstream cadence at submission time: ~10 PRs per 45 minutes, merged by a human after review, so a quiet PR for a few hours is normal.

## Related

- Engine matrix and capability numbers: [../ARCHITECTURE.md](../ARCHITECTURE.md)
- Release history: [../CHANGELOG.md](../CHANGELOG.md)
