# dsh-rea-powerpack

> 把 REA 在 Windows 上做到最强：**补齐分析引擎、固定 MCP 版本、体检能力缺口**，
> 并在 DSH 设置里用一张卡片把这一切说清楚。

[REA](https://github.com/deepseek-ai/rea-agents) 是逆向分析 MCP 服务器：原生二进制、
托管代码、Electron/JavaScript、固件、浏览器目标都能拆。但它只是**适配层**——
Ghidra、JADX、WABT、frida 这些引擎得在这台机器上真的能跑。

dsh-rea-powerpack 干三件事：

1. **引擎**：按矩阵检测 / 安装 / 卸载分析引擎，合成 `env` 与 `PATH` 喂给 REA；
2. **版本**：把 `rea-agents` 精确固定，检查新版、影子预检、可回滚；
3. **体检**：调用 REA 的 doctor，把「缺什么、为什么缺、怎么修」按 reason 分组列出来。

## 亮点

- **一张卡片说清全部状态**：REA 版本、pin 来源、引擎就绪数、最近体检、更新策略，
  以及每个引擎的 tier / 版本 / 状态徽章 / 动作按钮。
- **安装即校验**：带 sha256 的引擎强制校验，半装状态不进清单、不进环境变量。
- **用户设置优先**：你手动设的 `REA_*` 环境变量永远赢，被保留的变量名会列出来。
- **更新不赌运气**：新版本先在影子目录里握手体检（serverInfo 版本 + 工具数 ≥ 200），
  通过了才进配置档；进配置档后复检失败自动回滚，坏版本进 `withheldBuilds`。
- **失败可解释**：所有错误走稳定错误码 + 中英双语文案；未知码原样显示，不吞。
- **无构建步骤**：浏览器半边是 lazy-CJS（`window.__ModuleLoader__.load`），
  只用 React + 内联样式，配色跟随宿主主题变量。

## 装好之后，REA 变成什么样（本机实测）

数字来自本机握手探针（`dev/verify-mcp.mjs` → `dev/.v2.json`，REA 6.8.0，
Java 25 + Ghidra 12.1.4 + 托管引擎就位）：

| 指标 | 实测值 | 说明 |
| --- | --- | --- |
| MCP 工具总数 | **229** | 装引擎不改变工具清单，改变的是「哪些组真的能用」 |
| 可用工具组 | **50 / 76** | 剩余 26 组：11 组要先 `open_binary`（`target_required`）、13 组本平台不支持（`unsupported_host`）、2 组缺 JEB（`provider_missing`）|
| 可用组内工具 | **142** | doctor 的 `toolsInAvailableGroups` |
| 引擎就绪 | **11 / 13** | 13 个 Windows 可用项；另 8 个引擎 REA 本身不支持 Windows |
| 握手耗时 | **约 0.5 s** | `initialize` + 分页 `tools/list` |

**无引擎基线**（同一台机器、未注入任何 `REA_*`，裸启动 REA）：
**42 / 77** 组可用，按 reason 分布 `target_required` 11 / `unsupported_host` 13 /
`provider_unavailable` 7 / `provider_missing` 4。注入托管引擎后：
`provider_unavailable` **7 → 0**，`provider_missing` **4 → 2**（只剩 JEB，商业软件不预装）。
组数 77 → 76 是 JEB 相关两个组在注入后合并了一组，**工具总数始终是 229**。

复现基线：

```bash
node dev/verify-mcp.mjs --launcher "<profile>/node_modules/dsh-rea-agents/lib/rea-mcp.mjs"
```

产物见 `dev/baseline-no-engines.json`（含命令、时间戳与完整 unavailable 列表）。

一句话：powerpack **不扩充 REA 的能力清单，而是让清单里"本该能用"的组真的可用**：
引擎类 provider 缺口由矩阵补齐；剩下的缺口被逐条解释成「先开目标 / 本平台不支持 /
缺某个 provider」，而不是一句"工具不可用"。JEB 不在引擎矩阵内，需要自备 JEB 客户端。

## 安装

要求 **Node >= 22.19.0**（REA 自身要求），DSH 桌面版 / web / tui 均可。

- **Desktop（推荐）**：侧栏 **插件 → 添加** → 填来源 → 安装。
  Desktop 的 profile 由 Electron 独占管理，`dsh plugin --profile desktop` 会被拒绝，
  这是 DSH 的硬约束。
- **web / tui**：

  ```bash
  dsh plugin --profile web add dsh-rea-powerpack          # npm 包
  dsh plugin --profile web add file:D:/path/to/rea-powerpack  # 本地开发（link）
  dsh plugin --profile web ls                            # 确认已装
  ```

装完重启 DSH。插件会向 `cordis.patch.yml` 注入两行：
`dsh-rea-powerpack`（卡片宿主）与 `rea-powerpack-mcp`（名为 `rea` 的 MCP 服务）。

> 插件**不安装分析引擎以外的任何东西**，也不会改写你的全局环境变量或注册表。

## 首次配置

1. **打开卡片**：设置 → 插件 → **REA 强化** tab。
2. **装 REA 本体**：卡片会显示「未安装」；点「安装」按当前 registry 最新版精确定装
   （`pnpm add rea-agents@x.y.z --save-exact`）。
3. **装引擎**：概览会告诉你「引擎就绪数 x/y」。先在矩阵里装 tier 0/1
   （Java、Ghidra → adb、apktool、jadx、wabt、python、frida）。
   依赖顺序见 [docs/ENGINES.md](docs/ENGINES.md#5-安装顺序与依赖)。
4. **跑一次体检**：「能力体检 → 运行体检」，确认 REA 实际暴露的工具数（正常 ≥ 200）。
5. **选更新策略**：默认 `notify`（只提示）。想随时跟进可改 `auto-idle`。

## 状态目录与引擎目录

状态目录默认 `%LOCALAPPDATA%\rea-powerpack`（`REA_POWERPACK_HOME` 可覆盖），
卡片里的「维护」区会显示当前真实路径：

| 文件 | 内容 |
| --- | --- |
| `engines.json` | 引擎清单：每个引擎的 `path`/`version`/`verified`，以及 `root` |
| `settings.json` | `updatePolicy`、`engineRoot`、`toolTimeoutMs`、`checkIntervalHours`、`locale` |
| `pin.json` | 当前固定的 REA 版本、pin 来源、可回滚的上一版、被拒版本 `withheldBuilds` |
| `state.json` | 最近一次体检与最近一次热重载的结果（卡片"最近体检时间"读它） |
| `logs/powerpack.log` | JSONL 日志：每次安装/校验/升级/回滚/重载一条 |

引擎默认装在 `...\rea-powerpack\engines\<id>\`；在设置里改 `engineRoot` 可换盘。
**移动或删除引擎目录后**，点一次「全部校验」，卡片会把对应行标成 `missing`，
不会继续引用一个不存在的路径。

## 引擎矩阵

| id | 名称 | tier | 环境变量 | 安装 |
| --- | --- | --- | --- | --- |
| `java` | Java (JDK) | 0 | `JAVA_HOME` | 手动（外部） |
| `ghidra` | Ghidra | 0 | `GHIDRA_INSTALL_DIR` | 手动（外部） |
| `adb` | Android Platform Tools | 1 | `REA_ADB_PATH` | 托管 zip |
| `apktool` | Apktool | 1 | `REA_APKTOOL_COMMAND` | 托管 github-latest |
| `jadx` | JADX headless MCP | 1 | `REA_JADX_MCP_JAR` | 托管 file（sha256） |
| `wabt` | WABT | 1 | `REA_WABT_BIN_DIRECTORY` | 托管 zip |
| `python` | Python 3.12 | 1 | PATH | 托管 winget |
| `frida` | Frida tools | 1 | PATH | 托管 pip |
| `objdump` | GNU objdump | 2 | `REA_OBJDUMP_COMMAND` | 手动（外部） |
| `rizin` | Rizin | 2 | `REA_RIZIN_COMMAND` | 手动（外部） |
| `dotnet` | .NET SDK 8 | 2 | PATH | 托管 winget |
| `ilspy` | ilspycmd | 2 | `REA_ILSPY_CMD_PATH` | 手动（外部） |
| `mitmproxy` | mitmdump | 2 | `REA_MITMDUMP_COMMAND` | 托管 pip |

另有 8 个 **REA 不支持 Windows** 的引擎（tshark、capinfos、binwalk、unblob、
sigrok、pwntools、wakaru、process-capture）：卡片会以 `unsupported_host` 明确列出，
不提供安装按钮，避免装了个用不上的东西。

对应的 Windows 不可用能力（doctor 会按 `unsupported_host` 归组）：

| 能力 | 平台 | 说明 |
| --- | --- | --- |
| Mach-O / plist / Interface Builder / asset catalog / keyed archive、macOS 原生 UI 截取与调用 | macOS | 依赖 Xcode 与系统框架 |
| 固件提取（Binwalk / Unblob）、信号解码（sigrok）、pwntools 核心检查 | Linux | 依赖 Linux 工具链与 `prlimit` |
| pcap 抓包解析（tshark / capinfos） | Linux（Windows 走 Wireshark 自带工具，不在矩阵内） | REA 需要显式指定二进制 |
| JavaScript 反混淆恢复（Wakaru） | Linux x64 | — |
| 进程捕获 `capture_process_scenario` | Linux / macOS | Windows 无 PTY 捕获面 |
| JEB 反编译 | 任意（需自备 JEB 客户端） | 不属于引擎矩阵，卡片标 `provider_missing` |

完整矩阵、状态语义与合成规则见 [docs/ENGINES.md](docs/ENGINES.md)。

## 更新与回滚

- **检查**：走配置档自己的 registry，只读，不改 pin。
- **升级**：影子目录安装 → 影子体检（版本 + 工具数）→ 正式安装 → 复检 → 固定。
  失败自动回滚；坏版本进 `withheldBuilds`。
- **回滚**：回到 `pin.retained.from`；回滚同样体检。
- **自动策略**：`notify` / `auto-idle` / `manual`，忙碌时不会自动动。
- **热重载**：能热就热（`mode: hot`），不能就明说 `restart-required`。

细节、决策矩阵、离线行为见 [docs/UPDATES.md](docs/UPDATES.md)。

## 日常维护：升级、卸载、重启

- **升级插件本体**：桌面版在 插件页 对该插件点更新；web/tui 用同一条
  `dsh plugin --profile web add dsh-rea-powerpack` 刷新版本。
- **卸载插件**：桌面版在 插件页 移除；web/tui
  `dsh plugin --profile web remove dsh-rea-powerpack`。
  移除后 `cordis.patch.yml` 里的两行（宿主 + MCP）随之失效，不会留下半个服务。
- **重启 DSH**：改了 MCP 行（引擎/版本/超时）后先点「维护 → 热重载 MCP 行」，
  成功会显示 `mode: hot`；显示 `restart-required` 时再重启 DSH。
  插件代码自身更新（`lib/*.js`）必须重启 DSH，模块表在启动时构建。
- **清理**：卸载插件**不会**删除引擎与状态目录（那是你花时间装的东西）。
  要彻底清掉，手动删除 `%LOCALAPPDATA%\rea-powerpack` 即可。

## 故障排查

先看 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)：里面有 20 个错误码的
含义与处理方式，以及「卡片不出现」「引擎 broken」「体检与引擎不一致」等场景。
维护区还能一键**导出诊断报告**（Markdown）和**复制体检报告**。

## 导出诊断报告

| 想要 | 入口 | 拿到什么 |
| --- | --- | --- |
| 体检缺口 | 能力体检 → **复制报告** | `GET /doctor` 的 JSON：按 `reason` 分组、`remedy`、工具名列表 |
| 完整诊断 | 维护 → **导出诊断报告** | `GET /report` 的 Markdown：state 快照、引擎矩阵、pin、最近体检与重载、最近日志 |
| 原始引擎清单 | 打开状态目录里的 `engines.json` | 每个引擎的 path/version/verified |
| 完整日志 | `%LOCALAPPDATA%\rea-powerpack\logs\powerpack.log` | JSONL，一行一个事件 |

报告里**没有**你的源码、密钥或分析目标内容；它只有引擎路径、版本号、pinning 状态
和 doctor 的缺口摘要，可以直接贴进 issue。

## 隐私与安全

- **只监听 loopback**：`/rea-powerpack/*` 只接受 `127.0.0.1` / `::1`，
  其他来源一律 `403 {code:"loopback_only"}`（`test/http.test.mjs` 守着这条）。
- **卡片不联外网**：浏览器半边只有一个 `fetch` 调用点，且只能拼 `/rea-powerpack/*`
  前缀；没有外部 origin、没有 CDN、没有遥测（`test/client-bundle.mjs` 断言）。
- **唯一的出网行为**：① 检查/升级 REA 时读取配置档自己的 pnpm registry 元数据；
  ② 安装托管引擎时从 `lib/catalog.js` 里写死的官方 URL 下载（jadx 带 sha256 强校验；
  没有官方校验和的下载项会在报告里如实说明）。不主动上报任何数据。
- **不改全局环境**：不写注册表、不改系统 `PATH`；合成出的 `env` 只在启动 REA
  子进程时生效。你手动设置的 `REA_*` 永远优先，被保留的变量名会出现在
  `REA_POWERPACK_OVERRIDES` 里。
- **权限**：用 winget 装 Python/.NET 时可能弹 UAC，那是 Windows 包的正常提示。
- **不装引擎也能用**：REA 仍能正常启动；依赖缺失的工具返回 `provider_unavailable`，
  卡片会告诉你缺哪个引擎、装它要多久。

## 开发与测试

```bash
npm test            # node --test test/  （catalog / engines / pin / http / client / docs）
npm run lint        # node --check 逐个核心文件
npm run check:client  # 在 fake module-loader 下加载 lib/client.js 并校验 DICT 对齐
```

- 测试全部离线：不联网、不调用 pnpm、不写用户目录（临时目录用 `os.tmpdir()`）。
- 浏览器半边没有构建步骤，改完 `lib/client.js` 刷新页面即可；
  但模块表在启动时构建，个别情况需要重启 DSH。
- 结构约定见 [ARCHITECTURE.md](ARCHITECTURE.md)（契约）与本仓库 `docs/`。

## 许可

MIT，见 [LICENSE](LICENSE)。REA 与各分析引擎各自遵循其上游许可；
本插件不重新分发任何引擎二进制。
