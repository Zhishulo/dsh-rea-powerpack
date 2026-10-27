/**
 * Engine catalog for dsh-rea-powerpack.
 *
 * Pure data + pure query functions. No filesystem, no child processes, no
 * network — every runtime decision lives in engines.js. URLs here are the
 * verified, contract-approved facts; anything that could not be verified is
 * marked `install: null` with a `notes` entry that says so.
 *
 * @see ARCHITECTURE.md §5 for the EngineSpec contract.
 */

/** Bumped whenever the catalog shape changes. */
export const CATALOG_VERSION = 1

/**
 * @typedef {object} EngineInstall
 * @property {'zip'|'file'|'github-latest'|'winget'|'pip'} kind
 * @property {string} [url] Pinned download URL (zip / file).
 * @property {string} [urlTemplate] URL template with {ver}.
 * @property {string} [latestUrl] GitHub "latest release" API endpoint.
 * @property {string} [repo] GitHub owner/name, used for diagnostics.
 * @property {string} [asset] Release asset name template, {ver} substituted.
 * @property {string} [sha256] Expected sha256 (hex); mismatch must abort.
 * @property {string} [dest] Destination relative to the engine root.
 * @property {boolean} [stripRoot] Drop the archive's single top-level folder.
 * @property {string} [wingetId] winget package id.
 * @property {string[]} [pipArgs] pip package specifiers.
 * @property {'apktool-wrapper'} [post] Post-install step.
 *
 * @typedef {object} EngineSpec
 * @property {string} id
 * @property {string} name
 * @property {0|1|2} tier
 * @property {string[]} platforms
 * @property {string|null} envVar
 * @property {'file'|'dir'|null} envKind
 * @property {boolean} pathPrepend
 * @property {string[]} [requires]
 * @property {{exe: string, args: string[], match?: string}|null} probe
 * @property {EngineInstall|null} install
 * @property {string} [binary] Executable name inside a directory install.
 * @property {string} [launcher] Recorded launcher path, relative to the root.
 * @property {string} [pipScript] Script created by a pip install.
 * @property {string[]} [locate] Extra candidate paths (env vars expanded).
 * @property {string[]} [files] Marker files a directory install must contain.
 * @property {string} [docs]
 * @property {string} [notes]
 * @property {'win32'|'linux'|'darwin'} [hostUnsupported]
 */

/** @type {EngineSpec[]} */
export const ENGINES = [
  // ---------------------------------------------------------------- tier 0 --
  {
    id: 'java',
    name: 'Java (JDK)',
    tier: 0,
    platforms: ['win32'],
    envVar: 'JAVA_HOME',
    envKind: 'dir',
    pathPrepend: false,
    probe: { exe: '{dir}/bin/javac.exe', args: ['-version'], match: 'javac' },
    install: null,
    locate: ['%ProgramFiles%\\Java', '%ProgramFiles%\\Eclipse Adoptium', '%LOCALAPPDATA%\\Programs\\Eclipse Adoptium'],
    docs: 'https://adoptium.net/temurin/releases/',
    notes:
      'Not installed by this plugin: pick a JDK distribution and point JAVA_HOME at it. The probe runs javac (JDK), not java (JRE), because Apktool and jadx need jdk.compiler.',
  },
  {
    id: 'ghidra',
    name: 'Ghidra',
    tier: 0,
    platforms: ['win32'],
    envVar: 'GHIDRA_INSTALL_DIR',
    envKind: 'dir',
    pathPrepend: false,
    probe: null,
    install: null,
    files: ['support/analyzeHeadless.bat'],
    docs: 'https://github.com/NationalSecurityAgency/ghidra/releases',
    notes:
      'External installation only (NSA release zip, several hundred MB): unzip it and point GHIDRA_INSTALL_DIR at the folder that contains support/analyzeHeadless.bat.',
  },

  // ---------------------------------------------------------------- tier 1 --
  {
    id: 'adb',
    name: 'Android Platform Tools (adb)',
    tier: 1,
    platforms: ['win32'],
    envVar: 'REA_ADB_PATH',
    envKind: 'file',
    pathPrepend: false,
    probe: { exe: '{path}', args: ['version'], match: 'Android Debug Bridge' },
    install: {
      kind: 'zip',
      url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
      dest: 'platform-tools',
      stripRoot: true,
    },
    binary: 'adb.exe',
    docs: 'https://developer.android.com/tools/releases/platform-tools',
    notes: 'Unlocks the 31 adb tools. The zip always carries the newest platform-tools; the archive is not version-pinned by Google.',
  },
  {
    id: 'apktool',
    name: 'Apktool',
    tier: 1,
    platforms: ['win32'],
    envVar: 'REA_APKTOOL_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    requires: ['java'],
    probe: { exe: '{path}', args: ['--version'], match: '^(2|3)\\.' },
    install: {
      kind: 'github-latest',
      repo: 'iBotPeaches/Apktool',
      latestUrl: 'https://api.github.com/repos/iBotPeaches/Apktool/releases/latest',
      asset: 'apktool_{ver}.jar',
      dest: 'apktool/apktool.jar',
      post: 'apktool-wrapper',
    },
    launcher: 'apktool/apktool.cmd',
    docs: 'https://apktool.org/docs/install/',
    notes:
      'Downloads the latest apktool release jar and writes apktool/apktool.cmd next to it. The wrapper uses java from JAVA_HOME, so Java (tier 0) must be configured first.',
  },
  {
    id: 'jadx',
    name: 'JADX headless MCP',
    tier: 1,
    platforms: ['win32'],
    envVar: 'REA_JADX_MCP_JAR',
    envKind: 'file',
    pathPrepend: false,
    requires: ['java'],
    probe: null,
    install: {
      kind: 'file',
      url: 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar',
      sha256: '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75',
      dest: 'jadx/jadx-headless-mcp-0.7.1-all.jar',
    },
    docs: 'https://github.com/1013503897/jadx-headless-mcp',
    notes:
      'This is the exact jar build REA audits against (0.7.1). The pinned sha256 is enforced: a mismatching download is deleted and the install fails with checksum_mismatch. No side-effect-free probe exists for a jar, so verification is file presence plus the recorded digest.',
  },
  {
    id: 'wabt',
    name: 'WABT (WebAssembly Binary Toolkit)',
    tier: 1,
    platforms: ['win32'],
    envVar: 'REA_WABT_BIN_DIRECTORY',
    envKind: 'dir',
    pathPrepend: false,
    probe: { exe: '{dir}/wasm2wat.exe', args: ['--version'], match: '1.0.42' },
    install: {
      kind: 'zip',
      url: 'https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-windows-x64.zip',
      dest: 'wabt',
      stripRoot: true,
    },
    binary: 'bin',
    docs: 'https://github.com/WebAssembly/wabt/releases/tag/1.0.42',
    notes: 'REA requires exactly 1.0.42; the installed tools are probed and a different version reports broken instead of being silently used.',
  },
  {
    id: 'python',
    name: 'Python 3.12',
    tier: 1,
    platforms: ['win32'],
    envVar: null,
    envKind: null,
    pathPrepend: true,
    probe: { exe: '{path}', args: ['--version'], match: 'Python 3' },
    install: { kind: 'winget', wingetId: 'Python.Python.3.12' },
    locate: [
      '%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe',
      '%LOCALAPPDATA%\\Programs\\Python\\Python312-32\\python.exe',
      '%ProgramFiles%\\Python312\\python.exe',
    ],
    docs: 'https://www.python.org/downloads/windows/',
    notes:
      'Required by the pip engines (frida-tools, mitmproxy). Installed through winget; if winget updates PATH only for new processes, restart DeepSeek Harness before verifying.',
  },
  {
    id: 'frida',
    name: 'Frida tools',
    tier: 1,
    platforms: ['win32'],
    envVar: null,
    envKind: null,
    pathPrepend: true,
    requires: ['python'],
    probe: { exe: '{path}', args: ['--version'], match: '\\d' },
    install: { kind: 'pip', pipArgs: ['frida-tools'] },
    pipScript: 'frida-ps.exe',
    docs: 'https://frida.re/docs/installation/',
    notes:
      'Installed with the managed Python through "python -m pip install --upgrade frida-tools". Its Scripts directory is prepended to PATH for the MCP child process.',
  },
  {
    id: 'objdump',
    name: 'GNU objdump',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_OBJDUMP_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: { exe: 'objdump', args: ['--version'], match: 'GNU objdump' },
    install: null,
    docs: 'https://www.msys2.org/',
    notes:
      'Discovery only: look for an objdump on PATH (Git for Windows ships one under usr/bin, MSYS2/LLVM likewise) or set REA_OBJDUMP_COMMAND to an absolute path.',
  },
  {
    id: 'rizin',
    name: 'Rizin',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_RIZIN_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: { exe: 'rizin', args: ['-v'], match: 'rizin' },
    install: null,
    docs: 'https://rizin.re/download/',
    notes:
      'UNVERIFIED INSTALL SOURCE: this plugin does not download Rizin because no Windows asset name could be confirmed for the current release. Install it manually (official Windows build) and set REA_RIZIN_COMMAND to rizin.exe, or put rizin on PATH.',
  },
  {
    id: 'dotnet',
    name: '.NET SDK 8',
    tier: 2,
    platforms: ['win32'],
    envVar: null,
    envKind: null,
    pathPrepend: true,
    probe: { exe: 'dotnet', args: ['--version'], match: '\\d+\\.\\d+' },
    install: { kind: 'winget', wingetId: 'Microsoft.DotNet.SDK.8' },
    locate: ['%ProgramFiles%\\dotnet\\dotnet.exe'],
    docs: 'https://dotnet.microsoft.com/download/dotnet/8.0',
    notes: 'Required by ilspy. winget run is non-interactive; if dotnet is on PATH only after a restart, restart DeepSeek Harness before verifying.',
  },
  {
    id: 'ilspy',
    name: 'ILSpy command line (ilspycmd)',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_ILSPY_CMD_PATH',
    envKind: 'file',
    pathPrepend: false,
    requires: ['dotnet'],
    probe: { exe: 'ilspycmd', args: ['--version'], match: '\\d' },
    install: null,
    locate: ['%USERPROFILE%\\.dotnet\\tools\\ilspycmd.exe'],
    docs: 'https://github.com/icsharpcode/ILSpy/tree/master/ICSharpCode.ILSpyCmd',
    notes:
      'UNVERIFIED INSTALL SOURCE: install with "dotnet tool install -g ilspycmd" once the .NET SDK is present, then set REA_ILSPY_CMD_PATH to %USERPROFILE%\\.dotnet\\tools\\ilspycmd.exe. This plugin does not run the dotnet tool command for you.',
  },
  {
    id: 'mitmproxy',
    name: 'mitmproxy (mitmdump)',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_MITMDUMP_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    requires: ['python'],
    probe: { exe: '{path}', args: ['--version'], match: 'mitmproxy' },
    install: { kind: 'pip', pipArgs: ['mitmproxy'] },
    pipScript: 'mitmdump.exe',
    docs: 'https://docs.mitmproxy.org/stable/overview/installation/',
    notes: 'Installed into the managed Python; the recorded path is the Scripts/mitmdump.exe shim.',
  },

  // -------------------------------------------- Linux-only (unsupported) ---
  {
    id: 'tshark',
    name: 'TShark',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_TSHARK_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'REA packet capture requires Linux with TShark 4.x; unsupported on win32 by design (no false support).',
  },
  {
    id: 'capinfos',
    name: 'capinfos',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_CAPINFOS_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'Companion to TShark for pcap inspection; Linux-only in REA, unsupported on win32.',
  },
  {
    id: 'binwalk',
    name: 'Binwalk',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_BINWALK_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'Firmware signature scanning requires Linux; unsupported on win32.',
  },
  {
    id: 'unblob',
    name: 'Unblob',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_UNBLOB_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'Firmware extraction requires Linux; unsupported on win32.',
  },
  {
    id: 'sigrok',
    name: 'sigrok-cli',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_SIGROK_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'Signal decoding requires Linux; unsupported on win32.',
  },
  {
    id: 'pwntools',
    name: 'pwntools',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_PWNTOOLS_PYTHON',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes:
      'REA core/crash lanes use pwntools on Linux; unsupported on win32. Ghidra-driven static analysis stays available.',
  },
  {
    id: 'wakaru',
    name: 'Wakaru (JavaScript deobfuscation)',
    tier: 2,
    platforms: ['win32'],
    envVar: 'REA_WAKARU_COMMAND',
    envKind: 'file',
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'Wakaru source recovery is a Linux lane in REA; unsupported on win32.',
  },
  {
    id: 'process-capture',
    name: 'Process capture (PTY)',
    tier: 2,
    platforms: ['win32'],
    envVar: null,
    envKind: null,
    pathPrepend: false,
    probe: null,
    install: null,
    hostUnsupported: 'win32',
    notes: 'The PTY process-capture lane is Linux-only in REA; unsupported on win32.',
  },
]

const BY_ID = new Map(ENGINES.map((spec) => [spec.id, spec]))

/**
 * Look one engine up by id.
 * @param {string} id
 * @returns {EngineSpec|undefined}
 */
export function byId(id) {
  if (typeof id !== 'string') return undefined
  return BY_ID.get(id)
}

/**
 * Engines relevant to a platform. Entries whose `platforms` do not include the
 * platform are dropped; entries that exist but are explicitly unsupported on
 * this host (hostUnsupported === platform) are KEPT so the UI can explain them.
 * @param {string} [platform] defaults to process.platform
 * @param {{platform?: string}|undefined} [host]
 * @returns {EngineSpec[]}
 */
export function forPlatform(platform = process.platform, host) {
  const target = typeof platform === 'string' && platform !== '' ? platform : (host?.platform ?? process.platform)
  return ENGINES.filter((spec) => Array.isArray(spec.platforms) && spec.platforms.includes(target))
}

/** Engines that are safe to advertise for installation on this host. */
export function installableEngines(platform = process.platform) {
  return forPlatform(platform).filter((spec) => spec.install !== null && spec.hostUnsupported !== platform)
}

/** Stable list of every environment variable named by the catalog. */
export function envVarNames() {
  const names = new Set(['JAVA_HOME', 'GHIDRA_INSTALL_DIR'])
  for (const spec of ENGINES) if (spec.envVar) names.add(spec.envVar)
  return [...names]
}
