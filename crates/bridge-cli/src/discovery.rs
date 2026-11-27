//! daemon 发现：解析 `%USERPROFILE%\.browser-bridge\daemon.json`（`BB_HOME` 可覆盖）。
//!
//! 契约只读对齐 `daemon/server.mjs`（`resolveHomeDir` / `writeDaemonJson` / `readDaemonJson`）
//! 与 `cli/bridge.mjs`（`readDaemonInfo` / `locateDaemon`）：
//! - 状态目录：`BB_HOME`（非空则 `path.resolve`）优先，否则 `os.homedir()/.browser-bridge`；
//! - `daemon.json` 字段：`pid`（number）、`port`（number，必填）、`token`（string，必填）、
//!   `version`、`startedAt`（ms 时间戳）、`tls`（bool）；daemon 原子写（临时文件 + rename）；
//! - 文件缺失/半截/字段非法时，Node CLI 会静默回退到端口探测；Rust 侧**不猜测**：
//!   缺失 → `E_NO_DAEMON`，坏 JSON/坏字段 → `E_CONFIG_INVALID`，都带结构化 `data`
//!   （含解析后的绝对路径、home 来源、JSON 偏移），方便调用方给出可执行下一步。
//!
//! 不做的事（有意）：不探测端口兜底（那需要 token 才能鉴权，探测到也调不通 `/rpc`，
//! 只会产生误导性成功）；不判断 pid 存活（`/health` 才是唯一可信的存在性证据）。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;

/// 状态目录环境变量（与 daemon/CLI 一致）。
pub const HOME_ENV: &str = "BB_HOME";
/// 默认状态目录名（用户主目录下）。
pub const DEFAULT_HOME_DIRNAME: &str = ".browser-bridge";
/// 发现文件名。
pub const DAEMON_FILE_NAME: &str = "daemon.json";
/// 鉴权头（daemon `rpc.js` 只认这个头名）。
pub const TOKEN_HEADER: &str = "x-bridge-token";
/// 健康检查路径。
pub const HEALTH_PATH: &str = "/health";
/// RPC 路径。
pub const RPC_PATH: &str = "/rpc";
/// WebSocket 升级路径（`lib/ws.mjs attachWsServer` 默认 `/ws`）。
pub const WS_PATH: &str = "/ws";

/// 状态目录来源（诊断用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeSource {
    /// 显式 `BB_HOME`。
    Env,
    /// `USERPROFILE`（Windows）。
    UserProfile,
    /// `HOME`（Unix / 兼容环境）。
    Home,
}

impl HomeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            HomeSource::Env => "env",
            HomeSource::UserProfile => "userprofile",
            HomeSource::Home => "home",
        }
    }
}

/// 解析后的状态目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonHome {
    pub dir: PathBuf,
    pub source: HomeSource,
}

impl DaemonHome {
    /// 从进程环境解析（`BB_HOME` → `USERPROFILE` → `HOME`）。
    pub fn from_env() -> Result<Self, RpcError> {
        let read = |name: &str| std::env::var_os(name);
        Self::resolve(read(HOME_ENV), read("USERPROFILE"), read("HOME"), std::env::current_dir().ok())
    }

    /// 纯函数版本：便于用固定环境测试，不触碰真实进程环境（避免测试并行时的环境竞态）。
    pub fn resolve(
        env_home: Option<OsString>,
        user_profile: Option<OsString>,
        home: Option<OsString>,
        cwd: Option<PathBuf>,
    ) -> Result<Self, RpcError> {
        if let Some(value) = env_home.filter(|value| !value.is_empty()) {
            let path = PathBuf::from(value);
            return Ok(Self { dir: absolutize(path, cwd.as_deref()), source: HomeSource::Env });
        }
        for (candidate, source) in [
            (user_profile, HomeSource::UserProfile),
            (home, HomeSource::Home),
        ] {
            if let Some(value) = candidate.filter(|value| !value.is_empty()) {
                let base = PathBuf::from(value);
                return Ok(Self { dir: absolutize(base.join(DEFAULT_HOME_DIRNAME), cwd.as_deref()), source });
            }
        }
        Err(RpcError::new(
            ErrorCode::Env,
            format!(
                "无法确定状态目录：{HOME_ENV} / USERPROFILE / HOME 均未设置；请设置 {HOME_ENV} 指向 daemon 状态目录"
            ),
        )
        .with_data(crate::json_obj! {
            "env" => Json::string(HOME_ENV),
            "searched" => crate::json_arr![
                Json::string("BB_HOME"),
                Json::string("USERPROFILE"),
                Json::string("HOME"),
            ],
        }))
    }

    pub fn daemon_file(&self) -> PathBuf {
        self.dir.join(DAEMON_FILE_NAME)
    }

    /// 读取并解析 `daemon.json`；文件缺失 → `E_NO_DAEMON`，内容坏 → `E_CONFIG_INVALID`。
    pub fn read_metadata(&self) -> Result<DaemonMetadata, RpcError> {
        let path = self.daemon_file();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                let code = match error.kind() {
                    std::io::ErrorKind::NotFound => ErrorCode::NoDaemon,
                    _ => ErrorCode::ConfigInvalid,
                };
                let message = match error.kind() {
                    std::io::ErrorKind::NotFound => format!(
                        "找不到 daemon 发现文件 {path}（daemon 未运行？先执行 node cli/bridge.mjs status 或 bridge daemon start）",
                        path = path.display()
                    ),
                    _ => format!("读取 daemon 发现文件 {} 失败：{error}", path.display()),
                };
                return Err(RpcError::new(code, message).with_data(self.discovery_data(&path)));
            }
        };
        let mut metadata = parse_daemon_json(&text, &path)?;
        metadata.home = self.dir.clone();
        metadata.home_source = self.source;
        Ok(metadata)
    }

    /// 发现相关的结构化 data（不含 token）。
    pub fn discovery_data(&self, path: &Path) -> Json {
        crate::json_obj! {
            "home" => Json::string(self.dir.display().to_string()),
            "homeSource" => Json::string(self.source.as_str()),
            "discoveryFile" => Json::string(path.display().to_string()),
        }
    }
}

/// `daemon.json` 的已校验内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonMetadata {
    pub pid: Option<u64>,
    pub port: u16,
    pub token: String,
    pub version: Option<String>,
    /// daemon 写入的毫秒时间戳（`Date.now()`）。
    pub started_at: Option<u64>,
    pub tls: bool,
    pub path: PathBuf,
    pub home: PathBuf,
    pub home_source: HomeSource,
}

impl DaemonMetadata {
    /// HTTP 端点（daemon 只监听回环地址；`server.mjs` 默认 `127.0.0.1`）。
    pub fn endpoint_label(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// token 长度（输出用，绝不输出 token 本体）。
    pub fn token_len(&self) -> usize {
        self.token.len()
    }

    /// `status --json` 的 `daemon` 段：路径 + 端口 + token 存在性，不含明文 token。
    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "reachable" => Json::Bool(true),
            "discoveryFile" => Json::string(self.path.display().to_string()),
            "home" => Json::string(self.home.display().to_string()),
            "homeSource" => Json::string(self.home_source.as_str()),
            "endpoint" => Json::string(self.endpoint_label()),
            "port" => Json::Number(f64::from(self.port)),
            "pid" => self.pid.map(|pid| Json::Number(pid as f64)).unwrap_or(Json::Null),
            "version" => self.version.as_deref().map(Json::string).unwrap_or(Json::Null),
            "startedAt" => self.started_at.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
            "tls" => Json::Bool(self.tls),
            "tokenPresent" => Json::Bool(!self.token.is_empty()),
            "tokenLength" => Json::Number(self.token_len() as f64),
            "tokenHeader" => Json::string(TOKEN_HEADER),
            "healthPath" => Json::string(HEALTH_PATH),
            "rpcPath" => Json::string(RPC_PATH),
            "wsPath" => Json::string(WS_PATH),
        }
    }
}

/// 纯解析入口（文件 IO 之外的全部校验都在这里，便于用固定夹具测试）。
pub fn parse_daemon_json(text: &str, path: &Path) -> Result<DaemonMetadata, RpcError> {
    let value = Json::parse(text).map_err(|error| {
        RpcError::new(
            ErrorCode::ConfigInvalid,
            format!("daemon 发现文件 {} 不是合法 JSON：{error}", path.display()),
        )
        .with_data(crate::json_obj! {
            "discoveryFile" => Json::string(path.display().to_string()),
            "jsonOffset" => Json::Number(error.offset as f64),
            "jsonError" => Json::string(error.message.clone()),
        })
    })?;
    if !matches!(value, Json::Object(_)) {
        return Err(invalid_field(path, "root", "必须是 JSON 对象"));
    }

    let port = match value.get("port") {
        Some(Json::Number(number)) if number.is_finite() && *number >= 1.0 && *number <= 65535.0 && number.fract() == 0.0 => {
            *number as u16
        }
        Some(other) => {
            return Err(invalid_field(path, "port", format!("必须是 1..=65535 的整数，实际 {other}")));
        }
        None => return Err(invalid_field(path, "port", "缺少必填字段")),
    };

    let token = match value.get("token") {
        Some(Json::String(token)) if !token.trim().is_empty() => token.clone(),
        Some(Json::String(_)) => return Err(invalid_field(path, "token", "不能是空字符串")),
        Some(_) => return Err(invalid_field(path, "token", "必须是字符串")),
        None => return Err(invalid_field(path, "token", "缺少必填字段")),
    };

    // 可选字段：类型不符时忽略（daemon 未来可能扩字段，宽容读取但不猜测语义）。
    let pid = value.get("pid").and_then(Json::as_u64).filter(|pid| *pid > 0 && *pid <= u64::from(u32::MAX));
    let started_at = value.get("startedAt").and_then(Json::as_u64);
    let version = value
        .get("version")
        .and_then(Json::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string);
    let tls = value.get("tls").and_then(Json::as_bool).unwrap_or(false);

    Ok(DaemonMetadata {
        pid,
        port,
        token,
        version,
        started_at,
        tls,
        path: path.to_path_buf(),
        home: path.parent().map(Path::to_path_buf).unwrap_or_default(),
        home_source: HomeSource::Env,
    })
}

fn invalid_field(path: &Path, field: &str, reason: impl Into<String>) -> RpcError {
    RpcError::new(
        ErrorCode::ConfigInvalid,
        format!("daemon 发现文件 {} 字段 {field} 非法：{}", path.display(), reason.into()),
    )
    .with_data(crate::json_obj! {
        "discoveryFile" => Json::string(path.display().to_string()),
        "field" => Json::string(field),
    })
}

fn absolutize(path: PathBuf, cwd: Option<&Path>) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    match cwd {
        Some(cwd) => cwd.join(path),
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    /// 独立临时目录（测试并行安全；名字带时间 + 计数器）。
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let unique = UNIQUE.fetch_add(1, Ordering::Relaxed);
            // 测试临时目录放在 crate 的 target/ 下：不依赖 %TEMP% 的权限（某些受限环境会拒绝
            // 在系统临时目录下创建子目录），且随 `cargo clean` 一起清理。
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
            std::fs::create_dir_all(&base).expect("创建测试临时目录根");
            let path = base.join(format!("discovery-{tag}-{}-{nanos}-{unique}", std::process::id()));
            std::fs::create_dir_all(&path).expect("创建临时目录");
            Self { path }
        }

        fn write_daemon_json(&self, text: &str) -> PathBuf {
            let path = self.path.join(DAEMON_FILE_NAME);
            std::fs::write(&path, text).expect("写 daemon.json");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn home(dir: &Path) -> DaemonHome {
        DaemonHome { dir: dir.to_path_buf(), source: HomeSource::Env }
    }

    #[test]
    fn env_home_wins_and_is_absolutized() {
        let cwd = PathBuf::from(r"D:\work");
        let resolved = DaemonHome::resolve(
            Some(OsString::from("custom-home")),
            Some(OsString::from(r"C:\Users\someone")),
            Some(OsString::from("/home/someone")),
            Some(cwd.clone()),
        )
        .expect("BB_HOME 优先");
        assert_eq!(resolved.source, HomeSource::Env);
        assert_eq!(resolved.dir, cwd.join("custom-home"));
        assert_eq!(resolved.daemon_file(), cwd.join("custom-home").join(DAEMON_FILE_NAME));
    }

    #[test]
    fn falls_back_to_userprofile_then_home() {
        let profile = DaemonHome::resolve(None, Some(OsString::from(r"C:\Users\u")), None, None).expect("USERPROFILE");
        assert_eq!(profile.source, HomeSource::UserProfile);
        assert_eq!(profile.dir, PathBuf::from(r"C:\Users\u").join(DEFAULT_HOME_DIRNAME));

        let unix = DaemonHome::resolve(None, None, Some(OsString::from("/home/u")), None).expect("HOME");
        assert_eq!(unix.source, HomeSource::Home);
        assert_eq!(unix.dir, PathBuf::from("/home/u").join(DEFAULT_HOME_DIRNAME));

        // 空 BB_HOME 视为未设置。
        let skipped = DaemonHome::resolve(Some(OsString::new()), Some(OsString::from(r"C:\x")), None, None).expect("跳过空值");
        assert_eq!(skipped.source, HomeSource::UserProfile);
    }

    #[test]
    fn no_home_at_all_is_structured_env_error() {
        let error = DaemonHome::resolve(None, None, None, None).expect_err("必须有兜底错误");
        assert_eq!(error.code, ErrorCode::Env);
        let data = error.data.expect("data");
        assert_eq!(data.get("env").and_then(Json::as_str), Some(HOME_ENV));
        assert_eq!(data.get("searched").and_then(Json::as_array).map(<[Json]>::len), Some(3));
    }

    #[test]
    fn parses_real_daemon_json_shape() {
        // 取自本机 %USERPROFILE%\.browser-bridge\daemon.json 的真实形状（token 已替换为假值）。
        let text = r#"{"pid":2216,"port":52900,"token":"f357544091f6998cbdb61fcd02b6e5d9","version":"0.3.0","startedAt":1795598248515,"tls":false}"#;
        let metadata = parse_daemon_json(text, Path::new(r"C:\Users\CFT\.browser-bridge\daemon.json")).expect("解析");
        assert_eq!(metadata.port, 52900);
        assert_eq!(metadata.pid, Some(2216));
        assert_eq!(metadata.token, "f357544091f6998cbdb61fcd02b6e5d9");
        assert_eq!(metadata.version.as_deref(), Some("0.3.0"));
        assert_eq!(metadata.started_at, Some(1_795_598_248_515));
        assert!(!metadata.tls);
        assert_eq!(metadata.endpoint_label(), "127.0.0.1:52900");
        assert_eq!(metadata.token_len(), 32);
    }

    #[test]
    fn minimal_shape_and_optional_fields() {
        let metadata = parse_daemon_json(r#"{"port":1,"token":"t"}"#, Path::new("d.json")).expect("最小形状");
        assert_eq!(metadata.port, 1);
        assert_eq!(metadata.pid, None);
        assert_eq!(metadata.version, None);
        assert_eq!(metadata.started_at, None);
        assert!(!metadata.tls);
        // 可选字段类型不符：忽略而不是报错（向前兼容）。
        let metadata = parse_daemon_json(
            r#"{"port":8080,"token":"t","pid":"nope","version":7,"startedAt":-1,"tls":"yes"}"#,
            Path::new("d.json"),
        )
        .expect("可选字段宽容");
        assert_eq!(metadata.port, 8080);
        assert_eq!(metadata.pid, None);
        assert_eq!(metadata.version, None);
        assert_eq!(metadata.started_at, None);
        assert!(!metadata.tls);
        // tls:true 要正确读出。
        let metadata = parse_daemon_json(r#"{"port":8443,"token":"t","tls":true}"#, Path::new("d.json")).expect("tls");
        assert!(metadata.tls);
    }

    #[test]
    fn invalid_port_shapes_are_config_invalid() {
        for text in [
            r#"{"token":"t"}"#,
            r#"{"port":"52900","token":"t"}"#,
            r#"{"port":0,"token":"t"}"#,
            r#"{"port":65536,"token":"t"}"#,
            r#"{"port":1.5,"token":"t"}"#,
            r#"{"port":null,"token":"t"}"#,
        ] {
            let error = parse_daemon_json(text, Path::new("d.json")).expect_err("必须拒绝");
            assert_eq!(error.code, ErrorCode::ConfigInvalid, "夹具 {text}");
            let data = error.data.expect("data");
            assert_eq!(data.get("field").and_then(Json::as_str), Some("port"));
        }
    }

    #[test]
    fn invalid_token_shapes_are_config_invalid() {
        for (text, reason) in [
            (r#"{"port":1}"#, "缺少必填字段"),
            (r#"{"port":1,"token":""}"#, "不能是空字符串"),
            (r#"{"port":1,"token":"   "}"#, "不能是空字符串"),
            (r#"{"port":1,"token":7}"#, "必须是字符串"),
        ] {
            let error = parse_daemon_json(text, Path::new("d.json")).expect_err("必须拒绝");
            assert_eq!(error.code, ErrorCode::ConfigInvalid, "夹具 {text}");
            assert!(error.message.contains(reason), "夹具 {text}：{}", error.message);
            assert_eq!(error.data.expect("data").get("field").and_then(Json::as_str), Some("token"));
        }
    }

    #[test]
    fn malformed_json_reports_offset() {
        let error = parse_daemon_json("{oops", Path::new("d.json")).expect_err("坏 JSON");
        assert_eq!(error.code, ErrorCode::ConfigInvalid);
        let data = error.data.expect("data");
        assert!(data.get("jsonOffset").and_then(Json::as_u64).is_some());
        assert!(data.get("jsonError").and_then(Json::as_str).is_some());
        // 顶层不是对象同样拒绝。
        for text in ["[]", "null", "42"] {
            let error = parse_daemon_json(text, Path::new("d.json")).expect_err("顶层必须对象");
            assert_eq!(error.code, ErrorCode::ConfigInvalid);
            assert_eq!(error.data.expect("data").get("field").and_then(Json::as_str), Some("root"));
        }
    }

    #[test]
    fn reads_file_and_stamps_home_provenance() {
        let temp = TempDir::new("read");
        temp.write_daemon_json(r#"{"pid":42,"port":52900,"token":"abc","tls":true}"#);
        let metadata = home(&temp.path).read_metadata().expect("读取成功");
        assert_eq!(metadata.port, 52900);
        assert_eq!(metadata.home, temp.path);
        assert_eq!(metadata.home_source, HomeSource::Env);
        assert_eq!(metadata.path, temp.path.join(DAEMON_FILE_NAME));
    }

    #[test]
    fn missing_file_is_no_daemon_with_actionable_hint() {
        let temp = TempDir::new("missing");
        let error = home(&temp.path).read_metadata().expect_err("必须报缺失");
        assert_eq!(error.code, ErrorCode::NoDaemon);
        assert!(error.message.contains(DAEMON_FILE_NAME), "{}", error.message);
        assert!(error.message.contains("daemon 未运行"), "{}", error.message);
        let data = error.data.expect("data");
        assert_eq!(data.get("home").and_then(Json::as_str), Some(temp.path.display().to_string().as_str()));
        assert_eq!(data.get("homeSource").and_then(Json::as_str), Some("env"));
    }

    #[test]
    fn empty_file_is_config_invalid() {
        let temp = TempDir::new("empty");
        temp.write_daemon_json("");
        let error = home(&temp.path).read_metadata().expect_err("空文件");
        assert_eq!(error.code, ErrorCode::ConfigInvalid);
        assert!(error.message.contains("不是合法 JSON"), "{}", error.message);
    }

    #[test]
    fn metadata_json_never_leaks_token() {
        let metadata = parse_daemon_json(r#"{"port":52900,"token":"super-secret-token"}"#, Path::new(r"C:\h\daemon.json"))
            .expect("解析");
        let encoded = metadata.to_json().to_compact_string();
        assert!(!encoded.contains("super-secret-token"), "输出绝不能包含 token：{encoded}");
        assert!(encoded.contains("\"tokenPresent\":true"));
        assert!(encoded.contains("\"tokenLength\":18"));
        assert!(encoded.contains("\"endpoint\":\"127.0.0.1:52900\""));
        assert!(encoded.contains("\"wsPath\":\"/ws\""));
        assert!(encoded.contains("\"rpcPath\":\"/rpc\""));
        assert!(encoded.contains("\"healthPath\":\"/health\""));
    }
}
