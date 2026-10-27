# 版本、pin 与更新

REA（`rea-agents`）装在 DSH 配置档（profile）里，执行 `pnpm add rea-agents@<版本> --save-exact`。
**dsh-rea-powerpack 从不「跟随 latest」**：它先把你选的版本固定（pin）下来，检查到新版
也按策略决定要不要动，动之前先在影子目录里体检一遍。

对应实现：`lib/pin.js`。

## 1. pin.json 是什么

状态目录（默认 `%LOCALAPPDATA%\rea-powerpack`）下的 `pin.json` 记录「现在固定了什么」：

```json
{
  "version": "6.5.0",
  "requested": "6.5.0",
  "pinnedAt": "2025-08-01T10:00:00.000Z",
  "pinnedFrom": "update",
  "retained": { "from": "6.4.2", "at": "2025-08-01T10:00:00.000Z" },
  "withheldBuilds": ["6.6.0"],
  "latestKnown": "6.6.0",
  "checkedAt": "2025-08-01T09:59:00.000Z"
}
```

| 字段 | 含义 |
| --- | --- |
| `version` | 当前固定并实际装着的版本 |
| `requested` | 你「要求」的版本。与 `version` 不一致时说明安装/体检失败被回滚过 |
| `pinnedFrom` | 谁固定了它：`cli` / `ui` / `update` / `preflight` |
| `retained.from` | 升级前的旧版本，**「回滚」按钮就回滚到它**；没有就说明没有可回滚的目标 |
| `withheldBuilds` | 体检不合格被扣下的版本。这些版本不会被自动重装，直到上游修好 |
| `latestKnown` / `checkedAt` | 最近一次 registry 检查的结果与时间 |

pin.json 缺失或损坏时按「未固定」处理，不会抛异常、不会让卡片崩掉。

## 2. 更新策略

在卡片「REA 版本与更新」里选择，写入 `settings.json` 的 `updatePolicy`：

| 策略 | 检查到新版时 | 适合谁 |
| --- | --- | --- |
| `notify`（默认） | 只提示，不升级 | 大多数人的默认：可控、可预期 |
| `auto-idle` | 空闲时自动升级（有正在跑的对话就不动） | 想始终跟进、又不想打断正在进行的分析 |
| `manual` | 什么都不做，只有手动点「升级」才动 | 生产环境、需要严格可复现 |

决策矩阵（实现见 `decideUpgrade`）：

| policy | 有新版？ | 是否空闲 | action |
| --- | --- | --- | --- |
| `notify` | 有 | — | `notify` |
| `notify` | 无 | — | `none`（`up_to_date`） |
| `auto-idle` | 有 | 空闲 | `upgrade` |
| `auto-idle` | 有 | 忙 | `notify`（`busy`） |
| `manual` | 有 | — | `none`（`manual_policy`） |
| 任意 | 未安装 REA | — | `none`（`rea_not_installed`） |
| 任意 | 不知道新版 | — | `none`（`no_latest_version_known`） |

「忙」的判定看最近 10 分钟内有没有 API 活动；自动升级不会踩在你正在跑的分析上。

## 3. 一次升级到底做了什么

`upgradeRea(home, profileDir, version)` 是**五步**，任何一步失败都不留半装状态：

1. **影子安装**：在 `<home>/staging/<version>/` 里单独 `pnpm add --save-exact rea-agents@<version>`，
   不碰你正在用的配置档；
2. **影子体检**：用最小 JSON-RPC 客户端拉起影子目录里的 REA
   （`initialize` → `notifications/initialized` → `tools/list` 翻页），
   要求 **serverInfo.version 必须等于目标版本**、**工具数 ≥ 200**；
3. **正式安装**：同样版本写进配置档；
4. **复检**：在配置档里再拉一次，工具数仍须 ≥ 200；
5. **固定**：写 pin.json（`pinnedFrom: 'update'`，`retained` 记下旧版本）。

失败时：

- 第 2 步失败 → 配置档**从没被改过**，只把失败原因报出来；
- 第 4 步失败 → 该版本进 `withheldBuilds`，并**自动回滚**到升级前的版本；
  回滚也失败才算 `rollback_failed`（此时卡片会明说两次失败的原因）。

这也解释了为什么升级会慢：一次真实安装 + 两次完整 REA 握手。超时上限分别是
安装 15 分钟、体检 15 秒。

## 4. 回滚

- 卡片上的「回滚」按钮回到 `pin.retained.from`；没有该字段时按钮禁用并提示原因。
- 回滚同样会做一次握手体检，装不回去就是 `rollback_failed`，配置档保持原样。
- 回滚成功后 `retained` 被清空（旧版本已经被「用掉」），当前版本进 `withheldBuilds`，
  避免自动策略立刻又把你升回那个坏版本。

命令行场景也可以用 `POST /rea-powerpack/update { "rollback": true }`。

## 5. 手动固定到某个版本

在「REA 版本与更新」输入框填精确版本（`6.5.0`，可带 `-rc.1` 这类 prerelease），
点「固定」。校验通过后走与升级相同的五步。

- 已固定到别的版本时再指定新版本会得到 `pin_conflict`——先解除固定，再换版本，
  避免「以为换成功、其实还是旧版」。
- `compareVersions` 按 semver 比较并正确排序 prerelease：`6.8.0-rc.1 < 6.8.0`，
  `6.8.0-rc.1 < 6.8.0-rc.2`，`1.0.0-alpha < 1.0.0-alpha.1`。

## 6. 导入旧 pin

从 dsh-rea-agents 迁移过来时，卡片「维护」区可以填旧 `pin.json` 的路径导入：
版本对得上就直接接管固定状态（`pinnedFrom` 保留，方便追溯），
不会重装 REA。导入只认 `version` 字段合法的文件，坏文件返回 `bad_request`。

## 7. 热重载 vs 重启

升级/回滚后会尝试热重载 MCP 行（`reloadMcpRow`）：

- `mode: 'hot'`：连接已就地重建，无需重启 DSH；
- `mode: 'restart-required'`：宿主没有提供热重载钩子，**必须重启 DSH** 才会用上新版本。
  卡片会把 `reason` 一起显示，不会假装成功。

不光是版本变化：**改引擎路径、改 `toolTimeoutMs` 之后同样建议重载一次**，
因为 REA 的环境变量是在 MCP 子进程启动时合成的。

## 8. 离线与 registry 不可达

检查新版依赖配置档自己的 registry（`pnpm view rea-agents version`，沿用你的
registry / 代理 / 认证配置）。失败会归为：

- `registry_timeout`：registry 没在超时内答应，稍后再试；
- `registry_unreachable`：连不上或被代理挡住。

这两种情况**只影响「检查新版」**：当前 pin 不变、已装的 REA 照常工作。
离线机器不会因此失去 MCP。

pnpm 自己的供应链策略（如 `minimumReleaseAge`）同样生效：新版本发布时间不够长时
pnpm 会拒绝安装，报错原样转成卡片上的错误详情，pin 不会被改动。

## 9. 版本号显示约定

- 路径、版本号一律等宽字体显示，避免 `6.5.0` 和 `6.50` 看起来一样。
- 概览里的「引擎就绪数」是 `ok + external_ok` 的数量，不含 `requires_dependency`。
- 影子预检结果会显示 **serverVersion 与 toolCount** 两项——这是判断「新版到底能不能用」
  最直接的两个数。
