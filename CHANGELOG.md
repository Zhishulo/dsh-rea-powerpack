# Changelog

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
