# DSH market listing — submission record

Status: **MERGED — the plugin is listed in the DSH market catalog.**

| item | value |
| --- | --- |
| PR | [awesome-dsh-plugin/awesome-dsh-plugin\#10097](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10097) |
| title | `Add Zhishulo/dsh-rea-powerpack` |
| head commit | `77e31ba015e8ec0c9dc280d35d620ca0c353a2e3` (fork `Zhishulo:main`) |
| base commit | `0b3d3606b217699e7097a3c4d531bb90c6c3887c` (upstream `main` at submission time) |
| diff | 1 file, +6 / -0 |
| check run | [40666578481](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/40666578481) — `PR check`, 15/15 steps success |
| **merged** | **2026-10-28T17:10:09Z** by `fkysly`, merge commit `257fe42239` |
| live entry | `data/plugins/Zhishulo__dsh-rea-powerpack.yml` (sha `e13a001ea5`) |
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

## Timeline

- `2026-10-28T09:44Z` — PR opened, `PR check` queued.
- `2026-10-28T10:05Z` — `PR check` finished: 15/15 steps success; `Submission gate` success as well.
- `2026-10-28T17:10Z` — merged by a maintainer (about 7.5 h after opening).
- Upstream merged with no review comments and no requested changes; the entry file was merged byte-identical.

While waiting, the PR stayed `mergeable_state: clean` with an unmoved base (`0b3d360`), so no rebase was ever needed. Note that the upstream repo was in a merge pause during that window — `main` had last advanced at `2026-10-27T20:20Z` and ~370 PRs were queued — so a multi-hour wait is normal and not a signal about the submission.

## Live listing (verified 2026-10-30)

The catalog site finished rebuilding and now serves the entry in `plugins.json` (7,723 entries at the time of the check):

```json
{
  "name": "dsh-rea-powerpack",
  "owner": "Zhishulo",
  "url": "https://github.com/Zhishulo/dsh-rea-powerpack",
  "page": "https://awesome-dsh-plugin.com/p/Zhishulo/dsh-rea-powerpack/",
  "category": "tools",
  "npm": "dsh-rea-powerpack",
  "version": "0.1.4",
  "capabilities": ["shell", "fs-write", "fs-read", "network", "env"],
  "capabilityRedLines": [],
  "install": "dsh plugin --profile web add dsh-rea-powerpack",
  "added": "2026-10-28"
}
```

So installs now work through the catalog path (`dsh plugin --profile <name> add dsh-rea-powerpack`) as well as through the desktop UI's plugin market. The `downloads` counter in that payload is a registry figure refreshed daily, not an install count from this project.

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

This section is kept for reference only — the listing is live, so no further action is needed unless the entry has to be updated later. For a future entry edit, branch from current upstream `main` instead of resurrecting the old fork state, and re-run the pre-flight duplicate check before opening a PR.

Approximate upstream cadence at submission time: ~10 PRs per 45 minutes, merged by a human after review, so a quiet PR for a few hours is normal.

## Related

- Engine matrix and capability numbers: [../ARCHITECTURE.md](../ARCHITECTURE.md)
- Release history: [../CHANGELOG.md](../CHANGELOG.md)
