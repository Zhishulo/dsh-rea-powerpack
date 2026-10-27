// Browser half of dsh-rea-powerpack: this bundle's own configuration card.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so there is no build step
// and the only module it requires is React.
//
// The card is the operations view for REA on Windows: the engine matrix, the
// pinned rea-agents version, the capability doctor and the maintenance
// actions. It renders its own markup and CSS rather than depending on
// product-internal components, so it keeps working across harness versions that
// rearrange those components. The one stable contract it relies on is
// plugins.bundle.config - the plugin page's declared seat for a bundle's own
// configuration, keyed by package name and drawn on that bundle's page.
//
// This half holds no policy of its own. Which engine counts as ready, whether a
// version is newer, how an update is staged and rolled back, and what the pin
// file says are all decided by the host half, which owns the machine-level
// state. The card renders that state, collects the intents a user has here, and
// reports exactly what happened. Every mutation is followed by a fresh GET
// /state so the page shows what is on disk, never a prediction.
window.__ModuleLoader__.load({
  id: 'dsh-rea-powerpack',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;

    /** Host half's route prefix. Nothing in this file may fetch outside it. */
    var API_PREFIX = '/rea-powerpack';

    /** The i18n namespace this half registers with the shell. */
    var NS = 'dsh-rea-powerpack';

    /** npm package name; the plugin page filters its seat on this key. */
    var PACKAGE_NAME = 'dsh-rea-powerpack';

    /** Where the manual language choice is remembered (contract section 7). */
    var LOCALE_KEY = 'rea-powerpack.locale';

    /**
     * The two dictionaries. Both must carry the same key set - the client
     * bundle test asserts it, and a key added to one side only is a defect
     * that shows up as a raw identifier on screen.
     *
     * Error keys mirror the stable error-code enum in the host contract:
     * the host sends codes, the client owns the sentences.
     */
    var DICT = {
      zh: {
        pageTitle: 'REA Powerpack',
        pageSubtitle: '分析引擎托管 · REA 版本治理 · 能力体检',
        langLabel: '语言：',
        langAuto: '跟随界面',
        loading: '正在读取…',
        loadFailedWith: '读取失败：{reason}',
        retry: '重试',
        refresh: '刷新',
        refreshing: '刷新中…',
        refreshAll: '全部校验',
        copy: '复制',
        copiedDir: '已复制：{path}',
        copyFailedWith: '复制失败：{reason}',
        details: '详情',
        hideDetails: '收起',
        unknown: '未知',
        none: '—',
        errGeneric: '服务端返回错误（{code}）',
        actionFailedWith: '操作失败：{reason}',
        requestFailedWith: '请求失败：{reason}',
        busyHint: '有操作正在进行，请等待完成。',
        footerHint: 'dsh-rea-powerpack {version} · 请求只走 /rea-powerpack/*（仅 loopback）',

        summaryLoading: 'REA Powerpack…',
        summaryFailed: 'REA Powerpack · 状态不可用',
        summaryLine: '引擎 {ready}/{total} · REA {rea} · {policy}',

        tab: 'REA 强化',
      secOverview: '概览',
        reaVersion: 'REA 版本',
        reaNotInstalled: '未安装',
        pinState: 'pin 状态',
        pinPinned: '已固定',
        pinNotPinned: '未固定',
        pinRequested: '请求版本',
        pinPinnedAt: '固定时间',
        pinPinnedFrom: '固定来源',
        pinSource: '安装来源',
        enginesReady: '引擎就绪',
        enginesReadyValue: '{ready}/{total}',
        enginesUnsupportedCount: '其中 {count} 项本机不适用',
        doctorLast: '最近体检',
        never: '从未',
        doctorStaleShort: '已过期',
        updatePolicy: '更新策略',
        hostPlatform: '平台',
        hostNode: 'Node',
        hostJava: 'JAVA_HOME',
        hostGhidra: 'GHIDRA_INSTALL_DIR',
        notDetected: '未检测到',
        profileDir: '配置档',
        writableWarning: '配置档目录不可写：安装、升级与重载都可能失败，请检查文件权限。',
        conflictTitle: 'MCP 服务名冲突',
        conflictBody: '检测到另一个 rea MCP 行（{detail}）。请禁用它，否则 mcp__rea__* 的工具来源不确定。',
        mcpRowMissing: 'MCP 行 rea-powerpack-mcp 不在 loader 中，REA 工具不会出现。重新启用本插件可重新插入该行。',
        mcpRowDisabled: 'MCP 行 rea-powerpack-mcp 当前被禁用，REA 工具不可用。',
        enginesWarningTitle: '引擎提示',

        policyNotify: '通知（notify）',
        policyAutoIdle: '空闲自动（auto-idle）',
        policyManual: '手动（manual）',
        policyHint: 'notify 只提示新版本；auto-idle 在检测到空闲时自动升级；manual 只在按「升级」时行动。',

        secEngines: '引擎矩阵',
        secEnginesHint: 'Tier 0 为必需探测项（需自行安装），Tier 1 为强烈建议，Tier 2 为可选专业工具。',
        colName: '名称',
        colTier: 'Tier',
        colVersion: '版本',
        colStatus: '状态',
        colActions: '动作',
        enginesEmpty: '还没有引擎记录。按「全部校验」重新探测。',
        enginesVerified: '校验完成：{ready}/{total} 就绪',
        engineVerify: '校验',
        engineVerifying: '校验中…',
        engineInstall: '安装',
        engineInstalling: '安装中…',
        engineReinstall: '重装',
        engineUninstall: '卸载',
        engineUninstalling: '卸载中…',
        engineUninstallConfirm: '确定卸载引擎 {name}？它的文件会被删除，再次使用需要重新安装。',
        engineInstalled: '已安装 {name}（{version}）',
        engineUninstalled: '已卸载 {name}',
        engineUnsupportedNoInstall: '本机不支持，无法安装',
        engineNeedsDependency: '缺失前置依赖，请先安装依赖',
        engineExternalNoInstall: '外部安装，本插件不代装',
        engineEnvVar: '环境变量',
        enginePath: '路径',
        doctorRemedyLine: '修复建议：{remedy}',
        engineVerified: '{name} 校验完成：{status}',
        engineProbeOutput: '探测输出',
        engineDocs: '说明文档',
        engineVersionUnknown: '未知',

        statusOk: '就绪',
        statusMissing: '未安装',
        statusBroken: '校验失败',
        statusUnsupportedHost: '本机不支持',
        statusRequiresDependency: '缺依赖',
        statusExternalOk: '已检测',
        statusExternalMissing: '未检测到',

        secVersion: 'REA 版本与更新',
        versionPinned: '当前固定版本',
        versionLatest: '仓库最新',
        versionCheckedAt: '检查时间',
        versionCheckDone: '已检查最新版本：{latest}',
        versionCheck: '检查更新',
        versionChecking: '检查中…',
        versionUpgradeAny: '升级到最新',
        versionUpgradeTo: '升级到 {version}',
        versionUpgrading: '升级中…',
        versionRollbackTo: '回滚到 {version}',
        versionRollingBack: '回滚中…',
        versionRollbackUnavailable: '没有可回滚的上一版本',
        versionPinAction: '固定',
        versionPinning: '固定中…',
        versionPinPlaceholder: '精确版本，如 6.8.0',
        versionPinInvalid: '请输入精确版本号，如 6.8.0。',
        versionPinDone: '已固定：{version}',
        versionUpdateDone: '已从 {from} 升级到 {to}',
        versionUpToDate: '已是最新',
        versionBehind: '有新版本',
        versionNoCheck: '尚未检查',
        versionPreflightTitle: '影子预检',
        versionPreflightValue: '服务端 {serverVersion} · 工具 {toolCount}',
        versionReloadTitle: '重载',
        versionReloadHot: '已热重载',
        versionReloadRestart: '需要重启 DSH',
        versionPolicyLabel: '更新策略',
        versionPolicySaved: '已保存更新策略：{policy}',
        versionNoInstallHint: 'REA 尚未固定版本。填一个精确版本按「固定」，或在维护区导入旧 pin。',

        secDoctor: '能力体检',
        doctorRun: '运行体检',
        doctorRunning: '体检中…',
        doctorNever: '还没有体检结果。',
        doctorAt: '体检时间',
        doctorServer: 'REA 版本',
        doctorTools: '工具总数',
        doctorGroups: '可用工具组',
        doctorGroupsValue: '{available}/{total}',
        doctorGapsTitle: '能力缺口',
        doctorNoGaps: '没有缺口：所有工具组都可用。',
        doctorGapCount: '{count} 个工具',
        doctorGapTools: '涉及工具',
        doctorShowMore: '展开其余 {count} 个',
        doctorCopyReport: '复制报告',
        doctorReportCopied: '诊断报告已复制到剪贴板。',
        doctorDone: '体检完成：工具组 {groups}/{total}，工具 {tools} 个',
        doctorStale: '结果来自 {at}，可能已过期。',
        doctorFailed: '体检失败。',
        doctorHint: '体检会向 REA MCP 握手并读取 binary_session 的工具可用性，可能需要几秒。',
        doctorReasonUnknown: '未归类原因',

        'reason.provider_unavailable': '外部引擎不可用',
        'reason.missing_binary': '找不到可执行文件',
        'reason.unsupported_host': '本机不支持',
        'reason.requires_java': '需要 Java',
        'reason.requires_dependency': '缺少依赖',
        'reason.not_implemented': '尚未实现',
        'reason.permission_denied': '权限不足',
        'reason.timeout': '超时',
        'reason.disabled': '当前被禁用',

        'err.loopback_only': '只允许从本机回环地址访问。',
        'err.not_found': '接口不存在（插件版本不匹配？）。',
        'err.bad_json': '请求体不是合法的 JSON。',
        'err.bad_request': '请求参数不合法。',
        'err.profile_unwritable': '配置档目录不可写。',
        'err.no_engine': '该引擎没有可用的安装方式。',
        'err.unknown_engine': '未知的引擎 id。',
        'err.install_failed': '引擎安装失败。',
        'err.download_failed': '下载失败（网络或代理问题）。',
        'err.checksum_mismatch': '下载内容校验失败，已拒绝安装。',
        'err.unsupported_host': '本机不支持该引擎。',
        'err.requires_dependency': '缺少前置依赖，请先安装它。',
        'err.registry_timeout': 'registry 查询超时。',
        'err.registry_unreachable': '无法访问 registry（离线或代理问题）。',
        'err.no_such_version': 'registry 上没有这个版本。',
        'err.preflight_failed': '影子预检未通过，已中止升级。',
        'err.rollback_failed': '升级失败且回滚也失败，请手动检查 pin。',
        'err.reload_failed': '热重载失败。',
        'err.pin_conflict': 'pin 文件与磁盘状态冲突。',
        'err.rea_missing': '配置档里没有 rea-agents，请先固定一个版本。',

        secMaintenance: '维护',
        maintReload: '热重载 MCP 行',
        maintReloading: '重载中…',
        maintReloadOk: '热重载成功',
        maintReloadRestart: '无法热重载：需要重启 DSH',
        maintReloadRestored: 'loader 曾改动 cordis.patch.yml，已写回快照。',
        maintImportPin: '导入旧 pin',
        maintImportingPin: '导入中…',
        maintImportPinHint: '从 dsh-rea-agents 的 pin.json 迁移固定版本。留空则使用默认位置。',
        maintImportPinPlaceholder: '可选：pin.json 的绝对路径',
        maintImported: '已导入 pin：{version}',
        maintExportReport: '导出诊断报告',
        maintExporting: '导出中…',
        maintExported: '已导出：{name}',
        maintEngineDir: '引擎目录',
        maintEngineDirHint: '引擎是机器级资产，多个配置档共用，位于：{home}',
        maintCopyDir: '复制目录',
        maintMcpRow: 'MCP 行',
        maintRowPresent: '存在',
        maintRowMissing: '缺失',
        maintRowDisabled: '已禁用',
        maintLastReload: '最近重载',
        maintNoReload: '尚未重载',
      },
      en: {
        pageTitle: 'REA Powerpack',
        pageSubtitle: 'Managed analysis engines · REA version control · Capability doctor',
        langLabel: 'Language:',
        langAuto: 'Follow interface',
        loading: 'Loading…',
        loadFailedWith: 'Could not load: {reason}',
        retry: 'Retry',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        refreshAll: 'Verify all',
        copy: 'Copy',
        copiedDir: 'Copied: {path}',
        copyFailedWith: 'Could not copy: {reason}',
        details: 'Details',
        hideDetails: 'Hide',
        unknown: 'unknown',
        none: '—',
        errGeneric: 'The server answered with an error ({code}).',
        actionFailedWith: 'Action failed: {reason}',
        requestFailedWith: 'Request failed: {reason}',
        busyHint: 'An operation is still running; wait for it to finish.',
        footerHint: 'dsh-rea-powerpack {version} · requests go only to /rea-powerpack/* (loopback only)',

        summaryLoading: 'REA Powerpack…',
        summaryFailed: 'REA Powerpack · state unavailable',
        summaryLine: 'Engines {ready}/{total} · REA {rea} · {policy}',

        tab: 'REA Powerpack',
      secOverview: 'Overview',
        reaVersion: 'REA version',
        reaNotInstalled: 'Not installed',
        pinState: 'Pin state',
        pinPinned: 'Pinned',
        pinNotPinned: 'Not pinned',
        pinRequested: 'Requested',
        pinPinnedAt: 'Pinned at',
        pinPinnedFrom: 'Pinned from',
        pinSource: 'Source',
        enginesReady: 'Engines ready',
        enginesReadyValue: '{ready}/{total}',
        enginesUnsupportedCount: '{count} not applicable on this host',
        doctorLast: 'Last doctor run',
        never: 'never',
        doctorStaleShort: 'stale',
        updatePolicy: 'Update policy',
        hostPlatform: 'Platform',
        hostNode: 'Node',
        hostJava: 'JAVA_HOME',
        hostGhidra: 'GHIDRA_INSTALL_DIR',
        notDetected: 'not detected',
        profileDir: 'Profile',
        writableWarning: 'The profile directory is not writable, so install, update and reload can fail. Check file permissions.',
        conflictTitle: 'MCP server-name conflict',
        conflictBody: 'Another rea MCP row is present ({detail}). Disable it, or mcp__rea__* tools will come from an undetermined server.',
        mcpRowMissing: 'The rea-powerpack-mcp row is missing from the loader, so no REA tools appear. Re-enabling this plugin inserts it again.',
        mcpRowDisabled: 'The rea-powerpack-mcp row is disabled, so REA tools are unavailable.',
        enginesWarningTitle: 'Engine note',

        policyNotify: 'Notify (notify)',
        policyAutoIdle: 'Idle auto-upgrade (auto-idle)',
        policyManual: 'Manual (manual)',
        policyHint: 'notify only reports a newer release; auto-idle upgrades when the profile has been idle; manual acts only when Update is pressed.',

        secEngines: 'Engine matrix',
        secEnginesHint: 'Tier 0 probes something you install yourself; Tier 1 is strongly recommended; Tier 2 is optional specialist tooling.',
        colName: 'Name',
        colTier: 'Tier',
        colVersion: 'Version',
        colStatus: 'Status',
        colActions: 'Actions',
        enginesEmpty: 'No engine records yet. Press Verify all to probe again.',
        enginesVerified: 'Verified: {ready}/{total} ready',
        engineVerify: 'Verify',
        engineVerifying: 'Verifying…',
        engineInstall: 'Install',
        engineInstalling: 'Installing…',
        engineReinstall: 'Reinstall',
        engineUninstall: 'Uninstall',
        engineUninstalling: 'Uninstalling…',
        engineUninstallConfirm: 'Uninstall engine {name}? Its files are deleted and it must be installed again to be used.',
        engineInstalled: 'Installed {name} ({version})',
        engineUninstalled: 'Uninstalled {name}',
        engineUnsupportedNoInstall: 'Not supported on this host',
        engineNeedsDependency: 'A prerequisite is missing; install it first',
        engineExternalNoInstall: 'Externally installed; this plugin does not install it',
        engineEnvVar: 'Environment variable',
        enginePath: 'Path',
        doctorRemedyLine: 'Remedy: {remedy}',
        engineVerified: '{name} verified: {status}',
        engineProbeOutput: 'Probe output',
        engineDocs: 'Documentation',
        engineVersionUnknown: 'unknown',

        statusOk: 'Ready',
        statusMissing: 'Missing',
        statusBroken: 'Broken',
        statusUnsupportedHost: 'Unsupported host',
        statusRequiresDependency: 'Missing dependency',
        statusExternalOk: 'Detected',
        statusExternalMissing: 'Not detected',

        secVersion: 'REA version and updates',
        versionPinned: 'Pinned version',
        versionLatest: 'Registry latest',
        versionCheckedAt: 'Checked at',
        versionCheckDone: 'Latest version checked: {latest}',
        versionCheck: 'Check for updates',
        versionChecking: 'Checking…',
        versionUpgradeAny: 'Upgrade to latest',
        versionUpgradeTo: 'Upgrade to {version}',
        versionUpgrading: 'Upgrading…',
        versionRollbackTo: 'Roll back to {version}',
        versionRollingBack: 'Rolling back…',
        versionRollbackUnavailable: 'No previous version to roll back to',
        versionPinAction: 'Pin',
        versionPinning: 'Pinning…',
        versionPinPlaceholder: 'Exact version, e.g. 6.8.0',
        versionPinInvalid: 'Enter an exact version number, e.g. 6.8.0.',
        versionPinDone: 'Pinned: {version}',
        versionUpdateDone: 'Upgraded from {from} to {to}',
        versionUpToDate: 'Up to date',
        versionBehind: 'Update available',
        versionNoCheck: 'Not checked yet',
        versionPreflightTitle: 'Shadow preflight',
        versionPreflightValue: 'Server {serverVersion} · {toolCount} tools',
        versionReloadTitle: 'Reload',
        versionReloadHot: 'Hot-reloaded',
        versionReloadRestart: 'Restart DSH',
        versionPolicyLabel: 'Update policy',
        versionPolicySaved: 'Update policy saved: {policy}',
        versionNoInstallHint: 'REA is not pinned. Enter an exact version and press Pin, or import an old pin under Maintenance.',

        secDoctor: 'Capability doctor',
        doctorRun: 'Run doctor',
        doctorRunning: 'Running…',
        doctorNever: 'No doctor result yet.',
        doctorAt: 'At',
        doctorServer: 'REA version',
        doctorTools: 'Total tools',
        doctorGroups: 'Available groups',
        doctorGroupsValue: '{available}/{total}',
        doctorGapsTitle: 'Capability gaps',
        doctorNoGaps: 'No gaps: every tool group is available.',
        doctorGapCount: '{count} tools',
        doctorGapTools: 'Tools involved',
        doctorShowMore: 'Show the other {count}',
        doctorCopyReport: 'Copy report',
        doctorReportCopied: 'The diagnostics report was copied to the clipboard.',
        doctorDone: 'Doctor finished: groups {groups}/{total}, {tools} tools',
        doctorStale: 'This result is from {at} and may be stale. Run the doctor again.',
        doctorFailed: 'The doctor run failed.',
        doctorHint: 'The doctor handshakes with the REA MCP server and reads binary_session tool availability; it can take a few seconds.',
        doctorReasonUnknown: 'Unclassified reason',

        'reason.provider_unavailable': 'External engine unavailable',
        'reason.missing_binary': 'Executable not found',
        'reason.unsupported_host': 'Unsupported host',
        'reason.requires_java': 'Java required',
        'reason.requires_dependency': 'Dependency missing',
        'reason.not_implemented': 'Not implemented',
        'reason.permission_denied': 'Permission denied',
        'reason.timeout': 'Timed out',
        'reason.disabled': 'Currently disabled',

        'err.loopback_only': 'Only loopback requests are allowed.',
        'err.not_found': 'No such route (plugin version mismatch?).',
        'err.bad_json': 'The request body is not valid JSON.',
        'err.bad_request': 'The request parameters are invalid.',
        'err.profile_unwritable': 'The profile directory is not writable.',
        'err.no_engine': 'This engine has no install method.',
        'err.unknown_engine': 'Unknown engine id.',
        'err.install_failed': 'Engine installation failed.',
        'err.download_failed': 'Download failed (network or proxy).',
        'err.checksum_mismatch': 'The download failed checksum verification and was rejected.',
        'err.unsupported_host': 'This engine is not supported on this host.',
        'err.requires_dependency': 'A prerequisite is missing; install it first.',
        'err.registry_timeout': 'The registry query timed out.',
        'err.registry_unreachable': 'The registry is unreachable (offline or proxy).',
        'err.no_such_version': 'The registry has no such version.',
        'err.preflight_failed': 'The shadow preflight failed, so the upgrade was aborted.',
        'err.rollback_failed': 'The upgrade failed and the rollback failed too; inspect the pin by hand.',
        'err.reload_failed': 'The hot reload failed.',
        'err.pin_conflict': 'The pin file conflicts with the state on disk.',
        'err.rea_missing': 'rea-agents is not installed in this profile; pin a version first.',

        secMaintenance: 'Maintenance',
        maintReload: 'Hot-reload MCP row',
        maintReloading: 'Reloading…',
        maintReloadOk: 'Hot reload succeeded',
        maintReloadRestart: 'Cannot hot-reload: DSH must be restarted',
        maintReloadRestored: 'The loader had modified cordis.patch.yml; the snapshot was written back.',
        maintImportPin: 'Import old pin',
        maintImportingPin: 'Importing…',
        maintImportPinHint: 'Migrate the pinned version from dsh-rea-agents pin.json. Leave the path empty to use the default location.',
        maintImportPinPlaceholder: 'Optional: absolute path to pin.json',
        maintImported: 'Imported pin: {version}',
        maintExportReport: 'Export diagnostics report',
        maintExporting: 'Exporting…',
        maintExported: 'Exported: {name}',
        maintEngineDir: 'Engine directory',
        maintEngineDirHint: 'Engines are machine-level assets shared by every profile, located at: {home}',
        maintCopyDir: 'Copy directory',
        maintMcpRow: 'MCP row',
        maintRowPresent: 'present',
        maintRowMissing: 'missing',
        maintRowDisabled: 'disabled',
        maintLastReload: 'Last reload',
        maintNoReload: 'not reloaded yet',
      },
    };

    /**
     * The browser's own language, used whenever the shell cannot answer.
     * Matching is on the primary subtag so zh-Hans and zh-TW both land on
     * Chinese, and anything unrecognised falls through to English.
     */
    function browserLocale() {
      try {
        var tags = [];
        if (typeof navigator !== 'undefined') {
          if (Array.isArray(navigator.languages)) tags = tags.concat(navigator.languages);
          if (typeof navigator.language === 'string') tags.push(navigator.language);
        }
        for (var i = 0; i < tags.length; i += 1) {
          var primary = String(tags[i] || '').slice(0, 2).toLowerCase();
          if (primary === 'zh') return 'zh';
          if (primary === 'en') return 'en';
        }
      } catch (error) {
        // A host without navigator falls through to the shell fallback.
      }
      return 'en';
    }

    /** Narrow a BCP-47 tag to one of the two dictionaries. */
    function toLocaleId(tag) {
      return typeof tag === 'string' && tag.slice(0, 2).toLowerCase() === 'zh' ? 'zh' : 'en';
    }

    /**
     * Build a translate function for one resolved locale. An unknown locale
     * resolves through the browser rather than pinning one language, and a
     * missing key falls back to Chinese and then to the key itself, so a
     * missing sentence is visible instead of rendering "undefined".
     */
    function makeT(locale) {
      var id = locale === 'en' ? 'en' : locale === 'zh' ? 'zh' : browserLocale();
      var table = DICT[id];
      return function t(key, params) {
        var text = table[key] !== undefined ? table[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key;
        if (params === undefined) return text;
        return String(text).replace(/\{(\w+)\}/g, function (match, name) {
          return params[name] !== undefined ? String(params[name]) : match;
        });
      };
    }

    /** Translate for an already-resolved locale id. */
    function translatorFor(localeId) {
      return makeT(toLocaleId(localeId));
    }

    /** How the card decides its language. auto follows the interface. */
    var LANG_MODES = ['auto', 'zh', 'en'];

    /** The remembered manual choice, defaulting to auto. */
    function readLocalePref() {
      try {
        var stored = window.localStorage.getItem(LOCALE_KEY);
        return typeof stored === 'string' && LANG_MODES.indexOf(stored) !== -1 ? stored : 'auto';
      } catch (error) {
        return 'auto';
      }
    }

    /** Remember a choice; a store that refuses only costs persistence. */
    function writeLocalePref(mode) {
      try {
        window.localStorage.setItem(LOCALE_KEY, mode);
      } catch (error) {
        // The switch still applies for this session.
      }
    }

    /**
     * The shell's current language plus a way to hear about changes. The
     * locale service is bound in apply; until then the browser's language
     * stands in, so the card never pins itself to one language.
     */
    var shellLocale = {
      read: function () {
        return browserLocale();
      },
      subscribe: function () {
        return function () {};
      },
    };

    /**
     * Bind the shell's locale service. The active language lives in the
     * snapshot's active field; reading any other field yields undefined,
     * which compares unequal to zh and would silently pin the card to one
     * language. Centralising the read is what keeps that defect out.
     */
    function bindShellLocale(locale) {
      if (locale === undefined || locale === null) return;
      var listeners = [];
      var live = function () {
        try {
          var snapshot = locale.getLocale();
          var tag = snapshot !== undefined && typeof snapshot.active === 'string' ? snapshot.active : '';
          return tag === '' ? browserLocale() : toLocaleId(tag);
        } catch (error) {
          return browserLocale();
        }
      };
      shellLocale.read = live;
      shellLocale.subscribe = function (listener) {
        listeners.push(listener);
        return function () {
          var at = listeners.indexOf(listener);
          if (at !== -1) listeners.splice(at, 1);
        };
      };
      if (typeof locale.subscribe === 'function') {
        try {
          locale.subscribe(function () {
            var next = live();
            for (var i = 0; i < listeners.length; i += 1) {
              try {
                listeners[i](next);
              } catch (error) {
                if (typeof console !== 'undefined') console.error('[dsh-rea-powerpack] locale listener failed:', error);
              }
            }
          });
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[dsh-rea-powerpack] locale mirror skipped:', error);
        }
      }
    }

    /**
     * The stylesheet. Colours come from the shell's alias variables so the
     * card follows the interface theme; the fallbacks keep it readable on a
     * shell that renames them. Monospace is reserved for paths and versions,
     * where character alignment matters.
     */
    var CSS =
      '.rpp-page{display:flex;flex-direction:column;gap:18px;padding-top:6px}' +
      '.rpp-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}' +
      '.rpp-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}' +
      '.rpp-subtitle{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-header-right{display:flex;align-items:center;gap:8px;flex:none}' +
      '.rpp-lang{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#666);font-size:12px}' +
      '.rpp-lang select{border:none;background:transparent;color:inherit;font:inherit;font-size:12px;height:26px;padding:0 2px;outline:none;cursor:pointer}' +
      '.rpp-lang select option{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-base,#fff)}' +
      '.rpp-section{display:flex;flex-direction:column;gap:10px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09))}' +
      '.rpp-section-first{padding-top:0;border-top:0}' +
      '.rpp-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}' +
      '.rpp-section-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}' +
      '.rpp-section-sub{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}' +
      '.rpp-label{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-value{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-primary,#111);word-break:break-word;font-variant-numeric:tabular-nums}' +
      '.rpp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all}' +
      '.rpp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.rpp-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-size:12px;cursor:pointer;white-space:nowrap}' +
      '.rpp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.28))}' +
      '.rpp-btn:disabled{opacity:.55;cursor:default}' +
      '.rpp-btn-primary{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.28));font-weight:500}' +
      '.rpp-btn-sm{height:24px;padding:0 8px;font-size:11px;border-radius:6px}' +
      '.rpp-input{height:28px;min-width:150px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}' +
      '.rpp-input:focus{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.28))}' +
      '.rpp-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}' +
      '.rpp-badge-ok{color:#1a7f37;border-color:rgba(26,127,55,.35);background:rgba(26,127,55,.08)}' +
      '.rpp-badge-info{color:#0969da;border-color:rgba(9,105,218,.35);background:rgba(9,105,218,.08)}' +
      '.rpp-badge-warn{color:#9a6700;border-color:rgba(154,103,0,.35);background:rgba(154,103,0,.08)}' +
      '.rpp-badge-err{color:#cf222e;border-color:rgba(207,34,46,.35);background:rgba(207,34,46,.08)}' +
      '.rpp-table-wrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));border-radius:8px}' +
      '.rpp-table{width:100%;border-collapse:collapse;font-size:12px}' +
      '.rpp-table th{text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary,#666);padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));white-space:nowrap}' +
      '.rpp-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));vertical-align:top}' +
      '.rpp-table tr:last-child td{border-bottom:0}' +
      '.rpp-engine-name{font-weight:500;color:var(--dsw-alias-label-primary,#111)}' +
      '.rpp-engine-id{margin-top:1px;font-size:10px;color:var(--dsw-alias-label-secondary,#666);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
      '.rpp-note{padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));background:var(--dsw-alias-bg-base,#fff);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-note-title{margin:0 0 4px;font-weight:600;font-size:12px;color:var(--dsw-alias-label-primary,#111)}' +
      '.rpp-note p{margin:0}' +
      '.rpp-note-warn{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.28))}' +
      '.rpp-notice{padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));background:var(--dsw-alias-bg-base,#fff);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#111)}' +
      '.rpp-notice-ok{border-color:rgba(26,127,55,.35)}' +
      '.rpp-notice-warn{border-color:rgba(154,103,0,.4)}' +
      '.rpp-notice-err{border-color:rgba(207,34,46,.4)}' +
      '.rpp-pre{margin:0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));background:var(--dsw-alias-bg-base,#fff);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-gap{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09))}' +
      '.rpp-gap-head{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}' +
      '.rpp-gap-reason{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}' +
      '.rpp-gap-remedy{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-chips{display:flex;flex-wrap:wrap;gap:4px}' +
      '.rpp-chip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:16px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09));color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-fine{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#666);opacity:.85}' +
      '.rpp-summary{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}' +
      '.rpp-details{border-radius:8px}' +
      '.rpp-details summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}';

    /** Inject the stylesheet once, keyed by a stable id. */
    function useStyles() {
      useEffect(function () {
        var id = 'dsh-rea-powerpack-styles';
        if (typeof document === 'undefined' || document.getElementById(id) !== null) return;
        var style = document.createElement('style');
        style.id = id;
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);
    }

    // ---------------------------------------------------------------- plumbing

    /** An error the host half answered with, carrying its stable error code. */
    function ApiError(code, detail, status) {
      this.name = 'ApiError';
      this.code = code;
      this.detail = detail === undefined ? null : detail;
      this.status = status === undefined ? null : status;
      this.message = code;
    }
    ApiError.prototype = Object.create(Error.prototype);
    ApiError.prototype.constructor = ApiError;

    /**
     * Turn a failed response into an ApiError. The host contract sends
     * {ok:false,error:{code,detail}} for handled failures and {code:'not_found'}
     * for an unknown route, so both shapes are read here; a transport-level
     * failure (non-JSON body, gateway error) still gets a code derived from the
     * status so the card never shows a blank sentence.
     */
    function toApiError(payload, status, text) {
      var code = null;
      var detail = null;
      if (payload && typeof payload === 'object') {
        if (payload.error && typeof payload.error === 'object') {
          if (typeof payload.error.code === 'string') code = payload.error.code;
          if (typeof payload.error.detail === 'string') detail = payload.error.detail;
          else if (typeof payload.error.message === 'string') detail = payload.error.message;
        } else if (typeof payload.code === 'string') {
          code = payload.code;
          if (typeof payload.detail === 'string') detail = payload.detail;
        } else if (typeof payload.reason === 'string') {
          detail = payload.reason;
        }
      }
      if (code === null) code = 'http_' + status;
      if (detail === null && typeof text === 'string' && text !== '' && text.length <= 400) detail = text;
      return new ApiError(code, detail, status);
    }

    /**
     * Read the host's answer as JSON, or as text for the report route. A body
     * that is not JSON is only an error when the status says so: GET /report
     * answers markdown, which is a legitimate 200.
     */
    function apiCall(route, method, body) {
      if (typeof fetch !== 'function') {
        return Promise.reject(new ApiError('bad_request', 'fetch is unavailable in this shell'));
      }
      var init = { method: method, headers: {} };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      } else if (method === 'POST') {
        init.headers['content-type'] = 'application/json';
        init.body = '{}';
      }
      return fetch(API_PREFIX + '/' + route, init).then(function (response) {
        return response.text().then(function (text) {
          var payload = null;
          var parsed = false;
          if (text !== '') {
            try {
              payload = JSON.parse(text);
              parsed = true;
            } catch (error) {
              payload = null;
            }
          }
          if (!response.ok) throw toApiError(parsed ? payload : null, response.status, text);
          if (parsed && payload && payload.error && typeof payload.error === 'object') {
            throw toApiError(payload, response.status, text);
          }
          if (!parsed) return { text: text, status: response.status };
          return payload === null ? {} : payload;
        });
      });
    }

    /**
     * Sentence plus optional detail for a thrown value. ApiError carries a
     * stable code the dictionary owns; anything else is a transport failure,
     * where the raw message is the only useful thing to show.
     */
    function describeError(t, error) {
      if (error && typeof error.code === 'string' && error.code !== '') {
        var key = 'err.' + error.code;
        var translated = t(key);
        return {
          text: translated === key ? t('errGeneric', { code: error.code }) : translated,
          detail: typeof error.detail === 'string' && error.detail !== '' ? error.detail : null,
          code: error.code,
        };
      }
      var reason = error && error.message ? error.message : String(error);
      return { text: t('requestFailedWith', { reason: reason }), detail: null, code: null };
    }

    /** Sentence for a 200 answer that still says ok:false. */
    function payloadFailure(t, payload) {
      var error = payload && payload.error && typeof payload.error === 'object' ? payload.error : null;
      if (error && typeof error.code === 'string') {
        return describeError(t, { code: error.code, detail: typeof error.detail === 'string' ? error.detail : null });
      }
      if (payload && typeof payload.reason === 'string' && payload.reason !== '') {
        return { text: t('actionFailedWith', { reason: payload.reason }), detail: null };
      }
      return { text: t('actionFailedWith', { reason: t('unknown') }), detail: null };
    }

    /** Copy text, preferring the async clipboard and degrading to a selection. */
    function writeClipboard(text) {
      var value = String(text);
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(value);
      }
      return new Promise(function (resolve, reject) {
        try {
          if (typeof document === 'undefined') throw new Error('clipboard is unavailable');
          var area = document.createElement('textarea');
          area.value = value;
          area.setAttribute('readonly', 'readonly');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          var copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
          document.body.removeChild(area);
          if (copied) resolve();
          else reject(new Error('clipboard is unavailable'));
        } catch (error) {
          reject(error);
        }
      });
    }

    /** Save text as a file through a blob URL; the anchor is removed after use. */
    function downloadText(name, text) {
      try {
        var blob = new Blob([String(text)], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 0);
      } catch (error) {
        throw new Error(error && error.message ? error.message : 'download is unavailable');
      }
    }

    /** A filename-safe local timestamp. */
    function stamp() {
      var now = new Date();
      var pad = function (value) {
        var text = String(value);
        return text.length < 2 ? '0' + text : text;
      };
      return (
        String(now.getFullYear()) +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        '-' +
        pad(now.getHours()) +
        pad(now.getMinutes()) +
        pad(now.getSeconds())
      );
    }

    /** Contract versions are exact semver - a range would hide which build runs. */
    var VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

    function isExactVersion(value) {
      return typeof value === 'string' && VERSION_RE.test(value.trim());
    }

    /** Where the host half keeps machine-level state when settings do not override it. */
    function defaultPowerpackHome(platform) {
      if (platform === 'win32') return '%LOCALAPPDATA%\\rea-powerpack';
      if (platform === 'darwin') return '~/Library/Application Support/rea-powerpack';
      return '$XDG_STATE_HOME/rea-powerpack (default ~/.local/state/rea-powerpack)';
    }

    var STATUS_LABEL_KEYS = {
      ok: 'statusOk',
      missing: 'statusMissing',
      broken: 'statusBroken',
      unsupported_host: 'statusUnsupportedHost',
      requires_dependency: 'statusRequiresDependency',
      external_ok: 'statusExternalOk',
      external_missing: 'statusExternalMissing',
    };

    var STATUS_TONES = {
      ok: 'ok',
      external_ok: 'info',
      missing: 'warn',
      broken: 'err',
      unsupported_host: 'warn',
      requires_dependency: 'warn',
      external_missing: 'muted',
    };

    function statusLabel(t, status) {
      var key = STATUS_LABEL_KEYS[status];
      return key === undefined ? status || t('unknown') : t(key);
    }

    /** The dictionary owns the wording for known reasons; unknown ones stay raw. */
    function reasonLabel(t, reason) {
      if (typeof reason !== 'string' || reason === '') return t('doctorReasonUnknown');
      var key = 'reason.' + reason;
      var translated = t(key);
      return translated === key ? reason : translated;
    }

    /** Policy ids are stable; only their presentation is translated. */
    function policyLabel(t, policy) {
      if (policy === 'auto-idle') return t('policyAutoIdle');
      if (policy === 'manual') return t('policyManual');
      return t('policyNotify');
    }

    /** pinnedFrom is a small enum written by the host half. */
    function pinnedFromLabel(t, source) {
      if (typeof source !== 'string' || source === '') return t('unknown');
      var key = 'pinnedFrom.' + source;
      var translated = t(key);
      return translated === key ? source : translated;
    }

    /**
     * Whether the matrix may offer an install button. The host half sends an
     * explicit installable flag; the fallback only guesses for older hosts,
     * where a plain missing/broken status is the only signal available.
     */
    function engineInstallable(engine) {
      if (engine && typeof engine.installable === 'boolean') return engine.installable;
      return engine !== null && engine !== undefined && (engine.status === 'missing' || engine.status === 'broken');
    }

    /** Managed engines can be removed; probe-only engines cannot. */
    function engineManaged(engine) {
      return engine !== null && engine !== undefined && engine.managed === true;
    }

    /** Ready count over an engine array. */
    function countReady(engines) {
      var ready = 0;
      for (var i = 0; i < engines.length; i += 1) {
        if (engines[i] && (engines[i].status === 'ok' || engines[i].status === 'external_ok')) ready += 1;
      }
      return ready;
    }

    // ------------------------------------------------------------- presentation

    /** A labelled fact in a summary grid. */
    function Fact(props) {
      return h(
        'div',
        null,
        h('p', { className: 'rpp-label' }, props.label),
        h('p', { className: 'rpp-value' + (props.mono ? ' rpp-mono' : ''), title: props.title }, props.value),
      );
    }

    /** A status pill. */
    function Badge(props) {
      return h(
        'span',
        {
          className: 'rpp-badge' + (props.tone ? ' rpp-badge-' + props.tone : ''),
          title: props.title,
        },
        props.children,
      );
    }

    /** A titled explanatory note. */
    function Note(props) {
      return h(
        'div',
        { className: 'rpp-note' + (props.warn ? ' rpp-note-warn' : '') },
        props.title === undefined ? null : h('p', { className: 'rpp-note-title' }, props.title),
        h('p', null, props.children),
      );
    }

    /**
     * One button. Busy is expressed on the button itself, so a click always has
     * an immediate visible answer even when the host takes a minute.
     */
    function Btn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'rpp-btn' + (props.primary ? ' rpp-btn-primary' : '') + (props.small ? ' rpp-btn-sm' : ''),
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.disabled === true ? undefined : props.onClick,
        },
        props.busy === true ? props.busyLabel : props.label,
      );
    }

    /** Section chrome: heading, optional hint, optional actions, then content. */
    function Panel(props) {
      return h(
        'section',
        { className: 'rpp-section' + (props.first ? ' rpp-section-first' : '') },
        h(
          'div',
          { className: 'rpp-section-head' },
          h(
            'div',
            null,
            h('h3', { className: 'rpp-section-title' }, props.title),
            props.hint === undefined ? null : h('p', { className: 'rpp-section-sub' }, props.hint),
          ),
          props.actions === undefined ? null : h('div', { className: 'rpp-row' }, props.actions),
        ),
        props.children,
      );
    }

    /**
     * Language control. auto follows the interface and is the default; a
     * pinned language overrides it and is remembered across reloads. The two
     * language names stay in their own language by design.
     */
    function LangPicker(props) {
      return h(
        'label',
        { className: 'rpp-lang', title: props.t('langLabel') },
        h('span', null, props.t('langLabel')),
        h(
          'select',
          {
            value: props.pref,
            'aria-label': props.t('langLabel'),
            onChange: function (event) {
              props.onChange(event.target.value);
            },
          },
          h('option', { value: 'auto' }, props.t('langAuto')),
          h('option', { value: 'zh' }, '中文'),
          h('option', { value: 'en' }, 'English'),
        ),
      );
    }

    /** The page header: title, subtitle, language control and a refresh. */
    function renderHeader(t, pref, setPref, onRefresh, busy, loadedAt) {
      return h(
        'div',
        { className: 'rpp-header' },
        h(
          'div',
          null,
          h('h2', { className: 'rpp-title' }, t('pageTitle')),
          h('p', { className: 'rpp-subtitle' }, t('pageSubtitle')),
          loadedAt === null
            ? null
            : h('p', { className: 'rpp-section-sub', style: { marginTop: '2px' } }, t('doctorAt') + ' ' + loadedAt),
        ),
        h(
          'div',
          { className: 'rpp-header-right' },
          h(LangPicker, {
            t: t,
            pref: pref,
            onChange: function (mode) {
              setPref(mode);
            },
          }),
          h(Btn, {
            label: t('refresh'),
            disabled: busy !== null,
            onClick: onRefresh,
          }),
        ),
      );
    }

    /** Pending, success and failure all look different; failure can be expanded. */
    function renderNotice(t, notice) {
      if (notice === null || notice === undefined) return null;
      var tone =
        notice.kind === 'ok' ? 'rpp-notice-ok' : notice.kind === 'warn' ? 'rpp-notice-warn' : 'rpp-notice-err';
      var children = [h('p', { key: 'text' }, notice.text)];
      if (notice.detail !== null && notice.detail !== undefined && notice.detail !== '') {
        if (notice.kind === 'ok') {
          children.push(
            h('pre', { key: 'detail', className: 'rpp-pre', style: { marginTop: '6px' } }, notice.detail),
          );
        } else {
          children.push(
            h(
              'details',
              { key: 'detail', className: 'rpp-details', style: { marginTop: '6px' } },
              h('summary', null, t('details')),
              h('pre', { className: 'rpp-pre' }, notice.detail),
            ),
          );
        }
      }
      return h('div', { className: 'rpp-notice ' + tone, role: 'status', 'aria-live': 'polite' }, children);
    }

    /** Host-level warnings, shown before the sections that would explain them. */
    function renderWarnings(t, model) {
      var items = [];
      if (model.writable === false) {
        items.push(h(Note, { key: 'writable', warn: true }, t('writableWarning')));
      }
      if (model.conflict !== null) {
        items.push(
          h(
            Note,
            { key: 'conflict', warn: true, title: t('conflictTitle') },
            t('conflictBody', { detail: model.conflict.detail || model.conflict.kind || 'rea' }),
          ),
        );
      }
      if (model.mcpPresent === false) {
        items.push(h(Note, { key: 'mcp-missing', warn: true }, t('mcpRowMissing')));
      }
      if (model.mcpDisabled === true) {
        items.push(h(Note, { key: 'mcp-disabled', warn: true }, t('mcpRowDisabled')));
      }
      var warning = model.rea && typeof model.rea.enginesWarning === 'string' ? model.rea.enginesWarning : '';
      if (warning !== '') {
        items.push(h(Note, { key: 'engines-warning', title: t('enginesWarningTitle') }, warning));
      }
      return items;
    }

    /** Section 1: the one-screen answer to "what do I have". */
    function renderOverview(t, model) {
      var facts = [
        h(Fact, { key: 'rea', label: t('reaVersion'), value: model.pinned === null ? t('reaNotInstalled') : model.pinned, mono: model.pinned !== null }),
        h(Fact, { key: 'pin', label: t('pinState'), value: model.installed ? t('pinPinned') : t('pinNotPinned') }),
        h(Fact, { key: 'requested', label: t('pinRequested'), value: model.requested === null ? t('none') : model.requested, mono: true }),
        h(Fact, { key: 'engines', label: t('enginesReady'), value: t('enginesReadyValue', { ready: model.ready, total: model.total }) }),
        h(Fact, {
          key: 'doctor',
          label: t('doctorLast'),
          value: model.doctorInfo.lastAt ? String(model.doctorInfo.lastAt) + (model.doctorInfo.stale === true ? ' · ' + t('doctorStaleShort') : '') : t('never'),
        }),
        h(Fact, { key: 'policy', label: t('updatePolicy'), value: policyLabel(t, model.policy) }),
        h(Fact, { key: 'platform', label: t('hostPlatform'), value: model.host.platform ? String(model.host.platform) : t('unknown'), mono: true }),
        h(Fact, { key: 'node', label: t('hostNode'), value: model.host.node ? String(model.host.node) : t('unknown'), mono: true }),
        h(Fact, { key: 'java', label: t('hostJava'), value: model.host.javaHome ? String(model.host.javaHome) : t('notDetected'), mono: true }),
        h(Fact, { key: 'ghidra', label: t('hostGhidra'), value: model.host.ghidraDir ? String(model.host.ghidraDir) : t('notDetected'), mono: true }),
      ];
      if (model.rea.pinnedAt) {
        facts.push(h(Fact, { key: 'pinnedAt', label: t('pinPinnedAt'), value: String(model.rea.pinnedAt), mono: true }));
      }
      if (model.rea.pinnedFrom) {
        facts.push(h(Fact, { key: 'pinnedFrom', label: t('pinPinnedFrom'), value: pinnedFromLabel(t, model.rea.pinnedFrom) }));
      }
      if (model.rea.source) {
        facts.push(h(Fact, { key: 'source', label: t('pinSource'), value: String(model.rea.source), mono: true }));
      }
      if (model.data.profileDir) {
        facts.push(h(Fact, { key: 'profile', label: t('profileDir'), value: String(model.data.profileDir), mono: true }));
      }
      return h(
        Panel,
        { title: t('secOverview'), first: true },
        h('div', { className: 'rpp-facts' }, facts),
        model.unsupported > 0
          ? h('p', { className: 'rpp-empty' }, t('enginesUnsupportedCount', { count: model.unsupported }))
          : null,
      );
    }

    /** One matrix row, plus an expanded detail row when asked for. */
    function renderEngineRow(t, engine, index, ctx) {
      var id = typeof engine.id === 'string' ? engine.id : 'engine-' + index;
      var status = typeof engine.status === 'string' ? engine.status : 'missing';
      var anyoneBusy = ctx.busy !== null;
      var verifying = ctx.busy === 'verify:' + id;
      var installing = ctx.busy === 'install:' + id;
      var uninstalling = ctx.busy === 'uninstall:' + id;
      var open = ctx.expanded === 'engine:' + id;

      var buttons = [];
      if (status !== 'unsupported_host') {
        buttons.push(
          h(Btn, {
            key: 'verify',
            small: true,
            label: t('engineVerify'),
            busy: verifying,
            busyLabel: t('engineVerifying'),
            disabled: anyoneBusy,
            title: anyoneBusy && !verifying ? t('busyHint') : undefined,
            onClick: function () {
              ctx.onVerify(id);
            },
          }),
        );
      }
      if (engineInstallable(engine)) {
        buttons.push(
          h(Btn, {
            key: 'install',
            small: true,
            primary: true,
            label: status === 'broken' ? t('engineReinstall') : t('engineInstall'),
            busy: installing,
            busyLabel: t('engineInstalling'),
            disabled: anyoneBusy,
            title: anyoneBusy && !installing ? t('busyHint') : undefined,
            onClick: function () {
              ctx.onInstall(id);
            },
          }),
        );
      }
      if (engineManaged(engine)) {
        buttons.push(
          h(Btn, {
            key: 'uninstall',
            small: true,
            label: t('engineUninstall'),
            busy: uninstalling,
            busyLabel: t('engineUninstalling'),
            disabled: anyoneBusy,
            onClick: function () {
              ctx.onUninstall(id, engine.name || id);
            },
          }),
        );
      }
      buttons.push(
        h(Btn, {
          key: 'details',
          small: true,
          label: open ? t('hideDetails') : t('details'),
          disabled: false,
          onClick: function () {
            ctx.onToggle('engine:' + id);
          },
        }),
      );

      var badgeTitle = undefined;
      if (status === 'unsupported_host') badgeTitle = t('engineUnsupportedNoInstall');
      else if (status === 'external_missing' || status === 'external_ok') badgeTitle = t('engineExternalNoInstall');
      else if (status === 'requires_dependency') badgeTitle = t('engineNeedsDependency');

      var rows = [
        h(
          'tr',
          { key: id },
          h(
            'td',
            null,
            h('div', { className: 'rpp-engine-name' }, engine.name ? String(engine.name) : id),
            h('div', { className: 'rpp-engine-id' }, id + (engine.envVar ? ' · ' + engine.envVar : '')),
          ),
          h('td', null, typeof engine.tier === 'number' ? 'T' + engine.tier : t('unknown')),
          h('td', { className: 'rpp-mono' }, engine.version ? String(engine.version) : t('engineVersionUnknown')),
          h('td', null, h(Badge, { tone: STATUS_TONES[status] || 'muted', title: badgeTitle }, statusLabel(t, status))),
          h('td', null, h('div', { className: 'rpp-row' }, buttons)),
        ),
      ];

      if (open) {
        var detailFacts = [];
        if (engine.envVar) detailFacts.push(h(Fact, { key: 'env', label: t('engineEnvVar'), value: String(engine.envVar), mono: true }));
        if (engine.path) detailFacts.push(h(Fact, { key: 'path', label: t('enginePath'), value: String(engine.path), mono: true }));
        if (engine.docs) detailFacts.push(h(Fact, { key: 'docs', label: t('engineDocs'), value: String(engine.docs), mono: true }));
        var detailChildren = [];
        if (detailFacts.length > 0) detailChildren.push(h('div', { key: 'facts', className: 'rpp-facts' }, detailFacts));
        if (engine.remedy) {
          detailChildren.push(
            h('p', { key: 'remedy', className: 'rpp-gap-remedy' }, t('doctorRemedyLine', { remedy: String(engine.remedy) })),
          );
        }
        if (engine.probeOutput) {
          detailChildren.push(
            h(
              'div',
              { key: 'probe' },
              h('p', { className: 'rpp-label' }, t('engineProbeOutput')),
              h('pre', { className: 'rpp-pre' }, String(engine.probeOutput)),
            ),
          );
        }
        if (detailChildren.length === 0) {
          detailChildren.push(h('p', { key: 'empty', className: 'rpp-empty' }, t('none')));
        }
        rows.push(
          h(
            'tr',
            { key: id + '-detail' },
            h('td', { colSpan: 5 }, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, detailChildren)),
          ),
        );
      }
      return rows;
    }

    /** Section 2: one row per catalog engine, with the actions that make sense. */
    function renderEngines(t, model, actions, busy, expanded, onToggle) {
      var rows = [];
      for (var i = 0; i < model.engines.length; i += 1) {
        var engine = model.engines[i];
        if (engine === null || typeof engine !== 'object') continue;
        var rendered = renderEngineRow(t, engine, i, {
          busy: busy,
          expanded: expanded,
          onVerify: actions.verifyEngine,
          onInstall: actions.installEngine,
          onUninstall: actions.uninstallEngine,
          onToggle: onToggle,
        });
        for (var r = 0; r < rendered.length; r += 1) rows.push(rendered[r]);
      }
      if (model.engines.length === 0) {
        rows.push(h('tr', { key: 'empty' }, h('td', { colSpan: 5, className: 'rpp-empty' }, t('enginesEmpty'))));
      }
      return h(
        Panel,
        {
          title: t('secEngines'),
          hint: t('secEnginesHint'),
          actions: [
            h(Btn, {
              key: 'verify-all',
              label: t('refreshAll'),
              busy: busy === 'verify-all',
              busyLabel: t('engineVerifying'),
              disabled: busy !== null,
              onClick: actions.verifyAll,
            }),
          ],
        },
        h(
          'div',
          { className: 'rpp-table-wrap' },
          h(
            'table',
            { className: 'rpp-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('colName')),
                h('th', null, t('colTier')),
                h('th', null, t('colVersion')),
                h('th', null, t('colStatus')),
                h('th', null, t('colActions')),
              ),
            ),
            h('tbody', null, rows),
          ),
        ),
      );
    }

    /** Section 3: pinned version, check/upgrade/rollback, policy and the last result. */
    function renderVersion(t, model, actions, busy, pinDraft, setPinDraft, lastResult) {
      var latest = typeof model.rea.latestKnown === 'string' && model.rea.latestKnown !== '' ? model.rea.latestKnown : null;
      var relation = null;
      if (model.pinned !== null && latest !== null) relation = model.pinned === latest ? 0 : 1;
      var facts = [
        h(Fact, { key: 'pinned', label: t('versionPinned'), value: model.pinned === null ? t('reaNotInstalled') : model.pinned, mono: true }),
        h(Fact, { key: 'latest', label: t('versionLatest'), value: latest === null ? t('versionNoCheck') : latest, mono: latest !== null }),
        h(Fact, { key: 'checked', label: t('versionCheckedAt'), value: model.rea.checkedAt ? String(model.rea.checkedAt) : t('never'), mono: true }),
        h(Fact, { key: 'policy', label: t('versionPolicyLabel'), value: policyLabel(t, model.policy) }),
      ];
      var relationBadge =
        relation === null
          ? null
          : relation === 0
            ? h(Badge, { tone: 'ok' }, t('versionUpToDate'))
            : h(Badge, { tone: 'info' }, t('versionBehind'));

      var actionsRow = [
        h(Btn, {
          key: 'check',
          label: t('versionCheck'),
          busy: busy === 'check',
          busyLabel: t('versionChecking'),
          disabled: busy !== null,
          onClick: actions.check,
        }),
        h(Btn, {
          key: 'upgrade',
          primary: true,
          label: latest === null ? t('versionUpgradeAny') : t('versionUpgradeTo', { version: latest }),
          busy: busy === 'update',
          busyLabel: t('versionUpgrading'),
          disabled: busy !== null,
          onClick: function () {
            actions.update(latest === null ? undefined : latest);
          },
        }),
        h(Btn, {
          key: 'rollback',
          label: model.retainedFrom === null ? t('versionRollbackUnavailable') : t('versionRollbackTo', { version: model.retainedFrom }),
          busy: busy === 'rollback',
          busyLabel: t('versionRollingBack'),
          disabled: busy !== null || model.retainedFrom === null,
          title: model.retainedFrom === null ? t('versionRollbackUnavailable') : undefined,
          onClick: function () {
            actions.update(model.retainedFrom);
          },
        }),
      ];

      var pinRow = [
        h('input', {
          key: 'pin-input',
          className: 'rpp-input',
          type: 'text',
          value: pinDraft,
          placeholder: t('versionPinPlaceholder'),
          'aria-label': t('versionPinPlaceholder'),
          onChange: function (event) {
            setPinDraft(event.target.value);
          },
        }),
        h(Btn, {
          key: 'pin',
          label: t('versionPinAction'),
          busy: busy === 'pin',
          busyLabel: t('versionPinning'),
          disabled: busy !== null || pinDraft.trim() === '',
          onClick: actions.pin,
        }),
      ];

      var policySelect = h(
        'div',
        { className: 'rpp-row' },
        h('span', { className: 'rpp-label' }, t('versionPolicyLabel')),
        h(
          'select',
          {
            className: 'rpp-input',
            value: model.policy,
            'aria-label': t('versionPolicyLabel'),
            disabled: busy !== null,
            onChange: function (event) {
              actions.setPolicy(event.target.value);
            },
          },
          h('option', { value: 'notify' }, policyLabel(t, 'notify')),
          h('option', { value: 'auto-idle' }, policyLabel(t, 'auto-idle')),
          h('option', { value: 'manual' }, policyLabel(t, 'manual')),
        ),
      );

      var children = [
        h('div', { key: 'facts', className: 'rpp-facts' }, facts),
        relationBadge === null ? null : h('div', { key: 'relation', className: 'rpp-row' }, relationBadge),
        h('div', { key: 'actions', className: 'rpp-row' }, actionsRow),
        h('div', { key: 'pin', className: 'rpp-row' }, pinRow),
        h('p', { key: 'policy-hint', className: 'rpp-empty' }, t('policyHint')),
        policySelect,
        model.pinned === null ? h(Note, { key: 'no-install', warn: true }, t('versionNoInstallHint')) : null,
      ];

      if (lastResult !== null && typeof lastResult === 'object') {
        var resultFacts = [];
        var preflight = lastResult.preflight;
        if (preflight) {
          resultFacts.push(
            h(Fact, {
              key: 'preflight',
              label: t('versionPreflightTitle'),
              value: t('versionPreflightValue', {
                serverVersion: preflight.serverVersion === undefined ? t('unknown') : preflight.serverVersion,
                toolCount: preflight.toolCount === undefined ? '?' : preflight.toolCount,
              }),
              mono: true,
            }),
          );
        }
        var reload = lastResult.reload;
        if (reload) {
          resultFacts.push(
            h(Fact, {
              key: 'reload',
              label: t('versionReloadTitle'),
              value: reload.mode === 'hot' ? t('versionReloadHot') : t('versionReloadRestart') + (reload.reason ? ' · ' + reload.reason : ''),
            }),
          );
        }
        if (resultFacts.length > 0) children.push(h('div', { key: 'result', className: 'rpp-facts' }, resultFacts));
      }

      return h(Panel, { title: t('secVersion') }, children);
    }

    /** One doctor gap: reason, count, remedy and the tools it touches. */
    function renderGap(t, gap, index, ctx) {
      var tools = Array.isArray(gap.tools) ? gap.tools : [];
      var key = 'gap:' + index;
      var open = ctx.expanded === key;
      var shown = open ? tools : tools.slice(0, 6);
      var hidden = tools.length - shown.length;
      var chips = [];
      for (var i = 0; i < shown.length; i += 1) {
        chips.push(h('span', { key: 'tool-' + i, className: 'rpp-chip' }, String(shown[i])));
      }
      var count = typeof gap.count === 'number' ? gap.count : tools.length;
      var children = [
        h(
          'div',
          { key: 'head', className: 'rpp-gap-head' },
          h('p', { className: 'rpp-gap-reason' }, reasonLabel(t, gap.reason)),
          h(Badge, { tone: 'warn' }, t('doctorGapCount', { count: count })),
        ),
      ];
      if (gap.remedy) {
        children.push(h('p', { key: 'remedy', className: 'rpp-gap-remedy' }, t('doctorRemedyLine', { remedy: String(gap.remedy) })));
      }
      if (tools.length > 0) {
        children.push(
          h(
            'div',
            { key: 'tools' },
            h('p', { className: 'rpp-label' }, t('doctorGapTools')),
            h('div', { className: 'rpp-chips' }, chips),
            hidden > 0 && !open
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'rpp-btn rpp-btn-sm',
                    style: { marginTop: '4px' },
                    onClick: function () {
                      ctx.onToggle(key);
                    },
                  },
                  t('doctorShowMore', { count: hidden }),
                )
              : null,
          ),
        );
      }
      return h('div', { key: key, className: 'rpp-gap' }, children);
    }

    /** Section 4: the capability doctor, grouped by gap reason. */
    function renderDoctor(t, model, actions, busy, doctor, expanded, onToggle) {
      var loading = doctor.status === 'loading';
      var ready = doctor.status === 'ready' && doctor.data && typeof doctor.data === 'object';
      var failed = doctor.status === 'failed';
      var report = ready ? doctor.data : null;

      var at = report && report.at ? report.at : model.doctorInfo.lastAt;
      var serverVersion = report && report.serverVersion ? report.serverVersion : null;
      var toolCount = report && report.toolCount !== undefined ? report.toolCount : model.doctorInfo.toolCount;
      var groupsAvailable = report && report.availableGroups !== undefined ? report.availableGroups : model.doctorInfo.availableGroups;
      var groupsTotal = report && report.totalGroups !== undefined ? report.totalGroups : model.doctorInfo.totalGroups;

      var facts = [
        h(Fact, { key: 'at', label: t('doctorAt'), value: at ? String(at) : t('never'), mono: true }),
        h(Fact, { key: 'server', label: t('doctorServer'), value: serverVersion ? String(serverVersion) : t('unknown'), mono: serverVersion !== null }),
        h(Fact, { key: 'tools', label: t('doctorTools'), value: toolCount === undefined || toolCount === null ? t('unknown') : String(toolCount) }),
        h(Fact, {
          key: 'groups',
          label: t('doctorGroups'),
          value:
            groupsAvailable === undefined || groupsTotal === undefined
              ? t('unknown')
              : t('doctorGroupsValue', { available: groupsAvailable, total: groupsTotal }),
        }),
      ];

      var children = [
        h('div', { key: 'facts', className: 'rpp-facts' }, facts),
        h('p', { key: 'hint', className: 'rpp-empty' }, t('doctorHint')),
      ];

      if (model.doctorInfo.stale === true && at) {
        children.push(h(Note, { key: 'stale', warn: true }, t('doctorStale', { at: String(at) })));
      }

      if (loading) {
        children.push(h('p', { key: 'loading', className: 'rpp-empty' }, t('doctorRunning')));
      } else if (failed) {
        children.push(
          h(
            'div',
            { key: 'failed', className: 'rpp-note rpp-note-warn' },
            h('p', null, t('doctorFailed')),
            doctor.error && doctor.error.detail ? h('pre', { className: 'rpp-pre' }, String(doctor.error.detail)) : null,
          ),
        );
      } else if (report !== null) {
        var gaps = Array.isArray(report.gaps) ? report.gaps : [];
        if (gaps.length === 0) {
          children.push(h('p', { key: 'nogaps', className: 'rpp-empty' }, t('doctorNoGaps')));
        } else {
          children.push(h('p', { key: 'gaps-title', className: 'rpp-label' }, t('doctorGapsTitle')));
          for (var i = 0; i < gaps.length; i += 1) {
            if (gaps[i] === null || typeof gaps[i] !== 'object') continue;
            children.push(
              renderGap(t, gaps[i], i, {
                expanded: expanded,
                onToggle: onToggle,
              }),
            );
          }
        }
      } else {
        children.push(h('p', { key: 'never', className: 'rpp-empty' }, t('doctorNever')));
      }

      return h(
        Panel,
        {
          title: t('secDoctor'),
          actions: [
            h(Btn, {
              key: 'run',
              primary: true,
              label: t('doctorRun'),
              busy: busy === 'doctor',
              busyLabel: t('doctorRunning'),
              disabled: busy !== null,
              onClick: actions.runDoctor,
            }),
            h(Btn, {
              key: 'copy',
              label: t('doctorCopyReport'),
              busy: busy === 'copy-report',
              busyLabel: t('copy'),
              disabled: busy !== null,
              onClick: actions.copyReport,
            }),
          ],
        },
        children,
      );
    }

    /** Section 5: the actions that fix or migrate things, not just report them. */
    function renderMaintenance(t, model, actions, busy, importPath, setImportPath, lastReload, engineHome) {
      var mcpState = model.mcpPresent === false ? t('maintRowMissing') : model.mcpDisabled ? t('maintRowDisabled') : t('maintRowPresent');
      var rowId = model.mcp.rowId ? String(model.mcp.rowId) : 'rea-powerpack-mcp';
      var facts = [
        h(Fact, { key: 'mcp', label: t('maintMcpRow'), value: rowId + ' · ' + mcpState, mono: true }),
        h(Fact, { key: 'dir', label: t('maintEngineDir'), value: model.engineRoot, mono: true }),
        h(Fact, {
          key: 'reload',
          label: t('maintLastReload'),
          value:
            lastReload === null
              ? t('maintNoReload')
              : lastReload.mode === 'hot'
                ? t('maintReloadOk')
                : t('maintReloadRestart') + (lastReload.reason ? ' · ' + lastReload.reason : ''),
        }),
      ];
      return h(
        Panel,
        { title: t('secMaintenance') },
        h('div', { className: 'rpp-facts' }, facts),
        h(
          'div',
          { className: 'rpp-row' },
          h(Btn, {
            key: 'reload',
            label: t('maintReload'),
            busy: busy === 'reload',
            busyLabel: t('maintReloading'),
            disabled: busy !== null,
            onClick: actions.reloadMcp,
          }),
          h(Btn, {
            key: 'export',
            label: t('maintExportReport'),
            busy: busy === 'export-report',
            busyLabel: t('maintExporting'),
            disabled: busy !== null,
            onClick: actions.exportReport,
          }),
          h(Btn, {
            key: 'copy-dir',
            label: t('maintCopyDir'),
            disabled: busy !== null,
            onClick: function () {
              actions.copyEngineDir(model.engineRoot);
            },
          }),
        ),
        h('p', { key: 'dir-hint', className: 'rpp-empty' }, t('maintEngineDirHint', { home: engineHome })),
        h(
          'div',
          { key: 'import', className: 'rpp-row' },
          h('input', {
            className: 'rpp-input',
            type: 'text',
            value: importPath,
            placeholder: t('maintImportPinPlaceholder'),
            'aria-label': t('maintImportPinHint'),
            onChange: function (event) {
              setImportPath(event.target.value);
            },
          }),
          h(Btn, {
            label: t('maintImportPin'),
            busy: busy === 'import-pin',
            busyLabel: t('maintImportingPin'),
            disabled: busy !== null,
            onClick: actions.importPin,
          }),
        ),
        h('p', { key: 'import-hint', className: 'rpp-empty' }, t('maintImportPinHint')),
      );
    }

    // -------------------------------------------------------------- page model

    /** The one-line summary the bundle seat renders instead of the full page. */
    function summaryText(t, model, snap) {
      if (snap.status === 'loading') return t('summaryLoading');
      if (snap.status === 'error') {
        return t('summaryFailed', { reason: snap.error ? snap.error.text : t('unknown') });
      }
      return t('summaryLine', {
        ready: model.ready,
        total: model.total,
        rea: model.pinned === null ? t('reaNotInstalled') : model.pinned,
        policy: policyLabel(t, model.policy),
      });
    }

    /** Where engine directories live, for display: settings override or the default home. */
    function engineRootDisplay(settings, host) {
      if (settings && typeof settings.engineRoot === 'string' && settings.engineRoot !== '') {
        return settings.engineRoot;
      }
      var home = defaultPowerpackHome(host && host.platform ? host.platform : 'win32');
      return home + (host && host.platform === 'win32' ? '\\engines' : '/engines');
    }

    function findEngine(data, id) {
      var engines = data && Array.isArray(data.engines) ? data.engines : [];
      for (var i = 0; i < engines.length; i += 1) {
        if (engines[i] && engines[i].id === id) return engines[i];
      }
      return null;
    }

    function readyCountOf(data) {
      return countReady(data && Array.isArray(data.engines) ? data.engines : []);
    }

    function engineCountOf(data) {
      return data && Array.isArray(data.engines) ? data.engines.length : 0;
    }

    /**
     * Fold the host half's /state answer into the shape the renderers read.
     * Field access is total here rather than in each renderer: one absent
     * object must not make three cards disagree about what the host said, and
     * a snapshot taken before a field existed must still render.
     */
    function buildModel(snap, doctor, lastReload) {
      var data = snap && snap.data && typeof snap.data === 'object' ? snap.data : {};
      var rea = data.rea && typeof data.rea === 'object' ? data.rea : {};
      var engines = Array.isArray(data.engines) ? data.engines : [];
      var settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
      var mcp = data.mcp && typeof data.mcp === 'object' ? data.mcp : {};
      var host = data.host && typeof data.host === 'object' ? data.host : {};

      var pinned = typeof rea.pinned === 'string' && rea.pinned !== '' ? rea.pinned : null;
      var requested = typeof rea.requested === 'string' && rea.requested !== '' ? rea.requested : null;
      var retained = rea.retained && typeof rea.retained === 'object' ? rea.retained : null;
      var retainedFrom =
        retained !== null && typeof retained.from === 'string' && retained.from !== '' ? retained.from : null;

      var ready = countReady(engines);
      var unsupported = 0;
      for (var i = 0; i < engines.length; i += 1) {
        if (engines[i] && engines[i].status === 'unsupported_host') unsupported += 1;
      }

      var recorded = data.doctor && typeof data.doctor === 'object' ? data.doctor : {};
      var doctorInfo = {
        stale: recorded.stale === true,
        lastAt: typeof recorded.lastAt === 'string' ? recorded.lastAt : null,
        toolCount: typeof recorded.toolCount === 'number' ? recorded.toolCount : null,
        availableGroups: typeof recorded.availableGroups === 'number' ? recorded.availableGroups : null,
        totalGroups: typeof recorded.totalGroups === 'number' ? recorded.totalGroups : null,
      };
      // A doctor run from this page is newer than the snapshot's record of the last one.
      if (doctor && doctor.status === 'ready' && doctor.data && typeof doctor.data === 'object') {
        var live = doctor.data;
        doctorInfo.stale = false;
        if (typeof live.at === 'string') doctorInfo.lastAt = live.at;
        if (typeof live.toolCount === 'number') doctorInfo.toolCount = live.toolCount;
        if (typeof live.availableGroups === 'number') doctorInfo.availableGroups = live.availableGroups;
        if (typeof live.totalGroups === 'number') doctorInfo.totalGroups = live.totalGroups;
      }

      var policy =
        settings.updatePolicy === 'auto-idle' || settings.updatePolicy === 'manual' || settings.updatePolicy === 'notify'
          ? settings.updatePolicy
          : 'notify';

      return {
        data: data,
        rea: rea,
        engines: engines,
        settings: settings,
        mcp: mcp,
        host: host,
        mcpPresent: mcp.present === true,
        mcpDisabled: mcp.disabled === true,
        conflict: data.conflict === undefined ? null : data.conflict,
        writable: data.writable !== false,
        pinned: pinned,
        installed: rea.installed === true || pinned !== null,
        requested: requested,
        retainedFrom: retainedFrom,
        ready: ready,
        total: engines.length,
        unsupported: unsupported,
        policy: policy,
        engineRoot: engineRootDisplay(settings, host),
        doctorInfo: doctorInfo,
        lastReload: lastReload === undefined ? null : lastReload,
      };
    }

    // ------------------------------------------------------------------- page

    /**
     * The whole card. The view prop is 'page' for the settings route and
     * 'summary' for the one-line seat; every hook runs before that branch, so
     * the summary render also warms the state cache for the first page open.
     */
    function Section(props) {
      useStyles();
      var view = props.view === 'summary' ? 'summary' : 'page';

      var prefState = useState(readLocalePref);
      var pref = prefState[0];
      var setPref = prefState[1];
      var shellState = useState(shellLocale.read);
      var shellId = shellState[0];
      var setShellId = shellState[1];
      useEffect(function () {
        setShellId(shellLocale.read());
        return shellLocale.subscribe(function (nextId) {
          setShellId(nextId);
        });
      }, []);
      var hostT = typeof props.powerpackT === 'function' ? props.powerpackT : null;
      var activeId = pref === 'auto' ? shellId : pref;
      // Auto mode uses the shell's own translator for this namespace when the
      // host provides one, so an interface-language switch arrives without a
      // reload. An explicit zh/en preference in the card always wins.
      var t = pref === 'auto' && hostT !== null ? hostT : translatorFor(activeId);

      var snapState = useState({ status: 'loading' });
      var snap = snapState[0];
      var setSnap = snapState[1];
      var doctorState = useState({ status: 'idle' });
      var doctor = doctorState[0];
      var setDoctor = doctorState[1];
      var busyState = useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noticeState = useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var pinDraftState = useState('');
      var pinDraft = pinDraftState[0];
      var setPinDraft = pinDraftState[1];
      var importPathState = useState('');
      var importPath = importPathState[0];
      var setImportPath = importPathState[1];
      var resultState = useState(null);
      var lastResult = resultState[0];
      var setLastResult = resultState[1];
      var expandedState = useState(null);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var loadedState = useState(null);
      var loadedAt = loadedState[0];
      var setLoadedAt = loadedState[1];
      var reloadState = useState(null);
      var lastReload = reloadState[0];
      var setLastReload = reloadState[1];

      var load = useCallback(function () {
        return apiCall('state', 'GET').then(function (data) {
          var payload = data && typeof data === 'object' ? data : {};
          setSnap({ status: 'ready', data: payload });
          setLoadedAt(stamp());
          return payload;
        }, function (error) {
          var described = describeError(t, error);
          setSnap({ status: 'error', error: described });
          setNotice({ kind: 'error', text: described.text, detail: described.detail });
          throw error;
        });
      }, [t]);

      useEffect(function () {
        load().catch(function () {
          /* the error is already in state and shown by the card */
        });
      }, [load]);

      var model = buildModel(snap, doctor, lastReload);

      if (view === 'summary') {
        return h('div', { className: 'rpp-summary' }, summaryText(t, model, snap));
      }

      /**
       * Every mutation goes through here: one request, then one state reload, so
       * the cards never disagree with the host half about what just happened.
       */
      var runAction = function (name, request, done) {
        setBusy(name);
        setNotice(null);
        return request()
          .then(function (payload) {
            var failure = payload && payload.ok === false ? payloadFailure(t, payload) : null;
            return load().then(function (fresh) {
              if (failure !== null) {
                setNotice({ kind: 'error', text: failure.text, detail: failure.detail });
                return payload;
              }
              var message = typeof done === 'function' ? done(payload, fresh) : null;
              if (message !== null && message !== undefined) setNotice(message);
              return payload;
            });
          })
          .then(null, function (error) {
            var described = describeError(t, error);
            return load().then(null, function () {
              return null;
            }).then(function () {
              setNotice({ kind: 'error', text: described.text, detail: described.detail });
              return undefined;
            });
          })
          .then(function (value) {
            setBusy(null);
            return value;
          }, function () {
            setBusy(null);
            return undefined;
          });
      };

      var refresh = function () {
        setBusy('refresh');
        setNotice(null);
        return load().then(function () {
          setBusy(null);
        }, function () {
          setBusy(null);
        });
      };

      var changeLocale = function (mode) {
        setPref(mode);
        writeLocalePref(mode);
      };

      var toggleExpanded = function (key) {
        setExpanded(function (current) {
          return current === key ? null : key;
        });
      };

      var verifyAll = function () {
        return runAction('verify-all', function () {
          return apiCall('engines/verify', 'POST');
        }, function (payload, fresh) {
          return {
            kind: 'ok',
            text: t('enginesVerified', { ready: readyCountOf(fresh), total: engineCountOf(fresh) }),
          };
        });
      };

      var verifyEngine = function (id) {
        return runAction('verify:' + id, function () {
          return apiCall('engines/verify', 'POST');
        }, function (payload, fresh) {
          var engine = findEngine(fresh, id);
          return {
            kind: 'ok',
            text: t('engineVerified', {
              name: engine && engine.name ? engine.name : id,
              status: statusLabel(t, engine ? engine.status : 'missing'),
            }),
          };
        });
      };

      var installEngine = function (id) {
        return runAction('install:' + id, function () {
          return apiCall('engines/install', 'POST', { id: id });
        }, function (payload) {
          var engine = payload && payload.engine ? payload.engine : null;
          return {
            kind: 'ok',
            text: t('engineInstalled', {
              name: engine && engine.name ? engine.name : id,
              version: engine && engine.version ? String(engine.version) : t('unknown'),
            }),
          };
        });
      };

      var uninstallEngine = function (id, name) {
        var confirmFn = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : null;
        if (confirmFn !== null && confirmFn(t('engineUninstallConfirm', { name: name })) !== true) {
          return Promise.resolve(undefined);
        }
        return runAction('uninstall:' + id, function () {
          return apiCall('engines/uninstall', 'POST', { id: id });
        }, function () {
          return { kind: 'ok', text: t('engineUninstalled', { name: name }) };
        });
      };

      var checkLatest = function () {
        return runAction('check', function () {
          return apiCall('check', 'POST');
        }, function (payload) {
          var latest = payload && typeof payload.latest === 'string' ? payload.latest : null;
          return { kind: 'ok', text: t('versionCheckDone', { latest: latest === null ? t('unknown') : latest }) };
        });
      };

      var updateVersion = function (version, actionName) {
        var requested = typeof version === 'string' && version !== '' ? version : undefined;
        var body = requested === undefined ? {} : { version: requested };
        return runAction(actionName || 'update', function () {
          return apiCall('update', 'POST', body);
        }, function (payload) {
          setLastResult(payload && typeof payload === 'object' ? payload : null);
          var detail = [];
          var preflight = payload && payload.preflight ? payload.preflight : null;
          if (preflight) {
            detail.push(
              t('versionPreflightValue', {
                serverVersion: preflight.serverVersion === undefined ? t('unknown') : preflight.serverVersion,
                toolCount: preflight.toolCount === undefined ? '?' : preflight.toolCount,
              }),
            );
          }
          var reload = payload && payload.reload ? payload.reload : null;
          if (reload) {
            detail.push(
              reload.mode === 'hot'
                ? t('versionReloadHot')
                : t('versionReloadRestart') + (reload.reason ? ' · ' + reload.reason : ''),
            );
          }
          var text;
          if (payload && payload.from && payload.to) text = t('versionUpdateDone', { from: payload.from, to: payload.to });
          else if (payload && payload.to) text = t('versionPinDone', { version: payload.to });
          else text = t('versionUpgradeAny');
          return { kind: 'ok', text: text, detail: detail.length > 0 ? detail.join('\n') : null };
        });
      };

      var rollbackVersion = function () {
        if (model.retainedFrom === null) {
          setNotice({ kind: 'warn', text: t('versionRollbackUnavailable') });
          return Promise.resolve(undefined);
        }
        return updateVersion(model.retainedFrom, 'rollback');
      };

      var pinVersion = function () {
        var version = pinDraft.trim();
        if (!isExactVersion(version)) {
          setNotice({ kind: 'error', text: t('versionPinInvalid') });
          return Promise.resolve(undefined);
        }
        return runAction('pin', function () {
          return apiCall('pin', 'POST', { version: version });
        }, function (payload) {
          setPinDraft('');
          var pin = payload && payload.pin ? payload.pin : null;
          var pinned =
            pin && typeof pin.version === 'string'
              ? pin.version
              : payload && typeof payload.version === 'string'
                ? payload.version
                : version;
          return { kind: 'ok', text: t('versionPinDone', { version: pinned }) };
        });
      };

      var changePolicy = function (policy) {
        return runAction('settings', function () {
          return apiCall('settings', 'POST', { updatePolicy: policy });
        }, function (payload) {
          var saved = payload && payload.settings ? payload.settings : null;
          var effective = saved && typeof saved.updatePolicy === 'string' ? saved.updatePolicy : policy;
          return { kind: 'ok', text: t('versionPolicySaved', { policy: policyLabel(t, effective) }) };
        });
      };

      var runDoctor = function () {
        setBusy('doctor');
        setNotice(null);
        setDoctor({ status: 'loading' });
        return apiCall('doctor', 'GET')
          .then(function (payload) {
            var data = payload && typeof payload === 'object' ? payload : {};
            setDoctor({ status: 'ready', data: data });
            setNotice({
              kind: 'ok',
              text: t('doctorDone', {
                groups: data.availableGroups === undefined ? '?' : data.availableGroups,
                total: data.totalGroups === undefined ? '?' : data.totalGroups,
                tools: data.toolCount === undefined ? '?' : data.toolCount,
              }),
            });
            return data;
          }, function (error) {
            var described = describeError(t, error);
            setDoctor({ status: 'failed', error: described });
            setNotice({ kind: 'error', text: described.text, detail: described.detail });
            return undefined;
          })
          .then(function (value) {
            setBusy(null);
            return value;
          }, function () {
            setBusy(null);
            return undefined;
          });
      };

      var fetchReport = function () {
        return apiCall('report', 'GET').then(function (payload) {
          if (payload && typeof payload.text === 'string') return payload.text;
          return '';
        });
      };

      var reportFailure = function (error, fallbackKey) {
        setBusy(null);
        var described = error && typeof error.code === 'string' ? describeError(t, error) : null;
        if (described !== null) {
          setNotice({ kind: 'error', text: described.text, detail: described.detail });
          return;
        }
        var reason = error && error.message ? error.message : String(error);
        setNotice({ kind: 'error', text: t(fallbackKey, { reason: reason }), detail: null });
      };

      var copyReport = function () {
        setBusy('copy-report');
        setNotice(null);
        return fetchReport()
          .then(function (text) {
            return writeClipboard(text).then(function () {
              setBusy(null);
              setNotice({ kind: 'ok', text: t('doctorReportCopied') });
            });
          })
          .then(null, function (error) {
            reportFailure(error, 'copyFailedWith');
            return undefined;
          });
      };

      var exportReport = function () {
        setBusy('export-report');
        setNotice(null);
        return fetchReport()
          .then(function (text) {
            var name = 'rea-powerpack-report-' + stamp() + '.md';
            downloadText(name, text);
            setBusy(null);
            setNotice({ kind: 'ok', text: t('maintExported', { name: name }) });
          })
          .then(null, function (error) {
            reportFailure(error, 'maintExportFailed');
            return undefined;
          });
      };

      var reloadMcp = function () {
        return runAction('reload', function () {
          return apiCall('reload', 'POST');
        }, function (payload) {
          setLastReload(payload && typeof payload === 'object' ? payload : null);
          var hot = payload && payload.mode === 'hot';
          var detail = [];
          if (payload && payload.reason) detail.push(String(payload.reason));
          if (payload && payload.restoredPatch === true) detail.push(t('maintReloadRestored'));
          return {
            kind: hot ? 'ok' : 'warn',
            text: hot ? t('maintReloadOk') : t('maintReloadRestart'),
            detail: detail.length > 0 ? detail.join('\n') : null,
          };
        });
      };

      var importPin = function () {
        var file = importPath.trim();
        var body = file === '' ? {} : { path: file };
        return runAction('import-pin', function () {
          return apiCall('import-pin', 'POST', body);
        }, function (payload) {
          var pin = payload && payload.pin ? payload.pin : null;
          var version =
            pin && typeof pin.version === 'string'
              ? pin.version
              : payload && typeof payload.version === 'string'
                ? payload.version
                : t('unknown');
          setImportPath('');
          return { kind: 'ok', text: t('maintImported', { version: version }) };
        });
      };

      var copyEngineDir = function (dir) {
        setNotice(null);
        return writeClipboard(dir).then(function () {
          setNotice({ kind: 'ok', text: t('copiedDir', { path: dir }) });
        }, function (error) {
          setNotice({
            kind: 'error',
            text: t('copyFailedWith', { reason: error && error.message ? error.message : String(error) }),
          });
        });
      };

      var actions = {
        verifyAll: verifyAll,
        verifyEngine: verifyEngine,
        installEngine: installEngine,
        uninstallEngine: uninstallEngine,
        check: checkLatest,
        update: updateVersion,
        rollback: rollbackVersion,
        pin: pinVersion,
        setPolicy: changePolicy,
        runDoctor: runDoctor,
        copyReport: copyReport,
        exportReport: exportReport,
        reloadMcp: reloadMcp,
        importPin: importPin,
        copyEngineDir: copyEngineDir,
      };

      var children = [
        renderHeader(t, pref, changeLocale, refresh, busy, loadedAt),
        renderNotice(t, notice),
      ];

      if (snap.status === 'error') {
        children.push(
          h(
            Panel,
            { title: t('secOverview'), first: true },
            h(
              'div',
              { className: 'rpp-note rpp-note-err' },
              h('p', null, t('loadFailedWith', { reason: snap.error ? snap.error.text : t('unknown') })),
            ),
            h(
              'div',
              { className: 'rpp-row' },
              h(Btn, {
                label: t('retry'),
                busy: busy === 'refresh',
                busyLabel: t('refreshing'),
                disabled: busy !== null,
                onClick: refresh,
              }),
            ),
          ),
        );
      } else {
        if (snap.status === 'loading' && loadedAt === null) {
          children.push(h('p', { className: 'rpp-empty' }, t('loading')));
        }
        children.push.apply(children, renderWarnings(t, model));
        children.push(renderOverview(t, model));
        children.push(renderEngines(t, model, actions, busy, expanded, toggleExpanded));
        children.push(renderVersion(t, model, actions, busy, pinDraft, setPinDraft, lastResult));
        children.push(renderDoctor(t, model, actions, busy, doctor, expanded, toggleExpanded));
        children.push(
          renderMaintenance(
            t,
            model,
            actions,
            busy,
            importPath,
            setImportPath,
            lastReload,
            defaultPowerpackHome(model.host.platform || 'win32'),
          ),
        );
        children.push(
          h(
            'p',
            { className: 'rpp-fine' },
            t('footerHint', { version: model.data.self && model.data.self.version ? model.data.self.version : t('unknown') }),
          ),
        );
      }

      return h('div', { className: 'rpp-page' }, children);
    }

    /** Settings → Plugins shows this card as one tab. */
    var SLOT_NAME = 'settings.plugins.tab';

    function apply(ctx) {
      // Follow the interface language until the user picks one here.
      if (ctx.locale !== undefined && ctx.locale !== null) bindShellLocale(ctx.locale);
      var hostT = null;
      if (ctx.locale && typeof ctx.locale.bind === 'function') {
        try {
          hostT = ctx.locale.bind(NS);
        } catch (error) {
          hostT = null;
        }
      }
      ctx.effect(function () {
        if (!ctx.locale || typeof ctx.locale.register !== 'function') return undefined;
        return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
      });
      ctx.effect(function () {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          return undefined;
        }
        return ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: PACKAGE_NAME,
              order: 20,
              label: function () {
                return hostT !== null ? hostT('tab') : DICT.zh.tab;
              },
              locale: NS,
              inject: function () {
                return { powerpackT: hostT };
              },
            },
            function PowerpackTab(props) {
              return h(Section, props && typeof props === 'object' ? props : {});
            },
          );
        });
      });
    }

    exports.name = 'dsh-rea-powerpack';
    exports.NS = NS;
    exports.inject = ['slots', 'locale'];
    exports.apply = apply;

    return exports;
  },
});
