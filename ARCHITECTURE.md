# dsh-rea-powerpack — 架构与实现契约 (v0.1.4)

> 这份文档是**实现契约**：三个并行开发者（core / ui / docs+test）按它写代码，不靠口头约定。
> 任何偏离契约的改动必须先在 PR 里改这份文档。

## 1. 目标与非目标

**目标（v0.1）**：把 REA（`rea-agents`，逆向分析 MCP，229 个工具）在 DeepSeek Harness 里做到「Windows 上能开到的最强」：

1. **引擎托管**：检测/一键安装/校验 Windows x64 上可用的分析引擎，并把 `REA_*` 环境变量注入 MCP 子进程——用户不需要改系统环境变量。
2. **能力体检（Doctor）**：直接向 REA MCP 握手，读出 `binary_session` 的 `tool_availability`，把「哪些工具组不可用、为什么、怎么修」翻译成人话。
3. **版本治理**：pin 住 `rea-agents` 精确版本；查新 → 影子目录预检（MCP 握手 + 工具数）→ 精确升级 → 热重载 → 失败自动回滚。
4. **可观测**：Settings 里一张卡片看清「引擎矩阵 / REA 版本 / 能力缺口 / 冲突与重启提示」。

**非目标**：不安装/不内置 Ghidra、IDA、JEB、Hopper（体积与许可），只做「发现 + 说明 + 用外部已有安装」；不做 Linux-only 工具（tshark/binwalk/unblob/sigrok/pwntools/wakaru）的假支持，只在 UI 里标注 `unsupported_host`。

## 2. 包结构

```
rea-powerpack/
├── package.json                # name: dsh-rea-powerpack, dsh.bundle.patch, dsh.client
├── cordis.patch.yml            # 两条 loader 行（本插件 + MCP client）
├── lib/
│   ├── index.js                # 宿主半边：路由 + 编排 + 后台检查（export name/inject/apply）
│   ├── catalog.js              # 引擎目录（纯数据 + 查询函数，无 IO）
│   ├── version.js              # 从 package.json 读出 name/version（唯一版本源）
│   ├── engines.js              # 引擎检测/安装/校验/环境变量合成
│   ├── pin.js                  # 版本 pin、registry 查询、影子预检、升级/回滚
│   ├── reload.js               # MCP 行热重载（带 patch 文件快照护栏）
│   ├── rea-mcp.mjs             # MCP 启动器：合成 env → 解析 pin → 进程内 import rea.mjs
│   └── client.js               # 浏览器半边（lazy-CJS bundle，无构建步骤）
├── docs/                       # ENGINES.md / UPDATES.md / TROUBLESHOOTING.md
├── test/                       # node:test
├── dev/                        # 验收工具链（gate/acceptance/http-probe/verify-mcp/install-plugin；只随仓库分发）
└── ARCHITECTURE.md
```

## 3. 状态文件（全部在 powerpackHome 下，绝不写用户 `cordis.patch.yml`）

`powerpackHome(profileDir)` = `process.env.REA_POWERPACK_HOME` 或 `%LOCALAPPDATA%\\rea-powerpack`（Linux/macOS 用 `$XDG_STATE_HOME`/`~/Library/Application Support`）。**不放 profile 里**：引擎是机器级资产，多个 profile 共用。

- `engines.json` — `{ "version": 1, "root": "<abs>", "updatedAt": ISO, "engines": EngineRecord[] }`
  `EngineRecord = { id, name, tier, version, path, envVar, pathPrepend, sha256, verified, rawVersionOutput, extraEnv?, installedAt, source }`
- `settings.json` — `{ "updatePolicy": "notify"|"auto-idle"|"manual", "toolTimeoutMs": 900000, "checkIntervalHours": 6, "engineRoot": null|"<abs>", "locale": "auto"|"zh"|"en" }`
- `pin.json` — `{ version, requested, pinnedAt, pinnedFrom: "cli"|"ui"|"update"|"preflight", retained: {from, at}|null, withheldBuilds: string[], latestKnown: string|null, checkedAt: string|null }`
  （与 dsh-rea-agents 的 pin.json 同构，便于迁移：`POST /import-pin` 可读旧文件）
- `state.json` — `{ lastDoctor: {at, serverVersion, toolCount, availableGroups, totalGroups, topGaps}, lastReload: {at, ok, mode, reason} }`
- `logs/powerpack.log` — 追加 JSONL：`{at, level, event, detail}`，**不记录任何密钥/令牌值**

## 4. HTTP API 契约（loopback only，前缀 `/rea-powerpack`）

非 loopback 请求一律 `403 {ok:false,error:{code:'loopback_only'}}`；未知路由 `404 {code:'not_found'}`。
**错误码是稳定枚举**，文案在客户端 i18n 里翻译：

```
loopback_only not_found bad_json bad_request profile_unwritable no_engine
unknown_engine install_failed download_failed checksum_mismatch unsupported_host
requires_dependency registry_timeout registry_unreachable no_such_version
preflight_failed rollback_failed reload_failed pin_conflict rea_missing
```

| 方法 | 路径 | 请求 | 响应（成功） |
|---|---|---|---|
| GET | `/state` | — | `{ self:{name,version}, profileDir, writable, rea:{installed,pinned,requested,pinnedAt,pinnedFrom,source,latestKnown,checkedAt,retained:{from,at}|null,enginesWarning}`, `engines:[EngineStatus]`, `settings:{updatePolicy,engineRoot}`, `mcp:{rowId,present,disabled}`, `conflict:{kind,detail}|null`, `doctor:{stale,lastAt,toolCount,availableGroups,totalGroups}`, `host:{platform,node,javaHome,ghidraDir}`, `catalogVersion`, `patch:{…}`, `lastOps:[{at,level,event,detail}]` }` |
| POST | `/check` | — | `{ latest, checkedAt, policy }` |
| POST | `/update` | `{version?}` | `{ ok, from, to, preflight:{serverVersion,toolCount}, reload:{ok,mode:'hot'|'restart-required',reason?} }` |
| POST | `/pin` | `{version}` | 同 /update |
| POST | `/settings` | 部分 settings | `{ ok, settings }` |
| POST | `/engines/verify` | — | `{ ok, engines:[EngineStatus] }` |
| POST | `/engines/install` | `{id}` | `{ ok, engine:EngineStatus }` |
| POST | `/engines/uninstall` | `{id}` | `{ ok, engines }` |
| POST | `/engines/import` | `{path}` | `{ ok, imported, engines }` |
| GET | `/doctor` | — | `{ at, serverVersion, toolCount, availableGroups, totalGroups, gaps:[{reason,remedy,count,tools[]}] }` |
| POST | `/reload` | — | `{ ok, mode, reason?, restoredPatch:boolean }` |
| POST | `/import-pin` | `{path?}` | `{ ok, pin }` |
| GET | `/report` | — | `text/markdown; charset=utf-8` 诊断报告 |

`EngineStatus = { id, name, tier, status, version, path, envVar, remedy, installable, managed, probeOutput?, docs?, notes? }`（`installable`=本插件能否替用户装，`managed`=装在 powerpackHome 下而非外部）
`status ∈ ok | missing | broken | unsupported_host | requires_dependency | external_ok | external_missing`

## 5. 模块导出契约（签名固定）

### lib/catalog.js
```js
export const CATALOG_VERSION = 1
export const ENGINES = [EngineSpec, ...]
export function byId(id): EngineSpec | undefined
export function forPlatform(platform, host): EngineSpec[]   // 过滤 platform 不匹配的
```
`EngineSpec = {
  id, name, tier: 0|1|2, platforms: ['win32'], envVar: 'REA_ADB_PATH'|null,
  envKind: 'file'|'dir'|null, pathPrepend: boolean, requires?: ['java'],
  probe: { exe, args: string[], match?: string } | null,
  install: null | { kind:'zip'|'file'|'github-latest'|'winget'|'pip',
                    url?, urlTemplate?, latestUrl?, sha256?, dest?, stripRoot?,
                    wingetId?, pipArgs?, post?: 'apktool-wrapper' },
  docs?: string, notes?: string, hostUnsupported?: 'linux'|'darwin'
}
```

首批条目（**必须的真实事实，不许编造 URL 之外的东西**）：

| id | tier | envVar | 安装 | 备注 |
|---|---|---|---|---|
| java | 0 | `JAVA_HOME`(external) | 无（探测） | 需含 `jdk.compiler` |
| ghidra | 0 | `GHIDRA_INSTALL_DIR`(external) | 无（探测） | 用户自装 |
| adb | 1 | `REA_ADB_PATH` | zip: `https://dl.google.com/android/repository/platform-tools-latest-windows.zip` → dest `platform-tools`, stripRoot | 解锁 31 个 adb 工具 |
| apktool | 1 | `REA_APKTOOL_COMMAND` | github-latest: repo `iBotPeaches/Apktool`, asset `apktool_{ver}.jar` → dest `apktool/apktool.jar` + post `apktool-wrapper`（生成 apktool.cmd） | 需 java |
| jadx | 1 | `REA_JADX_MCP_JAR` | file: `https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar`, sha256 `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75` → dest `jadx/jadx-headless-mcp-0.7.1-all.jar` | REA 审计版本，校验不过必须拒绝 |
| wabt | 1 | `REA_WABT_BIN_DIRECTORY` | zip: `https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-windows-x64.zip` → dest `wabt`, stripRoot | 版本必须 1.0.42 |
| frida | 1 | null（PATH） | pip: `frida-tools`（用受管 python） | pathPrepend |
| python | 1 | null | winget: `Python.Python.3.12` | 供 pip 类引擎 |
| objdump | 2 | `REA_OBJDUMP_COMMAND` | null（探测 Git/llvm） | |
| rizin | 2 | `REA_RIZIN_COMMAND` | github-latest zip | |
| dotnet | 2 | null | winget: `Microsoft.DotNet.SDK.8` | 供 ilspy |
| ilspy | 2 | `REA_ILSPY_CMD_PATH` | 通过 `dotnet tool install -g ilspycmd` | requires dotnet |
| mitmproxy | 2 | `REA_MITMDUMP_COMMAND` | pip: `mitmproxy` | requires python |

**Windows 上明确 unsupported_host（不要提供安装按钮，只解释）**：`tshark/capinfos`（pcap 抓包）、`binwalk/unblob`（固件）、`sigrok-cli`（信号）、`pwntools`（ELF/core）、`wakaru`（JS 反混淆）、`process-capture`。catalog 里以 `hostUnsupported:'win32'` + `notes` 形式存在，`forPlatform` 保留它们以便 UI 解释。

### lib/version.js
```js
export const PACKAGE_NAME: string      // "dsh-rea-powerpack"
export const PACKAGE_VERSION: string   // package.json version
```
唯一版本源：`/state.self`、引擎下载 User-Agent、MCP 握手 `clientInfo` 全部读这里，**禁止**在代码里写字面量版本号（改版本只动 `package.json`）。

### lib/engines.js
```js
export function powerpackHome(profileDir): string
export function engineRoot(home, settings): string
export async function readManifest(home): {version,root,engines}
export async function writeManifest(home, manifest): void
export async function detect(home, settings): EngineStatus[]        // 不写盘
export async function verifyAll(home, settings): EngineStatus[]     // 探测+写回 manifest
export async function installEngine(home, settings, id, log): EngineStatus
export async function uninstallEngine(home, id): EngineStatus[]
export async function composeEnv(home, settings): { env, pathPrepend, missing }
```
`composeEnv` 规则（**测试必须覆盖**）：
1. `extraEnv` 先铺（如 `JAVA_HOME`），然后 `envVar`（file → 绝对路径；dir → 目录），都来自 manifest 里 `verified:true` 的记录；
2. `pathPrepend` 收集所有 `pathPrepend:true` 记录的父目录，顺序 = manifest 顺序，**去重**；
3. `missing` 列出 catalog 中 tier≤1 但未 verified 的 id（启动器据此只 warn，不阻断）；
4. 不覆盖用户已显式设置的同名 `REA_*`（用户优先，记录在 `env.REA_POWERPACK_OVERRIDES`）。

### lib/pin.js
```js
export async function readPin(home): Pin
export async function writePin(home, patch): Pin
export function compareVersions(a, b): -1|0|1        // semver 含 prerelease
export function decideUpgrade({pinned, latest, policy, runningTurns}): {action, reason}
export async function lookupLatest(profileDir, exec, opts): {latest}   // pnpm view rea-agents version，60s 超时，错误分类
export async function probeServer(profileDir, opts): {serverInfo, toolCount, toolNames}  // 握手：initialize→tools/list 分页
export async function upgradeRea(home, profileDir, version, {exec, log}): UpgradeResult
export async function rollback(home, profileDir, {exec, log}): void
```
`upgradeRea` 流程：**影子预检 → 升级 → 握手复验 → 失败回滚**（不可跳过）：
1. `staging/<version>/` 建最小 `package.json`，`pnpm add rea-agents@<ver> --save-exact`（同 profile 的 registry/.npmrc 设置，`--config.minimum-release-age-exclude` 仅在用户显式 `acceptFresh` 时使用）；
2. 用 staging 副本跑 `probeServer`（15s inline: 直接 spawn `node staging/node_modules/rea-agents/scripts/rea.mjs mcp`）；
3. 通过后 `promoteVersion`（profile 内 `pnpm add --save-exact rea-agents@<ver>`）；
4. 再 `probeServer(profile)`；失败 → `pnpm add rea-agents@<retained.from>` 回滚 + 报 `rollback_failed`/`preflight_failed`；
5. 清理 staging（保留最近 1 份供排错）。
`toolCount` 期望：`>= 200`（低于则视为预检失败），并记录 `serverInfo.version === <ver>`。

### lib/reload.js
```js
export async function reloadMcpRow(ctx, rowId, opts): {ok, mode:'hot'|'restart-required', reason?, restoredPatch}
```
规则：先快照 `<profile>/cordis.patch.yml` 字节 + mtime → `ctx.loader.update(rowId,{disabled:true})` → `ctx.loader.update(rowId,{disabled:false})` → 等 ≤15s 观察 `internal/plugin` 事件里该 row 的 fiber 重建 → 复检 patch 字节，若被 loader 改动则写回快照（`restoredPatch:true`）。任何一步失败 → `{ok:false, mode:'restart-required'}`，绝不谎报热重载成功。

### lib/rea-mcp.mjs
argv: `<profileDir> mcp`。行为：`powerpackHome()` → `composeEnv` → 应用到 `process.env` → `createRequire(profileDir/package.json).resolve('rea-agents/scripts/rea.mjs')` → `process.argv` 改写 → `await import(pathToFileURL(resolved))`。
- pin 缺失：stderr 打印 `rea-powerpack: rea-agents is not installed in <profile>; open Settings → REA Powerpack → Install` 并 exit 1；
- 引擎缺失：stderr 一行 warn（`rea-powerpack: N tier-1 engines missing (adb, apktool); their tools will report provider_unavailable`），**继续启动**；
- `REA_POWERPACK_TRACE=1`：stderr 打印合成后的 env **键名**（不打印值）。
- 入口守卫 `isEntryPoint(argv, selfPath)` 必须做**真实路径**比较：宿主通过 profile 的 `node_modules/dsh-rea-powerpack`（pnpm `link:` junction）启动时，`process.argv[1]` 是软链路径而 `import.meta.url` 被 Node 解析成真实路径，纯字符串比较会静默 no-op（进程 exit 0、无输出，MCP 端表现为启动超时）。实现：先比 `resolve()`，不等再 `realpathSync()`，**两侧都 toLowerCase()** 后比较。
- Node 版本不足 `rea-agents.engines.node` 时（Desktop 的 Electron-as-node 24.21 < 24.22）自动 re-exec 到满足要求的 `node.exe`，用 `REA_POWERPACK_EXEC=1` 防重入，stderr 打一行说明。

### lib/index.js
```js
export const name = 'dsh-rea-powerpack'
export const inject = ['webServer']
export function apply(ctx) { ... }
export default { name, inject, apply }
```
- 路由注册：`ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/rea-powerpack', handler}))`
- row 状态：`ctx.loader?.entries?.()`（**cordis 里是 generator**，必须 `Array.from` 物化；`Array.isArray` 判空会让 /state 永远 present:false、/reload 永远 restart-required）；`Entry.id` 带父前缀（`parentId:childId`），匹配要允许 `endsWith(':'+id)`；`Entry.disabled` 是 getter（会求值 `!!js`），取值必须 try/catch。以此找 `rea-powerpack-mcp`；`conflict`：若同时存在 `rea-agents-mcp`（dsh-rea-agents）→ `{kind:'server_name_conflict', detail:'dsh-rea-agents'}`
- 后台任务：`setInterval`（`ctx.effect` 清理）按 `checkIntervalHours` 查新；`updatePolicy:'auto-idle'` 时**只在最近 10 分钟无活动**才升级——用 `ctx.get('agentLoop')`/session 活动时间不可靠，v0.1 判定规则简化为：距上次 `/state` 或任何 API 调用 >10 分钟且 `now - lastReload > 10min`；不满足则只置 `latestKnown` 并发通知。
- 所有 pnpm 调用走 `execFile`，`cwd = profileDir`，`maxBuffer = 16MB`，超时 `INSTALL_TIMEOUT_MS = 15min`；不得使用 `shell:true`。

## 6. cordis.patch.yml 契约（core 负责，语义不得改）

```yaml
- insert:
    - id: rea-powerpack
      name: dsh-rea-powerpack
    - id: rea-powerpack-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: !!js "process.execPath"
        args: !!js "(() => { const profile = process.env.DSH_PROFILE_DIR || ctx.dshHomePath('profiles', process.env.DSH_PROFILE || 'desktop'); return [profile + '/node_modules/dsh-rea-powerpack/lib/rea-mcp.mjs', profile, 'mcp']; })()"
        env:
          ELECTRON_RUN_AS_NODE: '1'
        toolCallTimeoutMs: 900000
        failOnStartupError: false
```
理由：`serverName: rea` 保住 `mcp__rea__*` 前缀；`toolCallTimeoutMs` 提高到 15 分钟（Ghidra 反编译远程大二进制默认 60s 必超时）；id 用 `rea-powerpack-mcp` 与 `dsh-rea-agents` 的 `rea-agents-mcp` 区分，互不覆盖。

## 7. 客户端 UI 契约（ui 负责）

- 文件：`lib/client.js`，lazy-CJS：`window.__ModuleLoader__.load({ id:'dsh-rea-powerpack', factory:(require)=>{...} })`，只依赖 `require('react')`。
- 座位：DSH 设置页的插件 tab —— slot `settings.plugins.tab`。注册形状：
  ```js
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'dsh-rea-powerpack', order: 20,
    label: () => hostT('tab'), locale: NS, inject: () => ({ powerpackT: hostT }),
  }, PowerpackTab))
  ```
  `exports = { name, NS, inject: ['slots','locale'], apply }`；`dsh.client.inject` 必须列 `@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-locale`。
  第一行是概览摘要（如「引擎 9/13 · REA 6.8.0 · 50/76 组」），下面是完整面板。
- 分区顺序：**① 概览行 → ② 引擎矩阵 → ③ REA 版本与更新 → ④ 能力体检 → ⑤ 维护（热重载/导入 pin/导出报告）**。
- 交互必须给出三态：进行中（按钮 disabled + 文案）、成功（具体数字/版本）、失败（`error.code` 翻译 + 可展开 detail）。
- i18n：client 自带 `DICT = { zh: {...}, en: {...} }`，key 集合必须完全一致（test 会校验）。语言选择：跟随界面 + 下拉 zh/en，存 localStorage `rea-powerpack.locale`。
- 严禁直接 fetch 非 `/rea-powerpack` 前缀的路由；严禁在浏览器里拼 pnpm 命令。

## 8. 测试与 CI（docs+test 负责，core 必须让其通过）

- `node --test "test/*.test.mjs"`，覆盖：catalog 完整性 / manifest 往返 / composeEnv 顺序与去重 / 用户 env 优先 / compareVersions（含 `6.8.0-rc.1`）/ decideUpgrade 决策矩阵 / pin.json 往返 / 握手输出解析 / HTTP 路由（fake ctx）/ client bundle 语法与 DICT 对齐 / docs 里的命令与 package.json scripts 一致。
- CI：Node 22 与 24 矩阵，`npm test` + `npm run lint`。
- 所有测试**不得联网、不得调用 pnpm、不得写用户目录**（用 `os.tmpdir()`）。
- `node dev/gate.mjs --full`（仓库内，不进 npm 包）一次跑完跨切面验收 + HTTP 路由探针 + 单测；实测基线与复现命令见 `dev/BASELINES.md`。

## 9. 版本与发布

- `0.1.0` 首发；`0.1.1` 修复版（launcher junction 入口守卫、loader generator 物化、patch row id 常量、安装脚本依赖丢失）；`0.1.2` 验收工具链入库 + 文档对齐真机（无运行时代码变更）；`0.1.3` `composeEnv` 增加可注入 platform，CI 矩阵覆盖 Windows 目标平台 + Linux 纯逻辑腿。`0.1.4` 文档对齐「已发布到 npm」（README 安装段 npm 优先 + 徽章 + 维护段），无运行时代码变更。语义化：新增引擎=minor，修复=patch，破坏契约=major。
- 发布：源码仓库 `github.com/Zhishulo/dsh-rea-powerpack`（public，CI 4 腿全绿，tag `v0.1.3`）。npm：`registry.npmjs.org/dsh-rea-powerpack` 已发布（首版 `0.1.3`，用 granular access token + bypass 2FA）。安装走包名：桌面版 UI 填 `dsh-rea-powerpack`，web/tui `dsh plugin --profile web add dsh-rea-powerpack`（CLI 实际转发 pnpm）。发布后约 90 秒 packument 才可见，期间重发会得到 `409 Cannot publish over previously staged version`，属正常。
