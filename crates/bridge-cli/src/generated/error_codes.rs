//! 错误码（机器生成，禁止手改）。
//!
//! 单源：`lib/error-codes.mjs`（ERROR_CODES / ERROR_RECOVERY）。
//! 生成器：`crates/bridge-cli/scripts/gen-error-codes.mjs`；漂移校验：`--check`。
//! 源文件 sha256：`2b9de0d0a9480d10eeb2105bbcb1f0e2a98f867f428128ea89de61a95471c28c`。

#![allow(dead_code)]

/// 协议错误码枚举；声明顺序与 `ERROR_CODES` 一致（CLI/daemon 共用字符串码）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ErrorCode {
    /// `E_BAD_ARG`
    BadArg,
    /// `E_NOT_FOUND`
    NotFound,
    /// `E_NOT_ACTIONABLE`
    NotActionable,
    /// `E_STALE_REF`
    StaleRef,
    /// `E_OPTION_NOT_FOUND`
    OptionNotFound,
    /// `E_OPTION_AMBIGUOUS`
    OptionAmbiguous,
    /// `E_UNKNOWN_METHOD`
    UnknownMethod,
    /// `E_NO_SESSION`
    NoSession,
    /// `E_SESSION_BUSY`
    SessionBusy,
    /// `E_SESSION_PAUSED`
    SessionPaused,
    /// `E_SESSION_STOPPED`
    SessionStopped,
    /// `E_QUEUE_FULL`
    QueueFull,
    /// `E_RATE_LIMITED`
    RateLimited,
    /// `E_CANCELLED`
    Cancelled,
    /// `E_REQUEST_CANCELLED`
    RequestCancelled,
    /// `E_INPUT_BUSY`
    InputBusy,
    /// `E_NO_TAB`
    NoTab,
    /// `E_NO_BROWSER`
    NoBrowser,
    /// `E_BROWSER_AMBIGUOUS`
    BrowserAmbiguous,
    /// `E_START_PENDING`
    StartPending,
    /// `E_START_NOT_READY`
    StartNotReady,
    /// `E_OBSERVATION_STALE`
    ObservationStale,
    /// `E_CURSOR_STALE`
    CursorStale,
    /// `E_CONTEXT_REQUIRED`
    ContextRequired,
    /// `E_CONTEXT_STALE`
    ContextStale,
    /// `E_COOPERATION_STALE`
    CooperationStale,
    /// `E_DEPENDS_FAILED`
    DependsFailed,
    /// `E_EXPECT_FAILED`
    ExpectFailed,
    /// `E_OBSERVATION_CHANGED`
    ObservationChanged,
    /// `E_TARGET_DETACHED`
    TargetDetached,
    /// `E_TOKEN_BAD_ARG`
    TokenBadArg,
    /// `E_TOKEN_UNKNOWN`
    TokenUnknown,
    /// `E_TOKEN_EXPIRED`
    TokenExpired,
    /// `E_TOKEN_USED`
    TokenUsed,
    /// `E_TOKEN_GRANTEE`
    TokenGrantee,
    /// `E_TOKEN_CAPACITY`
    TokenCapacity,
    /// `E_CAPTURE_BAD_TAB`
    CaptureBadTab,
    /// `E_CAPTURE_LIMIT`
    CaptureLimit,
    /// `E_SESSION_STATE`
    SessionState,
    /// `E_SESSION_TRANSITION`
    SessionTransition,
    /// `E_LEDGER_IO`
    LedgerIo,
    /// `E_LEDGER_WAL_IO`
    LedgerWalIo,
    /// `E_LEDGER_FSYNC`
    LedgerFsync,
    /// `E_LEDGER_RECOVER`
    LedgerRecover,
    /// `E_LEDGER_CONFLICT`
    LedgerConflict,
    /// `E_LEDGER_RESOLVE_REQUIRED`
    LedgerResolveRequired,
    /// `E_TAB_LEASE_HELD`
    TabLeaseHeld,
    /// `E_TAB_LEASE_NOT_HELD`
    TabLeaseNotHeld,
    /// `E_SNAPSHOT_DISABLED`
    SnapshotDisabled,
    /// `E_SNAPSHOT_WRITE`
    SnapshotWrite,
    /// `E_SNAPSHOT_CORRUPT`
    SnapshotCorrupt,
    /// `E_UNSUPPORTED`
    Unsupported,
    /// `E_ARG_MISSING`
    ArgMissing,
    /// `E_ARG_TYPE`
    ArgType,
    /// `E_ARG_ENUM`
    ArgEnum,
    /// `E_ARG_CONFLICT`
    ArgConflict,
    /// `E_ARG_REQUIRES`
    ArgRequires,
    /// `E_ARG_RANGE`
    ArgRange,
    /// `E_ARG_UNEXPECTED`
    ArgUnexpected,
    /// `E_ARG_USAGE`
    ArgUsage,
    /// `E_UNKNOWN_FLAG`
    UnknownFlag,
    /// `E_BAD_SUBCOMMAND`
    BadSubcommand,
    /// `E_HUMAN_GATE`
    HumanGate,
    /// `E_EVAL_CORPUS`
    EvalCorpus,
    /// `E_EVAL_RUNNER`
    EvalRunner,
    /// `E_EVAL_DOM`
    EvalDom,
    /// `E_EVAL_DOM_ARGS`
    EvalDomArgs,
    /// `E_EVAL_DOM_BAD_FACTS`
    EvalDomBadFacts,
    /// `E_EVAL_DOM_BAD_JSON`
    EvalDomBadJson,
    /// `E_EVAL_DOM_FIXTURE`
    EvalDomFixture,
    /// `E_EVAL_DOM_NO_BROWSER`
    EvalDomNoBrowser,
    /// `E_EVAL_DOM_NO_FACTS`
    EvalDomNoFacts,
    /// `E_EVAL_DOM_NO_MARKER`
    EvalDomNoMarker,
    /// `E_EVAL_DOM_SPAWN`
    EvalDomSpawn,
    /// `E_OCCLUDED`
    Occluded,
    /// `E_OBSCURED`
    Obscured,
    /// `E_TARGET_MISMATCH`
    TargetMismatch,
    /// `E_CAPTURE_STALE`
    CaptureStale,
    /// `E_BAD_MODE`
    BadMode,
    /// `E_DIALOG_PENDING`
    DialogPending,
    /// `E_EXISTS`
    Exists,
    /// `E_CACHE_EMPTY`
    CacheEmpty,
    /// `E_TOO_LARGE`
    TooLarge,
    /// `E_RESULT_TOO_LARGE`
    ResultTooLarge,
    /// `E_JS_ERROR`
    JsError,
    /// `E_NAV_FAIL`
    NavFail,
    /// `E_TIMEOUT`
    Timeout,
    /// `E_DEBUGGER_BUSY`
    DebuggerBusy,
    /// `E_UNSUPPORTED_CAPABILITY`
    UnsupportedCapability,
    /// `E_UNSUPPORTED_REMOTE`
    UnsupportedRemote,
    /// `E_PROTOCOL_UNSUPPORTED`
    ProtocolUnsupported,
    /// `E_AUTH`
    Auth,
    /// `E_AUTH_BUSY`
    AuthBusy,
    /// `E_AUTH_CHALLENGE`
    AuthChallenge,
    /// `E_AUTH_EXPIRED`
    AuthExpired,
    /// `E_AUTH_FAILED`
    AuthFailed,
    /// `E_AUTH_PROOF`
    AuthProof,
    /// `E_AUTH_STATE`
    AuthState,
    /// `E_PAIR_INVALID`
    PairInvalid,
    /// `E_PAIR_REQUIRED`
    PairRequired,
    /// `E_PAIR_REJECTED`
    PairRejected,
    /// `E_PAUSED_MANUAL`
    PausedManual,
    /// `E_LEDGER_PENDING`
    LedgerPending,
    /// `E_DAEMON`
    Daemon,
    /// `E_NO_DAEMON`
    NoDaemon,
    /// `E_DAEMON_TIMEOUT`
    DaemonTimeout,
    /// `E_DISCONNECTED`
    Disconnected,
    /// `E_EXTENSION_GONE`
    ExtensionGone,
    /// `E_LISTEN`
    Listen,
    /// `E_SPAWN`
    Spawn,
    /// `E_ENV`
    Env,
    /// `E_CONFIG_INVALID`
    ConfigInvalid,
    /// `E_BAD_JSON`
    BadJson,
    /// `E_BAD_REQUEST`
    BadRequest,
    /// `E_INVALID_PARAMS`
    InvalidParams,
    /// `E_DIRECT_RPC_DISABLED`
    DirectRpcDisabled,
    /// `E_RPC`
    Rpc,
    /// `E_OUTPUT`
    Output,
    /// `E_TARGET_NOT_FILLABLE`
    TargetNotFillable,
    /// `E_NOT_SELECT`
    NotSelect,
    /// `E_BROWSER`
    Browser,
    /// `E_SCREENSHOT`
    Screenshot,
    /// `E_PREVIEW_META`
    PreviewMeta,
    /// `E_CLICK`
    Click,
    /// `E_KEY`
    Key,
    /// `E_FOCUS`
    Focus,
    /// `E_PAGE_ERROR`
    PageError,
    /// `E_OBSERVE_FAILED`
    ObserveFailed,
    /// `E_FOLLOW_FAILED`
    FollowFailed,
    /// `E_RELEASE_INVALID`
    ReleaseInvalid,
    /// `E_UPDATE`
    Update,
    /// `E_MCP_CONFLICT`
    McpConflict,
    /// `E_APP_SSO_FAILED`
    AppSsoFailed,
    /// `E_TRANSFER_NOT_FOUND`
    TransferNotFound,
    /// `E_TRANSFER_STATE`
    TransferState,
    /// `E_BORROW_DENIED`
    BorrowDenied,
    /// `E_BORROW_CONFLICT`
    BorrowConflict,
    /// `E_BORROW_TIMEOUT`
    BorrowTimeout,
    /// `E_HELP_DISABLED`
    HelpDisabled,
    /// `E_CONTROL_NOT_HELD`
    ControlNotHeld,
    /// `E_CONTROL_BUSY`
    ControlBusy,
    /// `E_CONTROL_STALE`
    ControlStale,
    /// `E_NO_DOWNLOAD`
    NoDownload,
    /// `E_DOWNLOAD_FAILED`
    DownloadFailed,
    /// `E_NO_FILE_CHOOSER`
    NoFileChooser,
    /// `E_TRANSFER_OFFSET`
    TransferOffset,
    /// `E_TRANSFER_LIMIT`
    TransferLimit,
    /// `E_TRANSFER_INCOMPLETE`
    TransferIncomplete,
    /// `E_INCOGNITO_UNAVAILABLE`
    IncognitoUnavailable,
    /// `E_RECIPE_NOT_APPROVED`
    RecipeNotApproved,
    /// `E_RECIPE_CHANGED`
    RecipeChanged,
    /// `E_RECIPE_EXPIRED`
    RecipeExpired,
    /// `E_RECIPE_DRAFT_EMPTY`
    RecipeDraftEmpty,
    /// `E_RECIPE_LOCKED`
    RecipeLocked,
    /// `E_FORBIDDEN`
    Forbidden,
    /// `E_READ_ONLY`
    ReadOnly,
    /// `E_EXEC_FAILED`
    ExecFailed,
    /// `E_INTERNAL`
    Internal,
}

/// 错误码总数（生成时固定，漂移由 --check 捕获）。
pub const ERROR_CODE_COUNT: usize = 158;
/// 登记了恢复建议的错误码数量。
pub const ERROR_RECOVERY_COUNT: usize = 48;

/// 恢复建议（对应 JS `ERROR_RECOVERY[code]`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorRecovery {
    /// `no` / `transient` / `after-action`。
    pub retry: &'static str,
    /// 人类可读恢复提示（中文，与 CLI/插件共用）。
    pub hint: &'static str,
}

impl ErrorCode {
    /// 全部错误码（158 个），声明顺序。
    pub const ALL: [ErrorCode; 158] = [
        ErrorCode::BadArg,
        ErrorCode::NotFound,
        ErrorCode::NotActionable,
        ErrorCode::StaleRef,
        ErrorCode::OptionNotFound,
        ErrorCode::OptionAmbiguous,
        ErrorCode::UnknownMethod,
        ErrorCode::NoSession,
        ErrorCode::SessionBusy,
        ErrorCode::SessionPaused,
        ErrorCode::SessionStopped,
        ErrorCode::QueueFull,
        ErrorCode::RateLimited,
        ErrorCode::Cancelled,
        ErrorCode::RequestCancelled,
        ErrorCode::InputBusy,
        ErrorCode::NoTab,
        ErrorCode::NoBrowser,
        ErrorCode::BrowserAmbiguous,
        ErrorCode::StartPending,
        ErrorCode::StartNotReady,
        ErrorCode::ObservationStale,
        ErrorCode::CursorStale,
        ErrorCode::ContextRequired,
        ErrorCode::ContextStale,
        ErrorCode::CooperationStale,
        ErrorCode::DependsFailed,
        ErrorCode::ExpectFailed,
        ErrorCode::ObservationChanged,
        ErrorCode::TargetDetached,
        ErrorCode::TokenBadArg,
        ErrorCode::TokenUnknown,
        ErrorCode::TokenExpired,
        ErrorCode::TokenUsed,
        ErrorCode::TokenGrantee,
        ErrorCode::TokenCapacity,
        ErrorCode::CaptureBadTab,
        ErrorCode::CaptureLimit,
        ErrorCode::SessionState,
        ErrorCode::SessionTransition,
        ErrorCode::LedgerIo,
        ErrorCode::LedgerWalIo,
        ErrorCode::LedgerFsync,
        ErrorCode::LedgerRecover,
        ErrorCode::LedgerConflict,
        ErrorCode::LedgerResolveRequired,
        ErrorCode::TabLeaseHeld,
        ErrorCode::TabLeaseNotHeld,
        ErrorCode::SnapshotDisabled,
        ErrorCode::SnapshotWrite,
        ErrorCode::SnapshotCorrupt,
        ErrorCode::Unsupported,
        ErrorCode::ArgMissing,
        ErrorCode::ArgType,
        ErrorCode::ArgEnum,
        ErrorCode::ArgConflict,
        ErrorCode::ArgRequires,
        ErrorCode::ArgRange,
        ErrorCode::ArgUnexpected,
        ErrorCode::ArgUsage,
        ErrorCode::UnknownFlag,
        ErrorCode::BadSubcommand,
        ErrorCode::HumanGate,
        ErrorCode::EvalCorpus,
        ErrorCode::EvalRunner,
        ErrorCode::EvalDom,
        ErrorCode::EvalDomArgs,
        ErrorCode::EvalDomBadFacts,
        ErrorCode::EvalDomBadJson,
        ErrorCode::EvalDomFixture,
        ErrorCode::EvalDomNoBrowser,
        ErrorCode::EvalDomNoFacts,
        ErrorCode::EvalDomNoMarker,
        ErrorCode::EvalDomSpawn,
        ErrorCode::Occluded,
        ErrorCode::Obscured,
        ErrorCode::TargetMismatch,
        ErrorCode::CaptureStale,
        ErrorCode::BadMode,
        ErrorCode::DialogPending,
        ErrorCode::Exists,
        ErrorCode::CacheEmpty,
        ErrorCode::TooLarge,
        ErrorCode::ResultTooLarge,
        ErrorCode::JsError,
        ErrorCode::NavFail,
        ErrorCode::Timeout,
        ErrorCode::DebuggerBusy,
        ErrorCode::UnsupportedCapability,
        ErrorCode::UnsupportedRemote,
        ErrorCode::ProtocolUnsupported,
        ErrorCode::Auth,
        ErrorCode::AuthBusy,
        ErrorCode::AuthChallenge,
        ErrorCode::AuthExpired,
        ErrorCode::AuthFailed,
        ErrorCode::AuthProof,
        ErrorCode::AuthState,
        ErrorCode::PairInvalid,
        ErrorCode::PairRequired,
        ErrorCode::PairRejected,
        ErrorCode::PausedManual,
        ErrorCode::LedgerPending,
        ErrorCode::Daemon,
        ErrorCode::NoDaemon,
        ErrorCode::DaemonTimeout,
        ErrorCode::Disconnected,
        ErrorCode::ExtensionGone,
        ErrorCode::Listen,
        ErrorCode::Spawn,
        ErrorCode::Env,
        ErrorCode::ConfigInvalid,
        ErrorCode::BadJson,
        ErrorCode::BadRequest,
        ErrorCode::InvalidParams,
        ErrorCode::DirectRpcDisabled,
        ErrorCode::Rpc,
        ErrorCode::Output,
        ErrorCode::TargetNotFillable,
        ErrorCode::NotSelect,
        ErrorCode::Browser,
        ErrorCode::Screenshot,
        ErrorCode::PreviewMeta,
        ErrorCode::Click,
        ErrorCode::Key,
        ErrorCode::Focus,
        ErrorCode::PageError,
        ErrorCode::ObserveFailed,
        ErrorCode::FollowFailed,
        ErrorCode::ReleaseInvalid,
        ErrorCode::Update,
        ErrorCode::McpConflict,
        ErrorCode::AppSsoFailed,
        ErrorCode::TransferNotFound,
        ErrorCode::TransferState,
        ErrorCode::BorrowDenied,
        ErrorCode::BorrowConflict,
        ErrorCode::BorrowTimeout,
        ErrorCode::HelpDisabled,
        ErrorCode::ControlNotHeld,
        ErrorCode::ControlBusy,
        ErrorCode::ControlStale,
        ErrorCode::NoDownload,
        ErrorCode::DownloadFailed,
        ErrorCode::NoFileChooser,
        ErrorCode::TransferOffset,
        ErrorCode::TransferLimit,
        ErrorCode::TransferIncomplete,
        ErrorCode::IncognitoUnavailable,
        ErrorCode::RecipeNotApproved,
        ErrorCode::RecipeChanged,
        ErrorCode::RecipeExpired,
        ErrorCode::RecipeDraftEmpty,
        ErrorCode::RecipeLocked,
        ErrorCode::Forbidden,
        ErrorCode::ReadOnly,
        ErrorCode::ExecFailed,
        ErrorCode::Internal,
    ];

    /// 规范字符串码（如 `E_BAD_ARG`）。
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadArg => "E_BAD_ARG",
            ErrorCode::NotFound => "E_NOT_FOUND",
            ErrorCode::NotActionable => "E_NOT_ACTIONABLE",
            ErrorCode::StaleRef => "E_STALE_REF",
            ErrorCode::OptionNotFound => "E_OPTION_NOT_FOUND",
            ErrorCode::OptionAmbiguous => "E_OPTION_AMBIGUOUS",
            ErrorCode::UnknownMethod => "E_UNKNOWN_METHOD",
            ErrorCode::NoSession => "E_NO_SESSION",
            ErrorCode::SessionBusy => "E_SESSION_BUSY",
            ErrorCode::SessionPaused => "E_SESSION_PAUSED",
            ErrorCode::SessionStopped => "E_SESSION_STOPPED",
            ErrorCode::QueueFull => "E_QUEUE_FULL",
            ErrorCode::RateLimited => "E_RATE_LIMITED",
            ErrorCode::Cancelled => "E_CANCELLED",
            ErrorCode::RequestCancelled => "E_REQUEST_CANCELLED",
            ErrorCode::InputBusy => "E_INPUT_BUSY",
            ErrorCode::NoTab => "E_NO_TAB",
            ErrorCode::NoBrowser => "E_NO_BROWSER",
            ErrorCode::BrowserAmbiguous => "E_BROWSER_AMBIGUOUS",
            ErrorCode::StartPending => "E_START_PENDING",
            ErrorCode::StartNotReady => "E_START_NOT_READY",
            ErrorCode::ObservationStale => "E_OBSERVATION_STALE",
            ErrorCode::CursorStale => "E_CURSOR_STALE",
            ErrorCode::ContextRequired => "E_CONTEXT_REQUIRED",
            ErrorCode::ContextStale => "E_CONTEXT_STALE",
            ErrorCode::CooperationStale => "E_COOPERATION_STALE",
            ErrorCode::DependsFailed => "E_DEPENDS_FAILED",
            ErrorCode::ExpectFailed => "E_EXPECT_FAILED",
            ErrorCode::ObservationChanged => "E_OBSERVATION_CHANGED",
            ErrorCode::TargetDetached => "E_TARGET_DETACHED",
            ErrorCode::TokenBadArg => "E_TOKEN_BAD_ARG",
            ErrorCode::TokenUnknown => "E_TOKEN_UNKNOWN",
            ErrorCode::TokenExpired => "E_TOKEN_EXPIRED",
            ErrorCode::TokenUsed => "E_TOKEN_USED",
            ErrorCode::TokenGrantee => "E_TOKEN_GRANTEE",
            ErrorCode::TokenCapacity => "E_TOKEN_CAPACITY",
            ErrorCode::CaptureBadTab => "E_CAPTURE_BAD_TAB",
            ErrorCode::CaptureLimit => "E_CAPTURE_LIMIT",
            ErrorCode::SessionState => "E_SESSION_STATE",
            ErrorCode::SessionTransition => "E_SESSION_TRANSITION",
            ErrorCode::LedgerIo => "E_LEDGER_IO",
            ErrorCode::LedgerWalIo => "E_LEDGER_WAL_IO",
            ErrorCode::LedgerFsync => "E_LEDGER_FSYNC",
            ErrorCode::LedgerRecover => "E_LEDGER_RECOVER",
            ErrorCode::LedgerConflict => "E_LEDGER_CONFLICT",
            ErrorCode::LedgerResolveRequired => "E_LEDGER_RESOLVE_REQUIRED",
            ErrorCode::TabLeaseHeld => "E_TAB_LEASE_HELD",
            ErrorCode::TabLeaseNotHeld => "E_TAB_LEASE_NOT_HELD",
            ErrorCode::SnapshotDisabled => "E_SNAPSHOT_DISABLED",
            ErrorCode::SnapshotWrite => "E_SNAPSHOT_WRITE",
            ErrorCode::SnapshotCorrupt => "E_SNAPSHOT_CORRUPT",
            ErrorCode::Unsupported => "E_UNSUPPORTED",
            ErrorCode::ArgMissing => "E_ARG_MISSING",
            ErrorCode::ArgType => "E_ARG_TYPE",
            ErrorCode::ArgEnum => "E_ARG_ENUM",
            ErrorCode::ArgConflict => "E_ARG_CONFLICT",
            ErrorCode::ArgRequires => "E_ARG_REQUIRES",
            ErrorCode::ArgRange => "E_ARG_RANGE",
            ErrorCode::ArgUnexpected => "E_ARG_UNEXPECTED",
            ErrorCode::ArgUsage => "E_ARG_USAGE",
            ErrorCode::UnknownFlag => "E_UNKNOWN_FLAG",
            ErrorCode::BadSubcommand => "E_BAD_SUBCOMMAND",
            ErrorCode::HumanGate => "E_HUMAN_GATE",
            ErrorCode::EvalCorpus => "E_EVAL_CORPUS",
            ErrorCode::EvalRunner => "E_EVAL_RUNNER",
            ErrorCode::EvalDom => "E_EVAL_DOM",
            ErrorCode::EvalDomArgs => "E_EVAL_DOM_ARGS",
            ErrorCode::EvalDomBadFacts => "E_EVAL_DOM_BAD_FACTS",
            ErrorCode::EvalDomBadJson => "E_EVAL_DOM_BAD_JSON",
            ErrorCode::EvalDomFixture => "E_EVAL_DOM_FIXTURE",
            ErrorCode::EvalDomNoBrowser => "E_EVAL_DOM_NO_BROWSER",
            ErrorCode::EvalDomNoFacts => "E_EVAL_DOM_NO_FACTS",
            ErrorCode::EvalDomNoMarker => "E_EVAL_DOM_NO_MARKER",
            ErrorCode::EvalDomSpawn => "E_EVAL_DOM_SPAWN",
            ErrorCode::Occluded => "E_OCCLUDED",
            ErrorCode::Obscured => "E_OBSCURED",
            ErrorCode::TargetMismatch => "E_TARGET_MISMATCH",
            ErrorCode::CaptureStale => "E_CAPTURE_STALE",
            ErrorCode::BadMode => "E_BAD_MODE",
            ErrorCode::DialogPending => "E_DIALOG_PENDING",
            ErrorCode::Exists => "E_EXISTS",
            ErrorCode::CacheEmpty => "E_CACHE_EMPTY",
            ErrorCode::TooLarge => "E_TOO_LARGE",
            ErrorCode::ResultTooLarge => "E_RESULT_TOO_LARGE",
            ErrorCode::JsError => "E_JS_ERROR",
            ErrorCode::NavFail => "E_NAV_FAIL",
            ErrorCode::Timeout => "E_TIMEOUT",
            ErrorCode::DebuggerBusy => "E_DEBUGGER_BUSY",
            ErrorCode::UnsupportedCapability => "E_UNSUPPORTED_CAPABILITY",
            ErrorCode::UnsupportedRemote => "E_UNSUPPORTED_REMOTE",
            ErrorCode::ProtocolUnsupported => "E_PROTOCOL_UNSUPPORTED",
            ErrorCode::Auth => "E_AUTH",
            ErrorCode::AuthBusy => "E_AUTH_BUSY",
            ErrorCode::AuthChallenge => "E_AUTH_CHALLENGE",
            ErrorCode::AuthExpired => "E_AUTH_EXPIRED",
            ErrorCode::AuthFailed => "E_AUTH_FAILED",
            ErrorCode::AuthProof => "E_AUTH_PROOF",
            ErrorCode::AuthState => "E_AUTH_STATE",
            ErrorCode::PairInvalid => "E_PAIR_INVALID",
            ErrorCode::PairRequired => "E_PAIR_REQUIRED",
            ErrorCode::PairRejected => "E_PAIR_REJECTED",
            ErrorCode::PausedManual => "E_PAUSED_MANUAL",
            ErrorCode::LedgerPending => "E_LEDGER_PENDING",
            ErrorCode::Daemon => "E_DAEMON",
            ErrorCode::NoDaemon => "E_NO_DAEMON",
            ErrorCode::DaemonTimeout => "E_DAEMON_TIMEOUT",
            ErrorCode::Disconnected => "E_DISCONNECTED",
            ErrorCode::ExtensionGone => "E_EXTENSION_GONE",
            ErrorCode::Listen => "E_LISTEN",
            ErrorCode::Spawn => "E_SPAWN",
            ErrorCode::Env => "E_ENV",
            ErrorCode::ConfigInvalid => "E_CONFIG_INVALID",
            ErrorCode::BadJson => "E_BAD_JSON",
            ErrorCode::BadRequest => "E_BAD_REQUEST",
            ErrorCode::InvalidParams => "E_INVALID_PARAMS",
            ErrorCode::DirectRpcDisabled => "E_DIRECT_RPC_DISABLED",
            ErrorCode::Rpc => "E_RPC",
            ErrorCode::Output => "E_OUTPUT",
            ErrorCode::TargetNotFillable => "E_TARGET_NOT_FILLABLE",
            ErrorCode::NotSelect => "E_NOT_SELECT",
            ErrorCode::Browser => "E_BROWSER",
            ErrorCode::Screenshot => "E_SCREENSHOT",
            ErrorCode::PreviewMeta => "E_PREVIEW_META",
            ErrorCode::Click => "E_CLICK",
            ErrorCode::Key => "E_KEY",
            ErrorCode::Focus => "E_FOCUS",
            ErrorCode::PageError => "E_PAGE_ERROR",
            ErrorCode::ObserveFailed => "E_OBSERVE_FAILED",
            ErrorCode::FollowFailed => "E_FOLLOW_FAILED",
            ErrorCode::ReleaseInvalid => "E_RELEASE_INVALID",
            ErrorCode::Update => "E_UPDATE",
            ErrorCode::McpConflict => "E_MCP_CONFLICT",
            ErrorCode::AppSsoFailed => "E_APP_SSO_FAILED",
            ErrorCode::TransferNotFound => "E_TRANSFER_NOT_FOUND",
            ErrorCode::TransferState => "E_TRANSFER_STATE",
            ErrorCode::BorrowDenied => "E_BORROW_DENIED",
            ErrorCode::BorrowConflict => "E_BORROW_CONFLICT",
            ErrorCode::BorrowTimeout => "E_BORROW_TIMEOUT",
            ErrorCode::HelpDisabled => "E_HELP_DISABLED",
            ErrorCode::ControlNotHeld => "E_CONTROL_NOT_HELD",
            ErrorCode::ControlBusy => "E_CONTROL_BUSY",
            ErrorCode::ControlStale => "E_CONTROL_STALE",
            ErrorCode::NoDownload => "E_NO_DOWNLOAD",
            ErrorCode::DownloadFailed => "E_DOWNLOAD_FAILED",
            ErrorCode::NoFileChooser => "E_NO_FILE_CHOOSER",
            ErrorCode::TransferOffset => "E_TRANSFER_OFFSET",
            ErrorCode::TransferLimit => "E_TRANSFER_LIMIT",
            ErrorCode::TransferIncomplete => "E_TRANSFER_INCOMPLETE",
            ErrorCode::IncognitoUnavailable => "E_INCOGNITO_UNAVAILABLE",
            ErrorCode::RecipeNotApproved => "E_RECIPE_NOT_APPROVED",
            ErrorCode::RecipeChanged => "E_RECIPE_CHANGED",
            ErrorCode::RecipeExpired => "E_RECIPE_EXPIRED",
            ErrorCode::RecipeDraftEmpty => "E_RECIPE_DRAFT_EMPTY",
            ErrorCode::RecipeLocked => "E_RECIPE_LOCKED",
            ErrorCode::Forbidden => "E_FORBIDDEN",
            ErrorCode::ReadOnly => "E_READ_ONLY",
            ErrorCode::ExecFailed => "E_EXEC_FAILED",
            ErrorCode::Internal => "E_INTERNAL",
        }
    }

    /// 一句话含义（与 `lib/error-codes.mjs` 的注释同源）。
    pub fn description(self) -> &'static str {
        match self {
            ErrorCode::BadArg => "参数缺失/冲突（如 ref 与 selector 同时给）",
            ErrorCode::NotFound => "ref/selector 找不到元素",
            ErrorCode::NotActionable => "目标存在但不可操作（不可见 / 禁用 / 尺寸为 0）",
            ErrorCode::StaleRef => "ref 指向的元素已不在文档里，需重新 observe",
            ErrorCode::OptionNotFound => "select 的目标选项不存在",
            ErrorCode::OptionAmbiguous => "select 的选项文本匹配到多个",
            ErrorCode::UnknownMethod => "未知 method",
            ErrorCode::NoSession => "没有活动会话",
            ErrorCode::SessionBusy => "同一会话已有进行中的操作",
            ErrorCode::SessionPaused => "会话已被人工接管（暂停）",
            ErrorCode::SessionStopped => "会话已结束",
            ErrorCode::QueueFull => "daemon 队列已满",
            ErrorCode::RateLimited => "请求过于频繁",
            ErrorCode::Cancelled => "操作被取消",
            ErrorCode::RequestCancelled => "请求在排队阶段被取消",
            ErrorCode::InputBusy => "输入通道被占用",
            ErrorCode::NoTab => "tabId 不存在（tab 被关闭）",
            ErrorCode::NoBrowser => "没有可用的浏览器实例",
            ErrorCode::BrowserAmbiguous => "浏览器选择器匹配到多个实例或同名名称",
            ErrorCode::StartPending => "会话启动中，操作尚未就绪",
            ErrorCode::StartNotReady => "会话尚未就绪，稍后重试",
            ErrorCode::ObservationStale => "观测结果已过期，需重新 observe",
            ErrorCode::CursorStale => "分页游标已过期",
            ErrorCode::ContextRequired => "该动作要求先提供上下文",
            ErrorCode::ContextStale => "上下文与当前页面不一致（或已被重新 sync 吊销）",
            ErrorCode::CooperationStale => "协作输入层 authority 已失效且无法重新对齐",
            ErrorCode::DependsFailed => "前置依赖步骤未成功",
            ErrorCode::ExpectFailed => "expect 断言不匹配",
            ErrorCode::ObservationChanged => "页面在观测后已变化（观测代数不符）",
            ErrorCode::TargetDetached => "观测时的目标节点已从文档中移除（节点级校验）",
            ErrorCode::TokenBadArg => "passthrough 令牌参数非法（缺 token 或 grantee）",
            ErrorCode::TokenUnknown => "passthrough 令牌不存在或已被清理",
            ErrorCode::TokenExpired => "passthrough 令牌已过期",
            ErrorCode::TokenUsed => "passthrough 令牌已被消费（一次性）",
            ErrorCode::TokenGrantee => "passthrough 令牌与调用方 grantee 不匹配",
            ErrorCode::TokenCapacity => "passthrough 令牌存储已满且无法驱逐",
            ErrorCode::CaptureBadTab => "capture 抑制引用的 tabId 非法",
            ErrorCode::CaptureLimit => "同一 tab 的 capture 抑制引用超过上限",
            ErrorCode::SessionState => "会话状态不允许该操作（状态机拒绝）",
            ErrorCode::SessionTransition => "会话状态迁移非法",
            ErrorCode::LedgerIo => "意图账本读写失败",
            ErrorCode::LedgerWalIo => "意图账本 WAL 写入失败",
            ErrorCode::LedgerFsync => "意图账本持久化（fsync）失败",
            ErrorCode::LedgerRecover => "意图账本崩溃恢复失败",
            ErrorCode::LedgerConflict => "账本结论冲突（重复 resolve 且结论不一致）",
            ErrorCode::LedgerResolveRequired => "非幂等动作的 UNKNOWN 必须显式 resolve(confirmed|not-applied)",
            ErrorCode::TabLeaseHeld => "tab 已被其它会话租用",
            ErrorCode::TabLeaseNotHeld => "tab 租约不存在或已被释放",
            ErrorCode::SnapshotDisabled => "MCP 快照持久化被关闭（BB_MCP_SNAPSHOT=off）",
            ErrorCode::SnapshotWrite => "MCP 快照写盘失败",
            ErrorCode::SnapshotCorrupt => "MCP 快照文件损坏或格式不符",
            ErrorCode::Unsupported => "不支持的请求（兼容别名；优先使用 E_UNSUPPORTED_CAPABILITY）",
            ErrorCode::ArgMissing => "CLI 参数缺失（必填项未提供）",
            ErrorCode::ArgType => "CLI 参数类型非法",
            ErrorCode::ArgEnum => "CLI 参数取值不在枚举内",
            ErrorCode::ArgConflict => "CLI 参数互斥组合冲突",
            ErrorCode::ArgRequires => "CLI 参数依赖缺失（如 --share 需要 --tab）",
            ErrorCode::ArgRange => "CLI 参数数值超出范围",
            ErrorCode::ArgUnexpected => "CLI 参数不被该子命令接受",
            ErrorCode::ArgUsage => "CLI 用法错误",
            ErrorCode::UnknownFlag => "未知命令行选项",
            ErrorCode::BadSubcommand => "未知子命令",
            ErrorCode::HumanGate => "需要人工确认后才能继续（human gate）",
            ErrorCode::EvalCorpus => "eval 语料格式/元数据非法",
            ErrorCode::EvalRunner => "eval 离线运行器执行失败",
            ErrorCode::EvalDom => "eval DOM 层失败",
            ErrorCode::EvalDomArgs => "eval DOM 运行参数非法",
            ErrorCode::EvalDomBadFacts => "eval DOM 事实读取结果非法",
            ErrorCode::EvalDomBadJson => "eval DOM 事实 JSON 解析失败",
            ErrorCode::EvalDomFixture => "eval DOM 夹具缺失或不可读",
            ErrorCode::EvalDomNoBrowser => "eval DOM 需要真实浏览器但未找到",
            ErrorCode::EvalDomNoFacts => "eval DOM 未产出事实",
            ErrorCode::EvalDomNoMarker => "eval DOM 页面缺少完成标记",
            ErrorCode::EvalDomSpawn => "eval DOM 浏览器进程启动失败",
            ErrorCode::Occluded => "目标被遮挡（浮层/弹窗）",
            ErrorCode::Obscured => "视觉坐标落点被铺满视口的元素遮住",
            ErrorCode::TargetMismatch => "视觉坐标落点不属于预期的候选目标",
            ErrorCode::CaptureStale => "截图 capture 不存在或已过期",
            ErrorCode::BadMode => "动作模式取值不支持",
            ErrorCode::DialogPending => "有未处理的页面原生弹窗",
            ErrorCode::Exists => "同名资源已存在",
            ErrorCode::CacheEmpty => "缓存为空",
            ErrorCode::TooLarge => "结果超过大小上限",
            ErrorCode::ResultTooLarge => "结果超过协议允许的大小",
            ErrorCode::JsError => "页面内 JS 抛异常",
            ErrorCode::NavFail => "导航失败",
            ErrorCode::Timeout => "等待类命令超时",
            ErrorCode::DebuggerBusy => "调试器被其它会话占用",
            ErrorCode::UnsupportedCapability => "当前版本不支持该能力",
            ErrorCode::UnsupportedRemote => "远程连接不支持该能力",
            ErrorCode::ProtocolUnsupported => "协议版本不兼容",
            ErrorCode::Auth => "本机鉴权失败",
            ErrorCode::AuthBusy => "鉴权通道正被另一请求占用",
            ErrorCode::AuthChallenge => "鉴权挑战无效",
            ErrorCode::AuthExpired => "鉴权挑战已过期",
            ErrorCode::AuthFailed => "鉴权证明不匹配",
            ErrorCode::AuthProof => "鉴权证明格式或签名字段无效",
            ErrorCode::AuthState => "鉴权状态机不允许该操作",
            ErrorCode::PairInvalid => "配对码无效或已使用",
            ErrorCode::PairRequired => "需要先完成本机配对",
            ErrorCode::PairRejected => "配对 token 已绑定到其它浏览器，请重新配对",
            ErrorCode::PausedManual => "会话因人工接管而暂停",
            ErrorCode::LedgerPending => "有未确认的意图账本记录",
            ErrorCode::Daemon => "daemon 不可用（未启动或连接失败，客户端侧码）",
            ErrorCode::NoDaemon => "连不上 daemon",
            ErrorCode::DaemonTimeout => "daemon 在限定时间内没有响应",
            ErrorCode::Disconnected => "连接已断开",
            ErrorCode::ExtensionGone => "浏览器扩展已断开",
            ErrorCode::Listen => "daemon 端口监听失败",
            ErrorCode::Spawn => "子进程启动失败",
            ErrorCode::Env => "运行环境不满足要求",
            ErrorCode::ConfigInvalid => "配置项取值无效",
            ErrorCode::BadJson => "请求或文件不是合法 JSON",
            ErrorCode::BadRequest => "请求格式不合法",
            ErrorCode::InvalidParams => "参数无效",
            ErrorCode::DirectRpcDisabled => "直连 RPC 已被关闭",
            ErrorCode::Rpc => "RPC 调用失败",
            ErrorCode::Output => "输出写入失败",
            ErrorCode::TargetNotFillable => "目标不可填写（不是输入框/可编辑区）",
            ErrorCode::NotSelect => "目标不是 select 元素",
            ErrorCode::Browser => "浏览器侧操作失败",
            ErrorCode::Screenshot => "远程预览截图失败",
            ErrorCode::PreviewMeta => "远程预览读取页面尺寸失败",
            ErrorCode::Click => "远程预览点击失败",
            ErrorCode::Key => "远程预览按键失败",
            ErrorCode::Focus => "远程预览聚焦标签页失败",
            ErrorCode::PageError => "页面内执行出错",
            ErrorCode::ObserveFailed => "观察采集失败",
            ErrorCode::FollowFailed => "跟随新标签页失败",
            ErrorCode::ReleaseInvalid => "发布信息校验失败",
            ErrorCode::Update => "更新流程失败",
            ErrorCode::McpConflict => "MCP 服务端口/进程冲突",
            ErrorCode::AppSsoFailed => "应用单点登录失败",
            ErrorCode::TransferNotFound => "传输任务不存在",
            ErrorCode::TransferState => "传输任务状态不允许该操作",
            ErrorCode::BorrowDenied => "借用标签页被拒绝",
            ErrorCode::BorrowConflict => "同一标签页已被其他会话借用或正在确认中",
            ErrorCode::BorrowTimeout => "借用标签页超时",
            ErrorCode::HelpDisabled => "人工协助不可用",
            ErrorCode::ControlNotHeld => "共享标签页的控制权不在本会话（exclusive 模式下写动作被拒绝）",
            ErrorCode::ControlBusy => "共享标签页的控制权被其他会话持有，无法认领",
            ErrorCode::ControlStale => "共享标签页的控制权已换代（epoch 不符，需重新读取）",
            ErrorCode::NoDownload => "没有可用的下载",
            ErrorCode::DownloadFailed => "下载失败",
            ErrorCode::NoFileChooser => "没有可用的文件选择器",
            ErrorCode::TransferOffset => "传输偏移不匹配",
            ErrorCode::TransferLimit => "传输超过大小限制",
            ErrorCode::TransferIncomplete => "传输未完成",
            ErrorCode::IncognitoUnavailable => "无痕窗口不可用",
            ErrorCode::RecipeNotApproved => "配方未获批",
            ErrorCode::RecipeChanged => "配方内容已变更",
            ErrorCode::RecipeExpired => "配方已过期",
            ErrorCode::RecipeDraftEmpty => "运行日志里没有可回放的步骤（recipe 草稿为空）",
            ErrorCode::RecipeLocked => "配方正在被另一个进程回放",
            ErrorCode::Forbidden => "当前策略禁止该操作",
            ErrorCode::ReadOnly => "会话是只读 scope，不能执行变更动作",
            ErrorCode::ExecFailed => "exec 脚本执行失败或超时",
            ErrorCode::Internal => "其它异常",
        }
    }

    /// 恢复建议；未登记返回 `None`（调用方按“不可自动重试”处理）。
    pub fn recovery(self) -> Option<ErrorRecovery> {
        match self {
            ErrorCode::BadArg => Some(ErrorRecovery { retry: "no", hint: "检查参数组合" }),
            ErrorCode::NotFound => Some(ErrorRecovery { retry: "after-action", hint: "重新 observe 确认目标是否还在" }),
            ErrorCode::NotActionable => Some(ErrorRecovery { retry: "after-action", hint: "目标不可操作：先等它可见/启用，或换目标" }),
            ErrorCode::StaleRef => Some(ErrorRecovery { retry: "after-action", hint: "ref 已失效：重新 observe" }),
            ErrorCode::NoSession => Some(ErrorRecovery { retry: "after-action", hint: "先 bridge session start（或 bridge open <url>）" }),
            ErrorCode::SessionBusy => Some(ErrorRecovery { retry: "transient", hint: "同一会话有进行中的操作，稍等再用" }),
            ErrorCode::SessionPaused => Some(ErrorRecovery { retry: "after-action", hint: "人工接管中：session resume 后重试" }),
            ErrorCode::QueueFull => Some(ErrorRecovery { retry: "transient", hint: "队列满，稍后重试" }),
            ErrorCode::RateLimited => Some(ErrorRecovery { retry: "transient", hint: "被限流，退避后重试" }),
            ErrorCode::InputBusy => Some(ErrorRecovery { retry: "transient", hint: "输入通道忙，稍后重试" }),
            ErrorCode::NoTab => Some(ErrorRecovery { retry: "after-action", hint: "tab 已被关闭：重新开一个会话/标签页" }),
            ErrorCode::ObservationStale => Some(ErrorRecovery { retry: "after-action", hint: "观测过期：重新 observe" }),
            ErrorCode::ContextStale => Some(ErrorRecovery { retry: "after-action", hint: "上下文已失效：重新 cooperate sync 取新 context" }),
            ErrorCode::CooperationStale => Some(ErrorRecovery { retry: "after-action", hint: "协作 authority 无法对齐：刷新页面或重开会话后重新 cooperate sync" }),
            ErrorCode::ExpectFailed => Some(ErrorRecovery { retry: "no", hint: "断言不符：核对页面实际内容再决定" }),
            ErrorCode::ObservationChanged => Some(ErrorRecovery { retry: "after-action", hint: "页面已变化：重新 observe 后重试" }),
            ErrorCode::TargetDetached => Some(ErrorRecovery { retry: "after-action", hint: "目标节点已被移除：重新 observe/cooperate sync 后用新 ref" }),
            ErrorCode::TokenUnknown => Some(ErrorRecovery { retry: "after-action", hint: "租约不存在或已被清理：重新申请 passthrough" }),
            ErrorCode::TokenExpired => Some(ErrorRecovery { retry: "after-action", hint: "passthrough 租约已过期：重新申请一次 passthrough 再试" }),
            ErrorCode::TokenUsed => Some(ErrorRecovery { retry: "after-action", hint: "租约只能消费一次：重新申请 passthrough" }),
            ErrorCode::TokenGrantee => Some(ErrorRecovery { retry: "no", hint: "租约绑定到其它 tab：用签发它的 tab 消费" }),
            ErrorCode::CaptureLimit => Some(ErrorRecovery { retry: "after-action", hint: "抑制引用过多：检查是否有未释放的 withOverlaysHidden" }),
            ErrorCode::Occluded => Some(ErrorRecovery { retry: "after-action", hint: "先关浮层/弹窗，或用 --force" }),
            ErrorCode::Obscured => Some(ErrorRecovery { retry: "after-action", hint: "落点被遮挡：重新截图取坐标" }),
            ErrorCode::TargetMismatch => Some(ErrorRecovery { retry: "after-action", hint: "坐标落在别的元素上：重新 observe/截图" }),
            ErrorCode::CaptureStale => Some(ErrorRecovery { retry: "after-action", hint: "capture 已失效：重新截图" }),
            ErrorCode::TooLarge => Some(ErrorRecovery { retry: "no", hint: "结果过大，缩小范围（--max-rows / --max-tokens）" }),
            ErrorCode::ResultTooLarge => Some(ErrorRecovery { retry: "no", hint: "结果过大，缩小范围" }),
            ErrorCode::NavFail => Some(ErrorRecovery { retry: "transient", hint: "导航失败，确认 URL 可达后重试" }),
            ErrorCode::Timeout => Some(ErrorRecovery { retry: "after-action", hint: "加 --timeout，或先确认页面是否卡住" }),
            ErrorCode::UnsupportedCapability => Some(ErrorRecovery { retry: "no", hint: "当前版本不支持，换能力" }),
            ErrorCode::UnsupportedRemote => Some(ErrorRecovery { retry: "no", hint: "远程连接不支持，改用本机" }),
            ErrorCode::PairRequired => Some(ErrorRecovery { retry: "after-action", hint: "先完成本机配对（bridge pair）" }),
            ErrorCode::PairRejected => Some(ErrorRecovery { retry: "no", hint: "token 绑定的是另一个浏览器：在目标浏览器重新配对" }),
            ErrorCode::LedgerPending => Some(ErrorRecovery { retry: "after-action", hint: "先 ledger resolve <id> --outcome done|abandoned" }),
            ErrorCode::Daemon => Some(ErrorRecovery { retry: "after-action", hint: "daemon 不可用：先启动 daemon" }),
            ErrorCode::NoDaemon => Some(ErrorRecovery { retry: "after-action", hint: "daemon 未运行：先启动 daemon" }),
            ErrorCode::Disconnected => Some(ErrorRecovery { retry: "transient", hint: "连接断开，稍后重试" }),
            ErrorCode::ExtensionGone => Some(ErrorRecovery { retry: "after-action", hint: "扩展断开：确认浏览器里的扩展已加载" }),
            ErrorCode::BorrowDenied => Some(ErrorRecovery { retry: "no", hint: "用户拒绝借用，别绕过" }),
            ErrorCode::BorrowConflict => Some(ErrorRecovery { retry: "after-action", hint: "该标签页已被锁定：等当前借用结束或会话停止后再试" }),
            ErrorCode::HelpDisabled => Some(ErrorRecovery { retry: "no", hint: "人工协助不可用，自行处理或询问用户" }),
            ErrorCode::ControlNotHeld => Some(ErrorRecovery { retry: "after-action", hint: "共享 tab 的写控制权不在本会话：等租约到期，或让持有者 session handoff 给你" }),
            ErrorCode::ControlBusy => Some(ErrorRecovery { retry: "after-action", hint: "控制权被他人持有：等租约到期（session control 看剩余时间）或请持有者 handoff" }),
            ErrorCode::ControlStale => Some(ErrorRecovery { retry: "after-action", hint: "控制权已换代：重新 session control 读 epoch 后再操作" }),
            ErrorCode::RecipeLocked => Some(ErrorRecovery { retry: "transient", hint: "另一个 recipe 回放正在进行：等它结束（或删掉 <name>.lock）后重试" }),
            ErrorCode::Forbidden => Some(ErrorRecovery { retry: "no", hint: "被策略禁止，换做法或征求用户同意" }),
            ErrorCode::ReadOnly => Some(ErrorRecovery { retry: "no", hint: "只读会话不能点击/输入；需要变更时新建 control scope 会话" }),
            _ => None,
        }
    }

    /// 字符串码 → 枚举；未知码返回 `None`（`normalize` 落到 `E_INTERNAL`）。
    pub fn from_code(code: &str) -> Option<ErrorCode> {
        match code {
            "E_BAD_ARG" => Some(ErrorCode::BadArg),
            "E_NOT_FOUND" => Some(ErrorCode::NotFound),
            "E_NOT_ACTIONABLE" => Some(ErrorCode::NotActionable),
            "E_STALE_REF" => Some(ErrorCode::StaleRef),
            "E_OPTION_NOT_FOUND" => Some(ErrorCode::OptionNotFound),
            "E_OPTION_AMBIGUOUS" => Some(ErrorCode::OptionAmbiguous),
            "E_UNKNOWN_METHOD" => Some(ErrorCode::UnknownMethod),
            "E_NO_SESSION" => Some(ErrorCode::NoSession),
            "E_SESSION_BUSY" => Some(ErrorCode::SessionBusy),
            "E_SESSION_PAUSED" => Some(ErrorCode::SessionPaused),
            "E_SESSION_STOPPED" => Some(ErrorCode::SessionStopped),
            "E_QUEUE_FULL" => Some(ErrorCode::QueueFull),
            "E_RATE_LIMITED" => Some(ErrorCode::RateLimited),
            "E_CANCELLED" => Some(ErrorCode::Cancelled),
            "E_REQUEST_CANCELLED" => Some(ErrorCode::RequestCancelled),
            "E_INPUT_BUSY" => Some(ErrorCode::InputBusy),
            "E_NO_TAB" => Some(ErrorCode::NoTab),
            "E_NO_BROWSER" => Some(ErrorCode::NoBrowser),
            "E_BROWSER_AMBIGUOUS" => Some(ErrorCode::BrowserAmbiguous),
            "E_START_PENDING" => Some(ErrorCode::StartPending),
            "E_START_NOT_READY" => Some(ErrorCode::StartNotReady),
            "E_OBSERVATION_STALE" => Some(ErrorCode::ObservationStale),
            "E_CURSOR_STALE" => Some(ErrorCode::CursorStale),
            "E_CONTEXT_REQUIRED" => Some(ErrorCode::ContextRequired),
            "E_CONTEXT_STALE" => Some(ErrorCode::ContextStale),
            "E_COOPERATION_STALE" => Some(ErrorCode::CooperationStale),
            "E_DEPENDS_FAILED" => Some(ErrorCode::DependsFailed),
            "E_EXPECT_FAILED" => Some(ErrorCode::ExpectFailed),
            "E_OBSERVATION_CHANGED" => Some(ErrorCode::ObservationChanged),
            "E_TARGET_DETACHED" => Some(ErrorCode::TargetDetached),
            "E_TOKEN_BAD_ARG" => Some(ErrorCode::TokenBadArg),
            "E_TOKEN_UNKNOWN" => Some(ErrorCode::TokenUnknown),
            "E_TOKEN_EXPIRED" => Some(ErrorCode::TokenExpired),
            "E_TOKEN_USED" => Some(ErrorCode::TokenUsed),
            "E_TOKEN_GRANTEE" => Some(ErrorCode::TokenGrantee),
            "E_TOKEN_CAPACITY" => Some(ErrorCode::TokenCapacity),
            "E_CAPTURE_BAD_TAB" => Some(ErrorCode::CaptureBadTab),
            "E_CAPTURE_LIMIT" => Some(ErrorCode::CaptureLimit),
            "E_SESSION_STATE" => Some(ErrorCode::SessionState),
            "E_SESSION_TRANSITION" => Some(ErrorCode::SessionTransition),
            "E_LEDGER_IO" => Some(ErrorCode::LedgerIo),
            "E_LEDGER_WAL_IO" => Some(ErrorCode::LedgerWalIo),
            "E_LEDGER_FSYNC" => Some(ErrorCode::LedgerFsync),
            "E_LEDGER_RECOVER" => Some(ErrorCode::LedgerRecover),
            "E_LEDGER_CONFLICT" => Some(ErrorCode::LedgerConflict),
            "E_LEDGER_RESOLVE_REQUIRED" => Some(ErrorCode::LedgerResolveRequired),
            "E_TAB_LEASE_HELD" => Some(ErrorCode::TabLeaseHeld),
            "E_TAB_LEASE_NOT_HELD" => Some(ErrorCode::TabLeaseNotHeld),
            "E_SNAPSHOT_DISABLED" => Some(ErrorCode::SnapshotDisabled),
            "E_SNAPSHOT_WRITE" => Some(ErrorCode::SnapshotWrite),
            "E_SNAPSHOT_CORRUPT" => Some(ErrorCode::SnapshotCorrupt),
            "E_UNSUPPORTED" => Some(ErrorCode::Unsupported),
            "E_ARG_MISSING" => Some(ErrorCode::ArgMissing),
            "E_ARG_TYPE" => Some(ErrorCode::ArgType),
            "E_ARG_ENUM" => Some(ErrorCode::ArgEnum),
            "E_ARG_CONFLICT" => Some(ErrorCode::ArgConflict),
            "E_ARG_REQUIRES" => Some(ErrorCode::ArgRequires),
            "E_ARG_RANGE" => Some(ErrorCode::ArgRange),
            "E_ARG_UNEXPECTED" => Some(ErrorCode::ArgUnexpected),
            "E_ARG_USAGE" => Some(ErrorCode::ArgUsage),
            "E_UNKNOWN_FLAG" => Some(ErrorCode::UnknownFlag),
            "E_BAD_SUBCOMMAND" => Some(ErrorCode::BadSubcommand),
            "E_HUMAN_GATE" => Some(ErrorCode::HumanGate),
            "E_EVAL_CORPUS" => Some(ErrorCode::EvalCorpus),
            "E_EVAL_RUNNER" => Some(ErrorCode::EvalRunner),
            "E_EVAL_DOM" => Some(ErrorCode::EvalDom),
            "E_EVAL_DOM_ARGS" => Some(ErrorCode::EvalDomArgs),
            "E_EVAL_DOM_BAD_FACTS" => Some(ErrorCode::EvalDomBadFacts),
            "E_EVAL_DOM_BAD_JSON" => Some(ErrorCode::EvalDomBadJson),
            "E_EVAL_DOM_FIXTURE" => Some(ErrorCode::EvalDomFixture),
            "E_EVAL_DOM_NO_BROWSER" => Some(ErrorCode::EvalDomNoBrowser),
            "E_EVAL_DOM_NO_FACTS" => Some(ErrorCode::EvalDomNoFacts),
            "E_EVAL_DOM_NO_MARKER" => Some(ErrorCode::EvalDomNoMarker),
            "E_EVAL_DOM_SPAWN" => Some(ErrorCode::EvalDomSpawn),
            "E_OCCLUDED" => Some(ErrorCode::Occluded),
            "E_OBSCURED" => Some(ErrorCode::Obscured),
            "E_TARGET_MISMATCH" => Some(ErrorCode::TargetMismatch),
            "E_CAPTURE_STALE" => Some(ErrorCode::CaptureStale),
            "E_BAD_MODE" => Some(ErrorCode::BadMode),
            "E_DIALOG_PENDING" => Some(ErrorCode::DialogPending),
            "E_EXISTS" => Some(ErrorCode::Exists),
            "E_CACHE_EMPTY" => Some(ErrorCode::CacheEmpty),
            "E_TOO_LARGE" => Some(ErrorCode::TooLarge),
            "E_RESULT_TOO_LARGE" => Some(ErrorCode::ResultTooLarge),
            "E_JS_ERROR" => Some(ErrorCode::JsError),
            "E_NAV_FAIL" => Some(ErrorCode::NavFail),
            "E_TIMEOUT" => Some(ErrorCode::Timeout),
            "E_DEBUGGER_BUSY" => Some(ErrorCode::DebuggerBusy),
            "E_UNSUPPORTED_CAPABILITY" => Some(ErrorCode::UnsupportedCapability),
            "E_UNSUPPORTED_REMOTE" => Some(ErrorCode::UnsupportedRemote),
            "E_PROTOCOL_UNSUPPORTED" => Some(ErrorCode::ProtocolUnsupported),
            "E_AUTH" => Some(ErrorCode::Auth),
            "E_AUTH_BUSY" => Some(ErrorCode::AuthBusy),
            "E_AUTH_CHALLENGE" => Some(ErrorCode::AuthChallenge),
            "E_AUTH_EXPIRED" => Some(ErrorCode::AuthExpired),
            "E_AUTH_FAILED" => Some(ErrorCode::AuthFailed),
            "E_AUTH_PROOF" => Some(ErrorCode::AuthProof),
            "E_AUTH_STATE" => Some(ErrorCode::AuthState),
            "E_PAIR_INVALID" => Some(ErrorCode::PairInvalid),
            "E_PAIR_REQUIRED" => Some(ErrorCode::PairRequired),
            "E_PAIR_REJECTED" => Some(ErrorCode::PairRejected),
            "E_PAUSED_MANUAL" => Some(ErrorCode::PausedManual),
            "E_LEDGER_PENDING" => Some(ErrorCode::LedgerPending),
            "E_DAEMON" => Some(ErrorCode::Daemon),
            "E_NO_DAEMON" => Some(ErrorCode::NoDaemon),
            "E_DAEMON_TIMEOUT" => Some(ErrorCode::DaemonTimeout),
            "E_DISCONNECTED" => Some(ErrorCode::Disconnected),
            "E_EXTENSION_GONE" => Some(ErrorCode::ExtensionGone),
            "E_LISTEN" => Some(ErrorCode::Listen),
            "E_SPAWN" => Some(ErrorCode::Spawn),
            "E_ENV" => Some(ErrorCode::Env),
            "E_CONFIG_INVALID" => Some(ErrorCode::ConfigInvalid),
            "E_BAD_JSON" => Some(ErrorCode::BadJson),
            "E_BAD_REQUEST" => Some(ErrorCode::BadRequest),
            "E_INVALID_PARAMS" => Some(ErrorCode::InvalidParams),
            "E_DIRECT_RPC_DISABLED" => Some(ErrorCode::DirectRpcDisabled),
            "E_RPC" => Some(ErrorCode::Rpc),
            "E_OUTPUT" => Some(ErrorCode::Output),
            "E_TARGET_NOT_FILLABLE" => Some(ErrorCode::TargetNotFillable),
            "E_NOT_SELECT" => Some(ErrorCode::NotSelect),
            "E_BROWSER" => Some(ErrorCode::Browser),
            "E_SCREENSHOT" => Some(ErrorCode::Screenshot),
            "E_PREVIEW_META" => Some(ErrorCode::PreviewMeta),
            "E_CLICK" => Some(ErrorCode::Click),
            "E_KEY" => Some(ErrorCode::Key),
            "E_FOCUS" => Some(ErrorCode::Focus),
            "E_PAGE_ERROR" => Some(ErrorCode::PageError),
            "E_OBSERVE_FAILED" => Some(ErrorCode::ObserveFailed),
            "E_FOLLOW_FAILED" => Some(ErrorCode::FollowFailed),
            "E_RELEASE_INVALID" => Some(ErrorCode::ReleaseInvalid),
            "E_UPDATE" => Some(ErrorCode::Update),
            "E_MCP_CONFLICT" => Some(ErrorCode::McpConflict),
            "E_APP_SSO_FAILED" => Some(ErrorCode::AppSsoFailed),
            "E_TRANSFER_NOT_FOUND" => Some(ErrorCode::TransferNotFound),
            "E_TRANSFER_STATE" => Some(ErrorCode::TransferState),
            "E_BORROW_DENIED" => Some(ErrorCode::BorrowDenied),
            "E_BORROW_CONFLICT" => Some(ErrorCode::BorrowConflict),
            "E_BORROW_TIMEOUT" => Some(ErrorCode::BorrowTimeout),
            "E_HELP_DISABLED" => Some(ErrorCode::HelpDisabled),
            "E_CONTROL_NOT_HELD" => Some(ErrorCode::ControlNotHeld),
            "E_CONTROL_BUSY" => Some(ErrorCode::ControlBusy),
            "E_CONTROL_STALE" => Some(ErrorCode::ControlStale),
            "E_NO_DOWNLOAD" => Some(ErrorCode::NoDownload),
            "E_DOWNLOAD_FAILED" => Some(ErrorCode::DownloadFailed),
            "E_NO_FILE_CHOOSER" => Some(ErrorCode::NoFileChooser),
            "E_TRANSFER_OFFSET" => Some(ErrorCode::TransferOffset),
            "E_TRANSFER_LIMIT" => Some(ErrorCode::TransferLimit),
            "E_TRANSFER_INCOMPLETE" => Some(ErrorCode::TransferIncomplete),
            "E_INCOGNITO_UNAVAILABLE" => Some(ErrorCode::IncognitoUnavailable),
            "E_RECIPE_NOT_APPROVED" => Some(ErrorCode::RecipeNotApproved),
            "E_RECIPE_CHANGED" => Some(ErrorCode::RecipeChanged),
            "E_RECIPE_EXPIRED" => Some(ErrorCode::RecipeExpired),
            "E_RECIPE_DRAFT_EMPTY" => Some(ErrorCode::RecipeDraftEmpty),
            "E_RECIPE_LOCKED" => Some(ErrorCode::RecipeLocked),
            "E_FORBIDDEN" => Some(ErrorCode::Forbidden),
            "E_READ_ONLY" => Some(ErrorCode::ReadOnly),
            "E_EXEC_FAILED" => Some(ErrorCode::ExecFailed),
            "E_INTERNAL" => Some(ErrorCode::Internal),
            _ => None,
        }
    }
}

