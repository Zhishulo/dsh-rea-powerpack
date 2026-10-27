# 引擎矩阵

REA 是适配层，不是分析引擎本体。它能调用哪些工具，取决于这台 Windows 机器上
装了什么：Ghidra 决定反编译深度，JADX 决定 Android 反编译，WABT 决定 WASM，
frida 决定运行时观测。**dsh-rea-powerpack 的职责就是把这些引擎补齐、盯住、并在
Settings 卡片里如实汇报。**

本页对应 `lib/catalog.js` 的 `ENGINES` 表与 `lib/engines.js` 的探测/安装逻辑。

## 1. 三个 tier 的含义

| tier | 含义 | 缺失时的后果 |
| --- | --- | --- |
| 0 | **基石**：Java、Ghidra。REA 超过一半的原生工具都从这里来 | REA 仍能启动，但原生分析基本不可用；体检里缺失数会直接标红 |
| 1 | **主力**：adb、apktool、jadx、wabt、python、frida | 对应的一类目标（Android / WASM / 运行时）工具整组消失 |
| 2 | **特种**：objdump、rizin、dotnet、ilspy、mitmproxy 等 | 只影响特定格式（.NET、抓包、ELF 反汇编） |

`composeEnv` 只把 **tier ≤ 1 且尚未就绪** 的引擎记为 `missing`——tier 2 缺失不会
阻塞 REA 启动，也不会在概览里制造噪音。

## 2. 引擎矩阵（Windows）

| id | 名称 | tier | 环境变量 | 安装方式 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `java` | Java (JDK) | 0 | `JAVA_HOME` | manual | external |
| `ghidra` | Ghidra | 0 | `GHIDRA_INSTALL_DIR` | manual | external |
| `adb` | Android Platform Tools (adb) | 1 | `REA_ADB_PATH` | zip | managed |
| `apktool` | Apktool | 1 | `REA_APKTOOL_COMMAND` | github-latest (latest) | managed |
| `jadx` | JADX headless MCP | 1 | `REA_JADX_MCP_JAR` | file | managed |
| `wabt` | WABT (WebAssembly Binary Toolkit) | 1 | `REA_WABT_BIN_DIRECTORY` | zip | managed |
| `python` | Python 3.12 | 1 | PATH | winget | managed |
| `frida` | Frida tools | 1 | PATH | pip | managed |
| `objdump` | GNU objdump | 2 | `REA_OBJDUMP_COMMAND` | manual | external |
| `rizin` | Rizin | 2 | `REA_RIZIN_COMMAND` | manual | external |
| `dotnet` | .NET SDK 8 | 2 | PATH | winget | managed |
| `ilspy` | ILSpy command line (ilspycmd) | 2 | `REA_ILSPY_CMD_PATH` | manual | external |
| `mitmproxy` | mitmproxy (mitmdump) | 2 | `REA_MITMDUMP_COMMAND` | pip | managed |
| `tshark` | TShark | 2 | `REA_TSHARK_COMMAND` | manual | Linux-only in REA |
| `capinfos` | capinfos | 2 | `REA_CAPINFOS_COMMAND` | manual | Linux-only in REA |
| `binwalk` | Binwalk | 2 | `REA_BINWALK_COMMAND` | manual | Linux-only in REA |
| `unblob` | Unblob | 2 | `REA_UNBLOB_COMMAND` | manual | Linux-only in REA |
| `sigrok` | sigrok-cli | 2 | `REA_SIGROK_COMMAND` | manual | Linux-only in REA |
| `pwntools` | pwntools | 2 | `REA_PWNTOOLS_PYTHON` | manual | Linux-only in REA |
| `wakaru` | Wakaru (JavaScript deobfuscation) | 2 | `REA_WAKARU_COMMAND` | manual | Linux-only in REA |
| `process-capture` | Process capture (PTY) | 2 | — | manual | Linux-only in REA |

「managed」指卡片上的**安装 / 卸载**按钮真的会去下载并放进引擎目录；
「external」指需要你自己装好，插件只负责探测与生成环境变量。

## 3. 状态语义

| status | 含义 | 卡片表现 |
| --- | --- | --- |
| `ok` | 探测通过，版本可读 | 绿色徽章 + 版本号 |
| `missing` | 引擎目录里没有，或 PATH 上找不到 | 灰色徽章 + 「安装」按钮（可 managed 时） |
| `broken` | 文件在，但 `--version` 探测失败 | 红色徽章 + 「重新安装」 |
| `requires_dependency` | 本体在，但依赖没就绪（典型：JADX 缺 Java） | 黄色徽章 + 依赖提示 |
| `unsupported_host` | REA 本身不支持 Windows 上的这条通路 | 灰色徽章 + 说明；不提供安装，避免装了个用不上的东西 |
| `external_ok` | 外部引擎探测通过（插件不管理它的文件） | 绿色徽章，无卸载按钮 |
| `external_missing` | 外部引擎未检测到 | 黄色徽章 + 手动安装指引 |

**没有裸 `missing` 的 external 引擎。** 一个外部引擎要么 `external_ok`，要么
`external_missing`——这样卡片就不会假装「点一下就能修好」一个它根本不管的东西。

## 4. 引擎目录与环境变量合成

- 默认根目录：`%LOCALAPPDATA%\rea-powerpack\engines`。
  可用 `REA_POWERPACK_HOME` 改状态目录，或在设置里写 `engineRoot`（绝对路径）改引擎目录。
- 每个托管引擎装在自己的子目录里（`engines/<id>/`），清单记在 `engines.json`：
  装机结果（`verified`）才参与环境变量合成，装了一半的不会污染 REA 的环境。
- `composeEnv(home, settings)` 的合成规则，顺序有讲究：

  1. 先放 `record.extraEnv`（引擎自带的附属变量）；
  2. 再放**已验证**记录的 `envVar`：`envKind === 'dir'` 时指向目录，
     `'file'` 时指向文件，未声明时按路径本身；
  3. `pathPrepend` 只收集 `pathPrepend: true` 且已就绪的记录，取文件所在目录，
     **按清单顺序去重**（大小写不敏感），最后整体前置到 `PATH`；
  4. **用户自己设的 `REA_*` 永远优先**——被顶掉的键不会出现在合成结果里，
     而是记进 `REA_POWERPACK_OVERRIDES`（值是被保留的变量名列表），
     这样卡片能明确告诉你「这一项用的是你的设置，不是插件的」。

- 只读部分：插件**不会**改写你的全局环境变量，也不写注册表；所有合成只作用于
  REA 子进程的 `env`。

## 5. 安装顺序与依赖

- `jadx`、`apktool` 需要 Java：先让 `java` 变绿，否则装完仍是 `requires_dependency`。
- `ilspy` 是 `dotnet tool`，先装 `.NET SDK`，再执行
  `dotnet tool install --global ilspycmd`。
- `frida`、`mitmproxy` 走 pip，需要 PATH 上有可用的 Python 3.12；
  卡片的「安装」按钮固定在 `python` 就绪后才建议点击。
- 下载与校验：zip / file 类安装带 `sha256` 的会强制校验，不匹配即
  `checksum_mismatch`，**不会**把半成品写进清单；`github-latest` 只跟随上游最新发布，
  想要可复现就手动固定。

## 6. 探测是怎么做的

`verifyAll` 对每个引擎跑一次轻量探测（`probe`：可执行文件 + 参数 + 可选正则），
默认 20 秒超时，超时算 `broken`。探测只跑 `--version` 这类无副作用命令，
不会启动 Ghidra 的图形界面，也不会替你去连设备。

> 探测会真实执行第三方可执行文件。只安装你信任来源的引擎版本；
> 卡片的每个版本号旁边都能看到落盘路径。

## 7. 维护这张表

新增引擎只需改 `lib/catalog.js`：加一条 `EngineSpec`（id / name / tier /
platforms / envVar / envKind / pathPrepend / probe / install / docs / notes）。
卡片与 `composeEnv` 都从同一张表读取，**不需要改 UI 代码**。

`test/catalog.test.mjs` 会拦住常见错误：id 重复、tier 非法、环境变量命名不合规、
sha256 不是 64 位十六进制、`install.kind` 不认识、`unsupported_host` 缺 notes。
