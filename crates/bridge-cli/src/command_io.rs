//! 会话 / 观察命令共用的 daemon 上下文：发现 → TLS 守卫 → `/rpc` → 错误富化。
//!
//! 为什么单独一层（而不是在 `session_cmd`、`observe_cmd` 里各写一遍）：
//! - **TLS 守卫必须在任何网络请求之前**：`open` 里先 `tls_policy::guard`，再谈调用；
//! - **错误语义统一**：所有失败都带 `E_*` 单源错误码 + 发现文件/端点上下文（不含 token），
//!   `--json` 与文本模式的退出码一致（3）；
//! - **超时归一**：`--timeout` → [`rpc_client::normalize_timeout_ms`]（1..=600000，缺省 60s），
//!   业务命令不重复实现。
//!
//! 只读约束：本模块不判断方法是否只读（那是 `observe_cmd` 的 `assert_read_only`），
//! 也不缓存连接（一次命令一连接，与 daemon `connection: close` 契约一致）。

use crate::discovery::{DaemonHome, DaemonMetadata};
use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;
use crate::rpc_client::{self, DaemonClient};
use crate::status::{self, CommandOutput};

/// 一次命令执行期间的 daemon 上下文（发现结果 + 已构造的客户端 + 归一超时）。
#[derive(Debug, Clone)]
pub struct DaemonContext {
    pub metadata: DaemonMetadata,
    pub client: DaemonClient,
    pub timeout_ms: u64,
}

impl DaemonContext {
    /// 从进程环境发现 daemon（`BB_HOME` → `%USERPROFILE%\.browser-bridge`）并做 TLS 守卫。
    pub fn open(timeout_ms: Option<u64>) -> Result<Self, RpcError> {
        let home = DaemonHome::from_env()?;
        Self::open_with(home, timeout_ms)
    }

    /// 纯函数版本：便于测试用固定目录，不触碰进程环境（避免测试并行时的环境竞态）。
    pub fn open_with(home: DaemonHome, timeout_ms: Option<u64>) -> Result<Self, RpcError> {
        let timeout_ms = rpc_client::normalize_timeout_ms(timeout_ms);
        let metadata = home.read_metadata()?;
        // 运行时路径上的 TLS 策略：`tls:true` 的 daemon 在发起任何请求之前就被明确拒绝。
        crate::tls_policy::guard(&metadata)?;
        let client = DaemonClient::new(metadata.clone());
        Ok(Self { metadata, client, timeout_ms })
    }

    /// `POST /rpc <method>`；失败时统一补上发现上下文（端点/发现文件/端口，不含 token）。
    pub fn call(&self, method: &str, params: Json) -> Result<Json, RpcError> {
        self.client
            .call(method, params, self.timeout_ms)
            .map_err(|error| status::enrich_discovery(error, &self.metadata))
    }

    /// 成功输出里的 `daemon` 段（`tokenPresent`/`tokenLength`，绝不含明文 token）。
    pub fn daemon_json(&self) -> Json {
        self.metadata.to_json()
    }

    /// 失败输出：`--json` 写 stdout 结构化错误，文本写 stderr；退出码 3。
    pub fn failure(&self, error: &RpcError, json: bool) -> CommandOutput {
        status::error_output(&status::enrich_discovery(error.clone(), &self.metadata), json)
    }
}

/// 发现阶段（还没有 metadata）的失败输出。
pub fn discovery_failure(error: &RpcError, json: bool) -> CommandOutput {
    status::error_output(error, json)
}

/// 参数校验用的 `E_ARG_*` 错误（与 `cli::parse` 共用退出码 2 的渲染路径）。
pub fn arg_error(code: ErrorCode, message: impl Into<String>) -> RpcError {
    RpcError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::HomeSource;
    use std::path::PathBuf;

    struct TempHome {
        dir: PathBuf,
    }

    impl TempHome {
        fn new(tag: &str) -> Self {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
            std::fs::create_dir_all(&base).expect("创建测试临时目录根");
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let dir = base.join(format!("command-io-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            Self { dir }
        }

        fn write_daemon_json(&self, text: &str) {
            std::fs::write(self.dir.join("daemon.json"), text).expect("写 daemon.json");
        }

        fn context(&self) -> DaemonHome {
            DaemonHome { dir: self.dir.clone(), source: HomeSource::Env }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn missing_discovery_file_is_no_daemon() {
        let temp = TempHome::new("missing");
        let error = DaemonContext::open_with(temp.context(), Some(1_000)).expect_err("缺少 daemon.json");
        assert_eq!(error.code, ErrorCode::NoDaemon);
        assert!(error.message.contains("daemon.json"), "消息应指出发现文件：{}", error.message);
        assert!(error.message.contains("daemon 未运行"), "消息应给出下一步：{}", error.message);
        let data = error.data.clone().expect("data");
        assert_eq!(data.get("homeSource").and_then(Json::as_str), Some("env"));
        let output = discovery_failure(&error, false);
        assert_eq!(output.exit_code, status::EXIT_CODE_DAEMON);
        assert!(output.stderr.contains("E_NO_DAEMON"));
    }

    #[test]
    fn tls_daemon_is_rejected_before_any_network_call() {
        let temp = TempHome::new("tls");
        // 端口 1 上没有服务；如果守卫没有在请求前生效，错误会是 E_NO_DAEMON 而不是 TLS 拒绝。
        temp.write_daemon_json(r#"{"pid":1,"port":1,"token":"t","version":"0.3.0","tls":true}"#);
        let error = DaemonContext::open_with(temp.context(), Some(200)).expect_err("TLS 必须拒绝");
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
        assert_eq!(error.code.as_str(), "E_UNSUPPORTED_CAPABILITY");
        let data = error.data.expect("data");
        assert_eq!(data.get("tls").and_then(Json::as_bool), Some(true));
        assert_eq!(data.get("endpoint").and_then(Json::as_str), Some("127.0.0.1:1"));
        assert!(data.get("replacements").and_then(Json::as_array).is_some_and(|items| !items.is_empty()));
    }

    #[test]
    fn open_normalizes_timeout_and_keeps_metadata_off_the_wire() {
        let temp = TempHome::new("timeout");
        temp.write_daemon_json(r#"{"pid":1,"port":1,"token":"secret","version":"0.3.0"}"#);
        let context = DaemonContext::open_with(temp.context(), None).expect("明文 daemon 放行");
        assert_eq!(context.timeout_ms, rpc_client::DEFAULT_RPC_TIMEOUT_MS);
        let context = DaemonContext::open_with(temp.context(), Some(1_500)).expect("放行");
        assert_eq!(context.timeout_ms, 1_500);
        assert_eq!(context.client.metadata.port, 1);
        let encoded = context.daemon_json().to_compact_string();
        assert!(!encoded.contains("secret"), "daemon 段绝不能泄漏 token：{encoded}");
        assert!(encoded.contains("\"tokenPresent\":true"));
    }

    #[test]
    fn call_to_dead_port_is_structured_and_enriched() {
        let temp = TempHome::new("dead");
        // 选一个当前必然没人监听的端口：先绑定再释放（同一进程内测试独占，概率足够）。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        drop(listener);
        temp.write_daemon_json(&format!(r#"{{"pid":1,"port":{port},"token":"t","tls":false}}"#));
        let context = DaemonContext::open_with(temp.context(), Some(500)).expect("放行");
        let error = context.call("session.list", Json::Object(Vec::new())).expect_err("连接失败");
        assert!(
            matches!(error.code, ErrorCode::NoDaemon | ErrorCode::DaemonTimeout | ErrorCode::Daemon),
            "错误码应为传输类：{:?}",
            error.code
        );
        let data = error.data.clone().expect("data");
        let daemon = data.get("daemon").expect("失败输出必须带发现上下文");
        assert_eq!(daemon.get("endpoint").and_then(Json::as_str), Some(format!("127.0.0.1:{port}").as_str()));
        assert!(daemon.get("reachable").is_none(), "失败上下文不应伪造可达");
        let output = context.failure(&error, true);
        assert_eq!(output.exit_code, status::EXIT_CODE_DAEMON);
        let json = Json::parse(&output.stdout).expect("JSON 错误体");
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(false));
    }
}
