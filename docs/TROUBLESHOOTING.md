# 故障排查

卡片上的每一条错误都来自宿主返回的稳定错误码（见 ARCHITECTURE §4），
前端只做「码 → 人话」的翻译，不猜原因。下面按「症状 → 先查什么 → 怎么修」组织。

## 0. 三个入口

| 你要什么 | 去哪 |
| --- | --- |
| 一眼看健康度 | 概览：REA 版本 / pin 状态 / 引擎就绪数 / 最近体检时间 / 更新策略 |
| 具体缺什么 | 能力体检：点「运行体检」→ 按 reason 分组 → 每组有修复建议与工具名 |
| 给维护者看 | 维护 → 「导出诊断报告」（Markdown，含状态快照、引擎矩阵、体检缺口、最近日志） |

日志文件：`%LOCALAPPDATA%\rea-powerpack\logs\powerpack.log`（JSONL，一行一个事件）。
状态文件同目录：`engines.json`、`settings.json`、`pin.json`、`state.json`。

## 1. 错误码对照表

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `loopback_only` | 请求不是从本机 loopback 来的 | 只用 `http://127.0.0.1:...` 访问；不要把 DSH 反代到公网 |
| `not_found` | 路由或引擎 id 不存在 | 检查路径前缀是否 `/rea-powerpack/*`；升级插件到最新 |
| `bad_json` | 请求体不是合法 JSON | 手工调 API 时检查引号/逗号 |
| `bad_request` | 字段不合法（版本号格式、路径为空等） | 版本要 `x.y.z`（可带 `-rc.1`）；路径要绝对路径 |
| `profile_unwritable` | 配置档目录不可写 | 检查 ACL / 磁盘只读 / 杀软拦截；换一个有写权限的 profile |
| `no_engine` | 状态里没有这个引擎记录 | 先「校验全部」，再安装 |
| `unknown_engine` | catalog 里没有这个 id | 用了旧 id 或拼错；看引擎矩阵表 |
| `install_failed` | 下载/解压/安装失败 | 看错误详情里的命令与输出；常见是网络、代理、磁盘满 |
| `download_failed` | HTTP 下载失败 | 检查 `HTTPS_PROXY`；国内网络可先手动下载再「导入」 |
| `checksum_mismatch` | sha256 与 catalog 不符 | **不要继续用**：缓存损坏或被篡改；删掉该引擎目录重装 |
| `unsupported_host` | 该引擎在 Windows 上不被 REA 支持 | 正常现象（tshark/binwalk/sigrok 等），不用修 |
| `requires_dependency` | 本体在，但依赖缺失 | 典型：jadx 缺 Java、ilspy 缺 dotnet；先修依赖 |
| `registry_timeout` | 查新版超时 | 稍后重试；不影响已装的 REA |
| `registry_unreachable` | 连不上 registry | 检查网络/代理/npm registry 配置 |
| `no_such_version` | registry 里没有这个版本 | 核对版本号；prerelease 也要写在版本里 |
| `preflight_failed` | 影子体检没过（版本不符或工具数 < 200） | 该版本已被扣下；查看详情里的 serverVersion/toolCount |
| `rollback_failed` | 升级失败且回滚也失败 | 最严重：按详情手动 `pnpm add rea-agents@<旧版本> --save-exact` |
| `reload_failed` | MCP 行热重载失败 | 重启 DSH；卡片会提示 `restart-required` |
| `pin_conflict` | 已固定到别的版本 | 先解除固定，再指定新版本 |
| `rea_missing` | 配置档里没装 rea-agents | 点「安装」；或确认插件装在正在用的 profile 里 |

未知错误码不会显示成 `undefined`：会原样显示码本身 + 宿主给的 detail。

## 2. 卡片不出现 / tab 是空的

1. 确认插件装进了**正在使用**的 profile（`dsh plugin --profile web ls`）；
2. 重启一次 DSH —— 浏览器半边的模块表在启动时构建；
3. Desktop 版的 profile 由 Electron 独占管理，安装要走应用内「插件 → 添加」。

## 3. 概览显示「未安装」但 REA 明明装过

- 卡片读的是**当前 profile** 的 `node_modules/rea-agents`；多 profile 并存时会各看各的。
- 插件版本与 REA 版本是两个东西：卡片显示的是 REA 的版本。
- 迁移自 dsh-rea-agents 的旧 pin 可以在「维护 → 导入旧 pin」里接过来。

## 4. 引擎显示 `broken`

「文件在，但探测失败」。按序排查：

1. 展开该行「详情」看 `probeOutput`（探测命令的 stderr）；
2. 手动执行同一个命令（例如 `<引擎路径> --version`），确认是不是缺 DLL / 缺 VC 运行库；
3. 重新安装一次（会重下并校验）；
4. 杀软把可执行文件隔离了是最常见原因——加白名单后重装。

## 5. 体检里缺口很多，但卡片说引擎 ok

体检（`GET /doctor`）是**REA 自己的视角**：它按注册的工具反推「需要哪些引擎」，
再报告缺口。两者不一致通常意味着：

- 引擎装好了，但 REA 启动时没拿到环境变量 → 点「热重载 MCP 行」，或重启 DSH；
- 用户自己设的 `REA_*` 环境变量覆盖了插件合成值 → 概览的 `REA_POWERPACK_OVERRIDES`
  会列出被保留的变量名，按需删掉自己的设置。

## 6. 体检结果一直是「旧」的

- `/doctor` 会真实拉起 REA 做一次能力盘点，首次可能要几十秒；
- 卡片上的「最近体检时间」来自 `state.json`，超过检查间隔会标记 stale；
- 点「运行体检」强制刷新，结果同时写回 `state.json`。

## 6.5 doctor 报 `node missing_dependency`（REA 6.8.0 要求 Node >= 24.22.1）

**症状**：能力体检里出现 `node` 缺失、reason `missing_dependency`；但 REA 本身工作正常，
229 个工具都在。

**原因**：REA 6.8.0 的 `rea doctor` 自带一条 Node 版本检查，要求 **Node >= 24.22.1**。
而 Harness 桌面版内嵌的是 Electron 44.7.0 的 Node **24.21.0**，系统 Node 常见为 24.19.0，
两者都低于门槛。这是 doctor 的**自检项**，不是 REA 不能用。

**处理**：

1. 把系统 Node 升到 **24.22.1 或更高**（`node -v` 确认）；
2. 重启 DSH，让 `rea-mcp` 启动器用系统 Node 重新执行自己（启动器会在需要时做这一步）；
3. 再跑一次体检，`node` 这条应从缺口里消失。

只想确认功能是否受影响：随便调一个 REA 工具（如 `binary_session`），能返回工具清单就说明
REA 本身没问题，只是 doctor 的版本自检没过。

## 7. 热重载后工具还是旧的

看返回值里的 `mode`：

- `hot`：已就位；
- `restart-required`：宿主没提供重载钩子（或 `ctx.loader` 不可用），重启 DSH。

另：`cordis.patch.yml` 决定 MCP 行定义。如果你手改过它，热重载会尽量恢复原文件，
失败时以宿主日志里的 `reload_failed` 为准。

## 8. 端口/前缀相关

- 宿主路由只挂在 loopback，前缀固定 `/rea-powerpack`；
- 用绝对路径调用（`fetch('/rea-powerpack/state')`），不要用相对路径；
- 403 + `loopback_only`：你从非本机地址访问了，或被反代到了公网。

## 9. 需要更多线索时

1. 「维护 → 导出诊断报告」，得到一份含状态的 Markdown；
2. 附上 `logs/powerpack.log` 最后 200 行；
3. 附上「能力体检 → 复制报告」的原文；
4. 说明：Windows 版本、Node 版本、DSH 版本、是否用代理、哪些引擎是自己装的。

导出报告与复制报告都只包含路径与版本，不包含被分析文件的内容。
