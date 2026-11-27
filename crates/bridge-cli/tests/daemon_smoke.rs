//! 进程级冒烟：**真实** Node daemon（`daemon/server.mjs`）↔ Rust 客户端。
//!
//! 流程（与任务验收一致）：
//! 1. 用 `node cli/bridge.mjs status --json` 触发真实 daemon（CLI 的 `ensureDaemon` 会在
//!    daemon 未运行时 spawn 并等 `/health` 就绪，然后原子写 `daemon.json`）；
//! 2. `bridge-rs` 库层发现 `daemon.json` → `GET /health` → `POST /rpc status` → WebSocket
//!    hello/hello-ack；
//! 3. 再用 `bridge-rs` 真实二进制跑 `status --json` / `health --json` / `ws-hello --json`，
//!    断言退出码与 JSON 结构。
//!
//! 状态目录：默认用 `target/test-tmp/bb-smoke-home` 作为**隔离 `BB_HOME`**（见 [`smoke_home`]），
//! 这样冒烟不依赖、也不污染 `%USERPROFILE%\.browser-bridge` 里正在运行的真实 daemon；
//! 显式设置 `BB_HOME` 则尊重调用方给的目录（此时也可以直接对用户真实 daemon 冒烟）。
//!
//! 环境不可用时的约定（任务要求"daemon 不可用则 skip 并如实说明"）：
//! - 找不到 node 可执行文件、或 CLI/直连兜底都没能在限定时间内拉起 daemon → 打印
//!   `SKIP daemon smoke：…`（含 CLI stdout/stderr 与 daemon 崩溃 stderr）并返回；测试记为
//!   通过，但证据里会明确写 skip，不伪装成真实通过；
//! - `BB_SMOKE_AUTOSTART=0` 可禁止自动拉起，只对已运行的 daemon 做冒烟。
//!
//! 另有一条**确定性**错误路径测试：`BB_HOME` 指向空临时目录时，`status --json` 必须退出 3
//! 并输出 `E_NO_DAEMON`——不依赖 daemon 是否在跑。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bridge_cli::discovery::DaemonHome;
use bridge_cli::errors::ErrorCode;
use bridge_cli::handshake::Hello;
use bridge_cli::json::Json;
use bridge_cli::rpc_client::{DaemonClient, SERVICE_NAME};
use bridge_cli::status::StatusSnapshot;
use bridge_cli::ws::WsClient;

/// 冒烟用的隔离状态目录（`BB_HOME`）：放在 crate 的 `target/` 下。
///
/// 为什么不用默认的 `%USERPROFILE%\.browser-bridge`：
/// - 某些受限执行环境（本机 CI/沙箱）只允许进程写 workspace，写用户目录会 `EPERM`，
///   Node daemon 的 `daemon.json` 原子写会失败、自动拉起随之失败；
/// - 用固定隔离目录还能让重复 `cargo test` 复用同一 daemon，不反复堆积进程；
/// - 不触碰用户正在运行的真实 daemon（避免端口/token 竞争）。
///
/// 覆盖方式：显式设置 `BB_HOME` 环境变量即使用调用方给的目录。
fn smoke_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        if let Some(existing) = std::env::var_os("BB_HOME") {
            let path = PathBuf::from(existing);
            std::fs::create_dir_all(&path).expect("创建 BB_HOME");
            return path;
        }
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join("bb-smoke-home");
        std::fs::create_dir_all(&path).expect("创建隔离 BB_HOME");
        // 测试进程内设置：后续子进程（node CLI / bridge-rs）继承同一状态目录。
        std::env::set_var("BB_HOME", &path);
        path
    })
}

/// 同一时刻只允许一个测试拉起/探测 daemon（避免并发 spawn 竞争同一 daemon.json）。
fn ensure_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 从 crate 目录回到仓库根（`crates/bridge-cli` → 仓库根）。
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().expect("crates 目录").parent().expect("仓库根").to_path_buf()
}

/// 测试用临时目录（crate 的 `target/` 下，避免系统临时目录权限问题）。
fn temp_home(tag: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
    std::fs::create_dir_all(&base).expect("创建 target/test-tmp");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!("smoke-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("创建临时 home");
    dir
}

/// 找到 node 可执行文件：`BB_NODE` → PATH → 仓库文档约定的便携 Node → 常见安装位置。
fn find_node() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("BB_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            for name in ["node.exe", "node"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    for candidate in [r"D:\tools\node\node.exe", r"C:\Program Files\nodejs\node.exe"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn bridge_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bridge-rs"))
}

/// 运行 bridge-rs 二进制；显式控制 `BB_HOME`，避免测试进程环境泄漏。
fn run_bridge(args: &[&str], home: Option<&Path>) -> Output {
    let mut command = Command::new(bridge_bin());
    command.args(args);
    command.env_remove("BB_HOME");
    if let Some(home) = home {
        command.env("BB_HOME", home);
    } else if let Some(inherited) = std::env::var_os("BB_HOME") {
        // 测试进程若有 BB_HOME，子进程必须用同一个状态目录，否则会找不到刚拉起的 daemon。
        command.env("BB_HOME", inherited);
    }
    command.output().expect("运行 bridge-rs 二进制")
}

/// 用 Node CLI 确保 daemon 就绪（`bridge.mjs status` 自带自动拉起）。
fn ensure_daemon_via_node(node: &Path) -> Result<Output, String> {
    let repo = repo_root();
    let cli = repo.join("cli").join("bridge.mjs");
    if !cli.is_file() {
        return Err(format!("找不到 Node CLI：{}", cli.display()));
    }
    let mut command = Command::new(node);
    command
        .arg(&cli)
        .arg("status")
        .arg("--json")
        .current_dir(&repo)
        .env_remove("BB_AUTO_START");
    // 与 Rust 侧探测使用同一个状态目录：显式 false 的 BB_HOME 才移除，否则原样继承。
    match std::env::var_os("BB_HOME") {
        Some(home) => {
            command.env("BB_HOME", home);
        }
        None => {
            command.env_remove("BB_HOME");
        }
    }
    command.output().map_err(|error| format!("启动 node cli/bridge.mjs 失败：{error}"))
}

fn stdout_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

/// 发现 + 健康探测；失败返回说明（用于 skip 或断言）。
fn probe() -> Result<(DaemonHome, bridge_cli::discovery::DaemonMetadata, bridge_cli::rpc_client::HealthReport), String> {
    let home = DaemonHome::from_env().map_err(|error| format!("发现失败 {}：{}", error.code.as_str(), error.message))?;
    let metadata = home
        .read_metadata()
        .map_err(|error| format!("读取 daemon.json 失败 {}：{}", error.code.as_str(), error.message))?;
    let client = DaemonClient::new(metadata.clone());
    let health = client
        .health()
        .map_err(|error| format!("GET /health 失败 {}：{}", error.code.as_str(), error.message))?;
    Ok((home, metadata, health))
}

/// 确保真实 daemon 可达：已可达直接返回；否则用 Node CLI 拉起；CLI 拉起失败时再直接
/// `node daemon/server.mjs --foreground` 兜底（并带回失败诊断）。
/// 返回 `Err(skip_reason)` 表示环境不可用（调用方 skip 并如实打印）。
fn ensure_real_daemon() -> Result<(bridge_cli::discovery::DaemonMetadata, bridge_cli::rpc_client::HealthReport, &'static str), String>
{
    let _guard = ensure_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    smoke_home();
    if let Ok((_home, metadata, health)) = probe() {
        return Ok((metadata, health, "已运行（隔离 BB_HOME）"));
    }
    if std::env::var("BB_SMOKE_AUTOSTART").ok().as_deref() == Some("0") {
        return Err("daemon 不可达且 BB_SMOKE_AUTOSTART=0（禁止自动拉起）".to_string());
    }
    let node = match find_node() {
        Some(node) => node,
        None => {
            return Err(
                "找不到 node 可执行文件（可设 BB_NODE 指向 node.exe）；无法用 node cli/bridge.mjs status 拉起真实 daemon"
                    .to_string(),
            )
        }
    };

    // 首选任务要求的路径：node CLI（自带 ensureDaemon + 原子写 daemon.json）。
    let cli_failure: String = match ensure_daemon_via_node(&node) {
        Ok(output) if output.status.success() => {
            if let Some(pair) = wait_for_probe(Duration::from_secs(15)) {
                return Ok((pair.0, pair.1, "node cli/bridge.mjs status"));
            }
            "node CLI 报告成功，但 Rust 侧探测仍失败".to_string()
        }
        Ok(output) => format!(
            "node cli/bridge.mjs status 失败（exit {:?}）：stdout={} stderr={}",
            output.status.code(),
            stdout_text(&output).chars().take(400).collect::<String>(),
            stderr_text(&output).chars().take(400).collect::<String>()
        ),
        Err(reason) => reason,
    };

    // 兜底：直接前台拉起 daemon（与 CLI `spawnDaemon` 等价，但保留 stderr 便于诊断）。
    match start_daemon_direct(&node) {
        Ok(()) => match wait_for_probe(Duration::from_secs(20)) {
            Some(pair) => Ok((pair.0, pair.1, "node daemon/server.mjs（直连兜底）")),
            None => Err(format!("直连 daemon 已启动但探测失败；CLI 失败原因：{cli_failure}")),
        },
        Err(reason) => Err(format!("CLI 拉起失败（{cli_failure}）；直连兜底也失败（{reason}）")),
    }
}

fn wait_for_probe(
    timeout: Duration,
) -> Option<(bridge_cli::discovery::DaemonMetadata, bridge_cli::rpc_client::HealthReport)> {
    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    while Instant::now() < deadline {
        match probe() {
            Ok((_home, metadata, health)) => return Some((metadata, health)),
            Err(reason) => last = reason,
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!("探测超时：{last}");
    None
}

/// 选一个空闲回环端口（直连兜底用）。
fn free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|addr| addr.port())
}

/// 直连拉起 `daemon/server.mjs --foreground --port <free>`，等待 `/health` 就绪。
fn start_daemon_direct(node: &Path) -> Result<(), String> {
    let server = repo_root().join("daemon").join("server.mjs");
    if !server.is_file() {
        return Err(format!("找不到 daemon server：{}", server.display()));
    }
    let port = free_port().ok_or_else(|| "找不到空闲端口".to_string())?;
    let mut command = Command::new(node);
    command
        .arg(&server)
        .arg("--foreground")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(repo_root())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .env_remove("BB_AUTO_START");
    match std::env::var_os("BB_HOME") {
        Some(home) => {
            command.env("BB_HOME", home);
        }
        None => {
            command.env_remove("BB_HOME");
        }
    }
    let mut child = command.spawn().map_err(|error| format!("spawn daemon 失败：{error}"))?;
    // 给 daemon 最多 20s 写 daemon.json 并监听；期间轮询 /health。
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if probe().is_ok() {
            // 不等待/不 kill：daemon 常驻，与 Node CLI 自动拉起的行为一致。
            std::mem::forget(child);
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read as _;
                let _ = pipe.read_to_string(&mut stderr);
            }
            return Err(format!(
                "daemon 启动即退出（exit {:?}）：stderr={}",
                status.code(),
                stderr.chars().take(800).collect::<String>()
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("daemon 20s 内未就绪".to_string())
}

fn skip(reason: &str) {
    eprintln!("SKIP daemon smoke：{reason}");
}

/// 隔离 home 的固定路径（用于判断冒烟 daemon 是否由本测试拥有，可否安全停止）。
fn isolated_home_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp").join("bb-smoke-home")
}

/// 停止冒烟 daemon：优先 RPC `daemon.stop`（daemon 会清理 daemon.json 并优雅退出），
/// 只有本测试拥有（自动拉起或隔离 home）的 daemon 才会被停止，绝不碰用户正在运行的真实 daemon。
fn stop_smoke_daemon(client: &DaemonClient, metadata: &bridge_cli::discovery::DaemonMetadata, via: &str) {
    let owned = !via.starts_with("已运行") || metadata.home == isolated_home_path();
    if !owned {
        eprintln!("冒烟 daemon 由外部启动，保持运行（不停止）");
        return;
    }
    // daemon.stop 可能在回包前断开连接：两种都接受。
    let _ = client.call("daemon.stop", Json::Object(Vec::new()), 3_000);
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if client.health().is_err() {
            eprintln!("冒烟 daemon 已停止（pid={:?} port={}）", metadata.pid, metadata.port);
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    eprintln!("警告：冒烟 daemon 未在 8s 内停止（pid={:?} port={}）", metadata.pid, metadata.port);
}

// ---------------------------------------------------------------------------
// 协议级扩展桩（session/observe 冒烟用）
// ---------------------------------------------------------------------------
//
// 现实约束：无头环境没有真实 Edge/Chrome + 扩展可连到隔离 `BB_HOME` 的 daemon，
// 而 `session.start` 必须有一条扩展 WS 连接才会下发 `window.newAgent`。这里用**协议级桩**
// 充当扩展：真实 WS 握手 / hello / 收 `cmd` 帧 / 回 `res` 帧，形状与 `extension/src` 一致。
//
// 明确边界（不是真实浏览器）：
// - daemon、HTTP `/rpc`、WS 传输、会话状态机、CLI 全部是真实链路；
// - 只有"浏览器执行结果"（tabId/观察正文）来自桩，因此断言只验证协议/命令/生命周期，
//   不宣称观察到了真实页面；报告里也标注"扩展桩"。

/// 扩展桩上伪造的 tabId（与真实浏览器 tab id 无冲突）。
const STUB_TAB_ID: u64 = 4242;
/// 扩展桩上伪造的 windowId。
const STUB_WINDOW_ID: u64 = 11;

#[derive(Debug, Default)]
struct StubSummary {
    /// daemon 下发给桩的命令方法（按到达顺序）。
    commands: Vec<String>,
    /// 桩线程观察到的传输错误（正常应为空）。
    errors: Vec<String>,
}

struct ExtensionStub {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<StubSummary>>,
    instance_id: String,
}

impl ExtensionStub {
    /// 连接 daemon `/ws?role=extension`，完成 hello/hello-ack，然后在后台线程应答 cmd。
    fn start(port: u16) -> Result<Self, String> {
        let mut ws = WsClient::connect(port, Duration::from_millis(800))
            .map_err(|error| format!("WS 连接失败 {}：{}", error.code.as_str(), error.message))?;
        let mut hello = Hello::new(env!("CARGO_PKG_VERSION"), "bridge-stub", "protocol-stub-1");
        hello.protocol = Some("1.9".to_string());
        hello.capabilities = ["observe", "frames", "dialog", "dom-read", "screenshot"]
            .iter()
            .map(|capability| capability.to_string())
            .collect();
        hello.label = "bridge-rs smoke stub".to_string();
        hello.user_agent = "bridge-rs-smoke/1 (protocol stub, no real browser)".to_string();
        let ack = ws.hello_exchange(&hello).map_err(|error| {
            format!("hello/hello-ack 失败 {}：{}", error.code.as_str(), error.message)
        })?;
        let instance_id = ack.instance_id.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let handle = std::thread::spawn(move || stub_loop(&mut ws, flag));
        Ok(Self { stop, handle: Some(handle), instance_id })
    }

    /// 停止桩线程并取回它观察到的命令序列（用于断言 daemon 真的下发了 cmd）。
    fn finish(mut self) -> StubSummary {
        self.stop.store(true, Ordering::Relaxed);
        match self.handle.take() {
            Some(handle) => handle.join().unwrap_or_else(|_| StubSummary {
                commands: Vec::new(),
                errors: vec!["扩展桩线程 panic".to_string()],
            }),
            None => StubSummary::default(),
        }
    }
}

impl Drop for ExtensionStub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn stub_loop(ws: &mut WsClient, stop: Arc<AtomicBool>) -> StubSummary {
    let mut summary = StubSummary::default();
    while !stop.load(Ordering::Relaxed) {
        match ws.read_json() {
            Ok(frame) => {
                let kind = frame.get("type").and_then(Json::as_str).unwrap_or("");
                match kind {
                    "ping" => {
                        let _ = ws.send_text("{\"type\":\"pong\"}");
                    }
                    "cmd" => {
                        let method = frame.get("method").and_then(Json::as_str).unwrap_or("").to_string();
                        let id = frame.get("id").and_then(Json::as_str).unwrap_or("").to_string();
                        summary.commands.push(method.clone());
                        let reply = json_res(&id, stub_command_result(&method));
                        if ws.send_json(&reply).is_err() {
                            break;
                        }
                    }
                    // 事件/心跳/迟到回包：桩不需要处理。
                    "event" | "pong" | "res" => {}
                    other => summary.errors.push(format!("未预期的帧类型：{other}")),
                }
            }
            // 读超时用于轮询 stop 标记（WsClient 的读超时 = connect 时给的值）。
            Err(error) if error.code == ErrorCode::DaemonTimeout => continue,
            Err(error) if error.code == ErrorCode::Disconnected => break,
            Err(error) => {
                summary.errors.push(format!("{}：{}", error.code.as_str(), error.message));
                break;
            }
        }
    }
    summary
}

fn json_res(id: &str, result: Json) -> Json {
    Json::object(vec![
        ("type".to_string(), Json::string("res")),
        ("id".to_string(), Json::string(id.to_string())),
        ("ok".to_string(), Json::Bool(true)),
        ("result".to_string(), result),
    ])
}

/// 桩对 daemon 命令的"执行结果"（形状对齐扩展真实回包；内容是桩数据，不是真实页面）。
fn stub_command_result(method: &str) -> Json {
    match method {
        "window.newAgent" | "window.ensureAgent" => Json::object(vec![
            ("tabId".to_string(), Json::Number(STUB_TAB_ID as f64)),
            ("windowId".to_string(), Json::Number(STUB_WINDOW_ID as f64)),
            ("url".to_string(), Json::string("about:blank")),
            ("title".to_string(), Json::string("")),
        ]),
        "tab.borrow" => Json::object(vec![
            ("tabId".to_string(), Json::Number(STUB_TAB_ID as f64)),
            ("windowId".to_string(), Json::Number(STUB_WINDOW_ID as f64)),
            ("url".to_string(), Json::string("about:blank")),
            ("title".to_string(), Json::string("")),
        ]),
        "observe" => Json::object(vec![
            ("url".to_string(), Json::string("about:blank")),
            ("title".to_string(), Json::string("bridge-rs protocol stub")),
            (
                "observation".to_string(),
                Json::string("- @e1 heading \"BridgeDeck smoke\"\n- @e2 link \"More information\""),
            ),
            ("refs".to_string(), Json::Number(2.0)),
            ("observationId".to_string(), Json::string("ob_stub01")),
            (
                "nodes".to_string(),
                Json::array(vec![
                    Json::object(vec![("ref".to_string(), Json::string("@e1"))]),
                    Json::object(vec![("ref".to_string(), Json::string("@e2"))]),
                ]),
            ),
            ("pipeline".to_string(), Json::string("page-lib")),
        ]),
        // dialog.arm / control-hint / tab.close / window.close / debugger.detach / dialog.disarm…
        _ => Json::Object(Vec::new()),
    }
}

/// 等到桩实例真的注册在 daemon 上（`browsers` 里出现该 instanceId）。
fn wait_for_stub_instance(client: &DaemonClient, instance_id: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(result) = client.call("browsers", Json::Object(Vec::new()), 3_000) {
            if let Some(items) = result.get("browsers").and_then(Json::as_array) {
                if items
                    .iter()
                    .any(|item| item.get("instanceId").and_then(Json::as_str) == Some(instance_id))
                {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// 运行真实二进制并断言 exit 0 + 输出是合法 JSON。
fn run_bridge_json(args: &[&str], label: &str) -> Json {
    let output = run_bridge(args, None);
    assert!(
        output.status.success(),
        "{label} 应 exit 0，实际 {:?}，stderr={}",
        output.status.code(),
        stderr_text(&output)
    );
    let stdout = stdout_text(&output);
    Json::parse(&stdout).unwrap_or_else(|error| panic!("{label} 输出非法 JSON：{error}\n{stdout}"))
}


/// 一条端到端冒烟测试：
/// 真实 daemon（必要时由 `node cli/bridge.mjs status` 拉起）→ `/health` → `/rpc status` →
/// WS hello/hello-ack → 真实二进制 `status/health/ws-hello --json` → 结束后停止本测试拉起的 daemon。
///
/// 合并成一个测试的原因：daemon 是**进程级共享状态**，拆成多个测试会让生命周期与清理互相竞争
/// （cargo 默认并行）；单个测试内顺序执行可以保证"拉起 → 全部断言 → 停止"的闭合，不遗留进程。
#[test]
fn smoke_real_daemon_end_to_end() {
    let (metadata, health, via) = match ensure_real_daemon() {
        Ok(pair) => pair,
        Err(reason) => {
            skip(&reason);
            return;
        }
    };
    eprintln!(
        "真实 daemon 就绪（来源：{via}）：endpoint={} discovery={} version={} protocol={}",
        metadata.endpoint_label(),
        metadata.path.display(),
        health.version,
        health.protocol
    );
    let client = DaemonClient::new(metadata.clone());

    // ---- 1) GET /health ----
    assert_eq!(health.service, SERVICE_NAME);
    assert_eq!(health.protocol, "1.9", "daemon 协议应为 1.9");
    assert_eq!(health.port, Some(metadata.port), "/health 上报端口应等于 daemon.json 端口");
    assert!(health.uptime_ms.unwrap_or(0) > 0, "uptimeMs 应有值");

    // ---- 2) POST /rpc status ----
    let result = client.status(5_000).expect("POST /rpc status 应成功");
    let snapshot = StatusSnapshot::from_result(&result).expect("status 结果应可归一");
    assert_eq!(snapshot.service, SERVICE_NAME);
    assert_eq!(snapshot.port, Some(metadata.port));
    assert_eq!(snapshot.protocol, "1.9");
    assert_eq!(snapshot.pid, health.pid, "status 与 health 的 pid 应一致");
    // 浏览器/会话可以为 0，但字段必须是数组且已解析（形状校验）。
    assert_eq!(snapshot.raw.get("browsers").and_then(Json::as_array).map(<[Json]>::len), Some(snapshot.browsers.len()));
    assert_eq!(snapshot.raw.get("sessions").and_then(Json::as_array).map(<[Json]>::len), Some(snapshot.sessions.len()));
    assert!(snapshot.compatibility.is_some(), "status 应带 compatibility 段");
    eprintln!(
        "status 摘要：browsers={} sessions={} inflight={} compatibility={}",
        snapshot.browsers.len(),
        snapshot.sessions.len(),
        snapshot.inflight.len(),
        if snapshot.compatibility.is_some() { "present" } else { "absent" }
    );

    // ---- 3) WebSocket 真实握手 + hello/hello-ack ----
    let mut ws = WsClient::connect(metadata.port, Duration::from_millis(5_000)).expect("WebSocket 升级应成功");
    assert_eq!(ws.handshake.status, 101);
    assert_eq!(ws.handshake.accept, ws.handshake.expected_accept, "Sec-WebSocket-Accept 必须校验通过");
    let hello = bridge_cli::status::build_client_hello();
    let ack = ws.hello_exchange(&hello).expect("hello/hello-ack 应成功");
    assert_eq!(ack.instance_id.len(), 8, "hello-ack instanceId 应为 8 位 hex：{}", ack.instance_id);
    assert!(ack.instance_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(ack.protocol, "1.9");
    assert!(!ack.daemon_version.is_empty());
    assert!(!ack.capabilities.is_empty(), "daemon 应下发 capabilities");
    assert!(matches!(ack.local_auth.state.as_str(), "verified" | "unpaired"));
    eprintln!(
        "ws hello-ack：instanceId={} daemonVersion={} protocol={} capabilities={} localAuth={}",
        ack.instance_id,
        ack.daemon_version,
        ack.protocol,
        ack.capabilities.len(),
        ack.local_auth.state
    );
    ws.close(1000, "bridge-rs daemon smoke").expect("发送 close");
    ws.shutdown();

    // ---- 4) 真实二进制 status --json ----
    let output = run_bridge(&["status", "--json"], None);
    assert!(
        output.status.success(),
        "bridge-rs status --json 应 exit 0，实际 {:?}，stderr={}",
        output.status.code(),
        stderr_text(&output)
    );
    let stdout = stdout_text(&output);
    let json = Json::parse(&stdout).unwrap_or_else(|error| panic!("status --json 输出非法 JSON：{error}\n{stdout}"));
    assert_eq!(json.get("ok").and_then(Json::as_bool), Some(true));
    assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(0));
    let status = json.get("status").expect("status 段");
    assert_eq!(status.get("service").and_then(Json::as_str), Some(SERVICE_NAME));
    assert_eq!(status.get("protocol").and_then(Json::as_str), Some("1.9"));
    assert_eq!(status.get("port").and_then(Json::as_u64), Some(u64::from(metadata.port)));
    let daemon = status.get("daemon").expect("daemon 段");
    assert_eq!(daemon.get("reachable").and_then(Json::as_bool), Some(true));
    assert_eq!(
        daemon.get("endpoint").and_then(Json::as_str),
        Some(format!("127.0.0.1:{}", metadata.port).as_str()),
        "endpoint 应与 daemon.json 端口一致"
    );
    assert_eq!(daemon.get("tokenPresent").and_then(Json::as_bool), Some(true));
    assert!(!stdout.contains(&metadata.token), "status --json 绝不能输出 daemon token");
    assert!(status.get("browsers").and_then(|browsers| browsers.get("count")).and_then(Json::as_u64).is_some());
    assert!(status.get("sessions").and_then(|sessions| sessions.get("count")).and_then(Json::as_u64).is_some());
    eprintln!("binary status --json（节选）：{}", &stdout[..stdout.len().min(600)]);

    // ---- 5) 真实二进制 health --json 与 ws-hello --json ----
    let health_output = run_bridge(&["health", "--json"], None);
    assert!(health_output.status.success(), "health --json 应 exit 0：{}", stderr_text(&health_output));
    let health_json = Json::parse(&stdout_text(&health_output)).expect("health --json 是合法 JSON");
    assert_eq!(health_json.get("ok").and_then(Json::as_bool), Some(true));
    assert_eq!(
        health_json.get("health").and_then(|health| health.get("service")).and_then(Json::as_str),
        Some(SERVICE_NAME)
    );

    let ws_output = run_bridge(&["ws-hello", "--json"], None);
    assert!(ws_output.status.success(), "ws-hello --json 应 exit 0：{}", stderr_text(&ws_output));
    let ws_json = Json::parse(&stdout_text(&ws_output)).expect("ws-hello --json 是合法 JSON");
    assert_eq!(ws_json.get("ok").and_then(Json::as_bool), Some(true));
    let ws_payload = ws_json.get("ws").expect("ws 段");
    assert_eq!(ws_payload.get("status").and_then(Json::as_u64), Some(101));
    assert_eq!(ws_payload.get("acceptVerified").and_then(Json::as_bool), Some(true));
    assert_eq!(ws_payload.get("protocol").and_then(Json::as_str), Some("1.9"));
    let instance = ws_payload.get("instanceId").and_then(Json::as_str).expect("instanceId");
    assert_eq!(instance.len(), 8, "instanceId 应为 8 位 hex：{instance}");
    eprintln!("binary health/ws-hello --json 冒烟通过（实例 {instance}）");

    // ---- 6) 会话生命周期 + 只读 observe（真实 daemon + 协议级扩展桩）----
    let stub = match ExtensionStub::start(metadata.port) {
        Ok(stub) => stub,
        Err(reason) => {
            skip(&format!("扩展桩无法连接 daemon（session/observe 冒烟跳过）：{reason}"));
            stop_smoke_daemon(&client, &metadata, via);
            return;
        }
    };
    if !wait_for_stub_instance(&client, &stub.instance_id) {
        skip("扩展桩的 hello 已回但 daemon 的 browsers 里没有该实例；session 冒烟跳过");
        stop_smoke_daemon(&client, &metadata, via);
        return;
    }
    eprintln!("协议级扩展桩已注册（instance={}，label=bridge-rs smoke stub，非真实浏览器）", stub.instance_id);

    // 6a) 初始 list 必须为空（隔离 home 的 daemon）。
    let list = run_bridge_json(&["session", "list", "--json"], "session list（初始）");
    assert_eq!(list.get("ok").and_then(Json::as_bool), Some(true));
    assert_eq!(list.get("exitCode").and_then(Json::as_u64), Some(0));
    assert_eq!(
        list.get("sessions").and_then(|sessions| sessions.get("count")).and_then(Json::as_u64),
        Some(0),
        "隔离 home 的 daemon 初始不应有会话：{list:?}"
    );

    // 6b) session start：daemon 真实创建会话（下发给桩 window.newAgent）。
    let start = run_bridge_json(&["session", "start", "--json"], "session start");
    eprintln!("[evidence] session start --json（exit 0）：{}", start.to_compact_string());
    let started = start.get("session").expect("session 段");
    let session_id = started
        .get("sessionId")
        .and_then(Json::as_str)
        .expect("sessionId")
        .to_string();
    assert_eq!(session_id.len(), 4, "daemon 的 sessionId 是 4 位小写字母：{session_id}");
    assert!(session_id.bytes().all(|byte| byte.is_ascii_lowercase()), "sessionId={session_id}");
    assert_eq!(
        started.get("instanceId").and_then(Json::as_str),
        Some(stub.instance_id.as_str()),
        "会话必须挂在桩实例上"
    );
    assert_eq!(started.get("tabId").and_then(Json::as_u64), Some(STUB_TAB_ID));
    assert_eq!(started.get("shared").and_then(Json::as_bool), Some(false));
    assert_eq!(
        start.get("daemon").and_then(|daemon| daemon.get("tokenPresent")).and_then(Json::as_bool),
        Some(true)
    );
    assert_eq!(start.get("exitCode").and_then(Json::as_u64), Some(0));
    eprintln!("session start：sessionId={session_id} tab={STUB_TAB_ID} instance={}", stub.instance_id);

    // 6c) list 必须包含刚创建的会话，且 phase/connected 是 daemon 的实时值。
    let list = run_bridge_json(&["session", "list", "--json"], "session list（start 后）");
    eprintln!("[evidence] session list --json（exit 0）：{}", list.to_compact_string());
    assert_eq!(
        list.get("sessions").and_then(|sessions| sessions.get("count")).and_then(Json::as_u64),
        Some(1),
        "start 后应有 1 个会话：{list:?}"
    );
    let items = list
        .get("sessions")
        .and_then(|sessions| sessions.get("items"))
        .and_then(Json::as_array)
        .expect("items");
    assert_eq!(items[0].get("sessionId").and_then(Json::as_str), Some(session_id.as_str()));
    assert_eq!(items[0].get("tabId").and_then(Json::as_u64), Some(STUB_TAB_ID));
    assert_eq!(items[0].get("connected").and_then(Json::as_bool), Some(true));

    // 6d) observe 只读：真实二进制 → daemon → 桩扩展 → 归一渲染。
    let observe = run_bridge_json(
        &["observe", "--session", &session_id, "--json", "--max-tokens", "2000"],
        "observe",
    );
    assert_eq!(observe.get("ok").and_then(Json::as_bool), Some(true));
    let observation = observe.get("observe").expect("observe 段");
    assert_eq!(observation.get("method").and_then(Json::as_str), Some("observe"));
    assert_eq!(observation.get("readOnly").and_then(Json::as_bool), Some(true));
    assert_eq!(observation.get("refs").and_then(Json::as_u64), Some(2));
    let observation_text = observation.get("observation").and_then(Json::as_str).unwrap_or("");
    assert!(observation_text.contains("@e1 heading"), "observation={observation_text}");
    assert_eq!(observe.get("exitCode").and_then(Json::as_u64), Some(0));
    eprintln!("[evidence] observe --json（exit 0）：{}", observe.to_compact_string());
    let observe_text_output = run_bridge(&["observe", "--session", &session_id], None);
    assert!(
        observe_text_output.status.success(),
        "observe 文本模式应 exit 0：{}",
        stderr_text(&observe_text_output)
    );
    assert!(stdout_text(&observe_text_output).contains("@e1 heading"));
    eprintln!("observe --json/文本：method=observe readOnly=true refs=2（结果来自协议桩）");

    // 6e) session stop：daemon 真实删除会话（下发给桩 tab.close）。
    let stop = run_bridge_json(&["session", "stop", &session_id, "--json"], "session stop");
    eprintln!("[evidence] session stop --json（exit 0）：{}", stop.to_compact_string());
    let stopped = stop.get("stopped").expect("stopped 段");
    assert_eq!(stopped.get("sessionId").and_then(Json::as_str), Some(session_id.as_str()));
    assert_eq!(stopped.get("borrowed").and_then(Json::as_bool), Some(false));
    assert_eq!(stopped.get("handedOff"), Some(&Json::Null));
    assert_eq!(stop.get("exitCode").and_then(Json::as_u64), Some(0));

    // 6f) 停止后 list 必须为空。
    let list = run_bridge_json(&["session", "list", "--json"], "session list（stop 后）");
    assert_eq!(
        list.get("sessions").and_then(|sessions| sessions.get("count")).and_then(Json::as_u64),
        Some(0),
        "stop 后不应再有会话：{list:?}"
    );

    // 6g) 桩观察到的 daemon 命令序列：start→newAgent、observe→observe、stop→tab.close。
    let summary = stub.finish();
    eprintln!("扩展桩收到的 daemon 命令：{:?}", summary.commands);
    assert!(
        summary.commands.iter().any(|method| method == "window.newAgent"),
        "session.start 应下发 window.newAgent：{:?}",
        summary.commands
    );
    assert!(
        summary.commands.iter().any(|method| method == "observe"),
        "observe 应下发 observe：{:?}",
        summary.commands
    );
    assert!(
        summary.commands.iter().any(|method| method == "tab.close"),
        "session.stop 应下发 tab.close：{:?}",
        summary.commands
    );
    assert!(summary.errors.is_empty(), "扩展桩不应有传输错误：{:?}", summary.errors);

    // ---- 7) 清理：只停止本测试拥有/拉起的 daemon ----
    stop_smoke_daemon(&client, &metadata, via);
}

#[test]
fn binary_status_unreachable_is_structured_exit_3() {
    // 确定性错误路径：BB_HOME 指向空目录 → 没有 daemon.json → E_NO_DAEMON + exit 3。
    let home = temp_home("no-daemon");
    let output = run_bridge(&["status", "--json"], Some(&home));
    assert_eq!(output.status.code(), Some(3), "不可达时必须 exit 3，stderr={}", stderr_text(&output));
    // JSON 模式的错误体走 stdout（结构化，便于脚本消费），stderr 保持干净。
    let text = stdout_text(&output);
    let json: Json = Json::parse(&text).unwrap_or_else(|error| panic!("错误输出应为 JSON：{error}\n{text}"));
    assert_eq!(json.get("ok").and_then(Json::as_bool), Some(false));
    assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(3));
    let error = json.get("error").expect("error 段");
    assert_eq!(error.get("code").and_then(Json::as_str), Some("E_NO_DAEMON"));
    let message = error.get("message").and_then(Json::as_str).unwrap_or("");
    assert!(message.contains("daemon.json"), "错误消息应指出发现文件：{message}");
    assert!(message.contains("daemon 未运行"), "错误消息应给出下一步：{message}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn binary_status_text_mode_prints_actionable_error_to_stderr() {
    let home = temp_home("no-daemon-text");
    let output = run_bridge(&["status"], Some(&home));
    assert_eq!(output.status.code(), Some(3));
    assert!(stdout_text(&output).is_empty(), "文本模式错误不应占用 stdout");
    let stderr = stderr_text(&output);
    assert!(stderr.contains("E_NO_DAEMON"), "stderr={stderr}");
    assert!(stderr.contains("daemon.json"), "stderr={stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn binary_session_and_observe_without_daemon_are_structured_exit_3() {
    // 确定性错误路径：daemon 不可用时，会话/观察命令必须给出 E_NO_DAEMON + exit 3，
    // 而不是 panic / 假成功（不依赖 daemon 是否在跑）。
    let home = temp_home("no-daemon-session");
    for argv in [
        &["session", "list", "--json"][..],
        &["session", "start", "--json"][..],
        &["session", "stop", "abcd", "--json"][..],
        &["observe", "--json"][..],
    ] {
        let output = run_bridge(argv, Some(&home));
        assert_eq!(
            output.status.code(),
            Some(3),
            "{argv:?} 不可达时应 exit 3，stderr={}",
            stderr_text(&output)
        );
        let json = Json::parse(&stdout_text(&output))
            .unwrap_or_else(|error| panic!("{argv:?} 错误输出应为 JSON：{error}"));
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(false));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(3));
        assert_eq!(
            json.get("error").and_then(|error| error.get("code")).and_then(Json::as_str),
            Some("E_NO_DAEMON"),
            "{argv:?}"
        );
    }
    // 文本模式的会话错误走 stderr。
    let output = run_bridge(&["session", "list"], Some(&home));
    assert_eq!(output.status.code(), Some(3));
    assert!(stdout_text(&output).is_empty());
    assert!(stderr_text(&output).contains("E_NO_DAEMON"), "stderr={}", stderr_text(&output));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn binary_tls_daemon_is_refused_with_actionable_replacements() {
    // 确定性 TLS 策略：daemon.json tls:true → E_UNSUPPORTED_CAPABILITY + 可执行替代。
    // 端口 1 上没有服务：如果守卫不在请求前生效，错误会是 E_NO_DAEMON，因此这条断言同时证明了
    // "没有发起网络请求、没有假装支持 TLS"。
    let home = temp_home("tls-refuse");
    std::fs::write(
        home.join("daemon.json"),
        r#"{"pid":1,"port":1,"token":"tls-token-should-never-leak","version":"0.3.0","tls":true}"#,
    )
    .expect("写 daemon.json");

    for argv in [
        &["session", "list", "--json"][..],
        &["observe", "--json"][..],
        &["status", "--json"][..],
    ] {
        let output = run_bridge(argv, Some(&home));
        assert_eq!(output.status.code(), Some(3), "{argv:?} 的退出码，stderr={}", stderr_text(&output));
        let stdout = stdout_text(&output);
        let json = Json::parse(&stdout).unwrap_or_else(|error| panic!("{argv:?} 应为 JSON：{error}"));
        let error = json.get("error").expect("error 段");
        assert_eq!(
            error.get("code").and_then(Json::as_str),
            Some("E_UNSUPPORTED_CAPABILITY"),
            "{argv:?}"
        );
        let data = error.get("data").expect("TLS 拒绝必须带 data");
        assert_eq!(data.get("tls").and_then(Json::as_bool), Some(true));
        assert_eq!(data.get("endpoint").and_then(Json::as_str), Some("127.0.0.1:1"));
        let capabilities = data.get("capabilities").expect("capabilities");
        assert_eq!(capabilities.get("tlsClient").and_then(Json::as_bool), Some(false));
        assert_eq!(capabilities.get("plaintextFallback").and_then(Json::as_str), Some("refused"));
        let replacements = data.get("replacements").and_then(Json::as_array).expect("replacements");
        assert!(!replacements.is_empty(), "必须给出可执行替代");
        assert!(
            replacements.iter().any(|item| item
                .get("command")
                .and_then(Json::as_str)
                .unwrap_or("")
                .starts_with("node cli/bridge.mjs")),
            "替代方案必须包含 Node CLI：{replacements:?}"
        );
        assert!(!stdout.contains("tls-token-should-never-leak"), "绝不能输出 token");
    }

    // 文本模式：stderr 给出同一个错误码与替代提示。
    let output = run_bridge(&["session", "start"], Some(&home));
    assert_eq!(output.status.code(), Some(3));
    let stderr = stderr_text(&output);
    assert!(stderr.contains("E_UNSUPPORTED_CAPABILITY"), "stderr={stderr}");
    assert!(stderr.contains("node cli/bridge.mjs"), "stderr={stderr}");
    assert!(stderr.contains("TLS"), "stderr={stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn binary_session_and_observe_usage_errors_exit_2() {
    // 参数错误在触达 daemon 之前就结束（甚至不需要 daemon.json）。
    let home = temp_home("usage-errors");
    let cases: [(&[&str], &str); 6] = [
        (&["session", "start", "--share"], "E_ARG_REQUIRES"),
        (&["session", "start", "--tab", "0"], "E_ARG_RANGE"),
        (&["session", "start", "--control", "shared"], "E_ARG_ENUM"),
        (&["session", "stop"], "E_ARG_MISSING"),
        (&["session", "bogus"], "E_BAD_SUBCOMMAND"),
        (&["observe", "--max-tokens", "20001"], "E_ARG_RANGE"),
    ];
    for (argv, code) in cases {
        let output = run_bridge(argv, Some(&home));
        assert_eq!(output.status.code(), Some(2), "{argv:?} 应 exit 2，stderr={}", stderr_text(&output));
        let stderr = stderr_text(&output);
        assert!(stderr.contains(code), "{argv:?} 应报 {code}：{stderr}");
    }
    let _ = std::fs::remove_dir_all(&home);
}
