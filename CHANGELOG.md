# Changelog

## 0.1.1 — 首次真机启动后修复（install → restart 全链路跑通）

0.1.0 在真宿主里跑通了 UI 与引擎矩阵，但 MCP 行始终连不上，模型侧一个 mcp__rea__* 工具都没有。
四个真实缺陷逐一复现、修掉，并各补了回归测试：

### 1. 启动器通过 profile junction 启动时静默退出（致命）
宿主按 <profile>/node_modules/dsh-rea-powerpack/lib/rea-mcp.mjs 启动（pnpm link: 建的是 junction），
而 Node 把 import.meta.url 解析成真实路径，isEntryPoint 只做字符串比较 → 守卫判定「不是入口」，
进程 exit 0、stdout/stderr 全空，MCP 客户端只能看到启动超时。
现在先比 resolve()，不等再 realpathSync()，两侧统一 toLowerCase() 后比较。
另把 fail() 的「写 stderr 后立即 exit」改成抛 LauncherError（Windows 管道下 stderr 是异步的，立即退出会吞掉错误行）。

### 2. ctx.loader.entries() 是 generator，被当成数组
Array.isArray(entries) ? entries : [] 永远得到空数组 → /state.mcp.present 恒为 false，
/reload 恒回 restart-required（即使行就在那里）。改为 Array.from 物化；
Entry.id 带父前缀（parentId:childId）故匹配允许 endsWith(':'+id)；Entry.disabled 是求值 !!js 的 getter，读取包 try/catch。

### 3. ROW_ID 常量与 cordis.patch.yml 写入的行 id 不一致
const ROW_ID = SELF + '-mcp' 得到 dsh-rea-powerpack-mcp，而 patch 里插入的是 rea-powerpack-mcp
→ 宿主永远找不到该行。改为字面量并在 acceptance 里加交叉校验（从 lib/index.js 正则抽 ROW_ID 与 patch 行 id 比对）。

### 4. 安装脚本静默丢依赖
dev/install-plugin.mjs 在 pnpm add 之前读取 package.json，之后又把旧对象写回，
把刚加上的 dsh-rea-powerpack 依赖抹掉（首次真实安装即中招）。改为 pnpm 完成后重新读取再改。

### 其它
- lib/version.js：package.json 成为唯一版本源，/state.self、下载 User-Agent、MCP clientInfo 不再各写一份字面量。
- 安装脚本在移除 dsh-rea-agents bundle 时，改为整块删除残留的 rea-agents-mcp patch 行（bundle 已不再提供其 config，保留下来是非法行）。
- 回归测试：isEntryPoint 接受 junction 路径（真实路径 + 软链路径双向）、/state 能识别 generator 形式的 loader 行；
  acceptance 51 → 55 checks，新增「loader 行物化」「入口守卫归一化链接」「经 profile junction 的 MCP 握手 229 工具」三项。
- node dev/gate.mjs --full → ALL GREEN（55/55 + 30/30 HTTP + 全部 unit）。

## 0.1.0 — 首个公开版本

### 引擎（把 REA 从"能握手"变成"真能干活"）
- 13 条 Windows 引擎记录：java 25 / ghidra 12.1.4 / adb 37.0.1 / apktool 3.0.3 / jadx-headless-mcp 0.7.1 /
  WABT 1.0.42 / python 3.12 / frida 17.24 / objdump 2.47 / rizin 0.9.1 / dotnet 8 / ilspy 8.2 / mitmproxy 12.3。
- `composeEnv` 把 `REA_*` 变量与 `PATH` 前缀注入 MCP 子进程，用户已设置的变量优先（记入
  `REA_POWERPACK_OVERRIDES`），绝不覆盖。
- 实测：可用工具组 **42/77 → 50/76**，组内工具 **110 → 142**，`provider_unavailable` **7 → 0**；
  仅剩 JEB（商业软件，需自备客户端）与 Windows 上本就不支持的 tshark/binwalk/sigrok/pwntools 等。

### MCP 启动
- `lib/rea-mcp.mjs` 在 profile 内解析**固定版本**的 `rea-agents`，不联网、不拉新版。
- 版本过低时自我 re-exec 到系统 Node（Harness 内嵌 Node 24.21 < REA 要求的 24.22.1）。
- 引擎缺失只 warn 不阻断启动；pin 缺失退化为一行可读错误。

### 宿主 API（loopback only，前缀 `/rea-powerpack`）
- `/state`、`/doctor`（真实 MCP 握手 + `binary_session` 缺口解析）、`/report`（markdown）、
  `/check`、`/update`、`/pin`、`/settings`、`/engines/{verify,install,uninstall,import}`、
  `/import-pin`、`/reload`（失败降级为 restart-required，绝不谎报热重载成功）。

### 更新
- 影子预检 → 升级 → 握手复验 → 失败回滚；策略 `notify | auto-idle | manual`。

### UI
- DSH 设置 → 插件 tab 里的独立面板（slot `settings.plugins.tab`，id `dsh-rea-powerpack`，order 20）。
- 概览 → 引擎矩阵 → 版本与更新 → 能力体检 → 维护；中英双语 198 键 1:1。

### 安全
- 只监听 loopback；所有写操作限制在 `powerpackHome`；不改用户的 `cordis.patch.yml`
  （唯一例外是 `/reload` 期间快照后写回，字节级还原）。
- 不记录任何密钥/令牌值。
