//! BridgeDeck CLI（Rust 架构路线，M-D 第三批：接真实 daemon）。
//!
//! 二进制只做三件事：解析参数、调用库层、把 `CommandOutput` 原样写到 stdout/stderr 并返回退出码。
//! 传输/协议/渲染逻辑都在 `bridge_cli` 库里，便于集成测试直接驱动（`tests/daemon_smoke.rs`）。
//!
//! 退出码：0 成功；2 参数/命令错误；3 daemon 不可达或调用失败。

use std::io::Write;
use std::process::ExitCode;

use bridge_cli::cli::{self, Command};
use bridge_cli::status::{self, CommandOutput};
use bridge_cli::{observe_cmd, protocol, session_cmd};

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let command = match cli::parse(&argv) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("错误 {}：{}", error.code.as_str(), error.message);
            return ExitCode::from(status::EXIT_CODE_USAGE);
        }
    };
    emit(run(command))
}

fn run(command: Command) -> CommandOutput {
    match command {
        Command::Help => CommandOutput::success(cli::HELP.to_string()),
        Command::Version => CommandOutput::success(format!(
            "bridge-rs {} (product {} / protocol {})",
            env!("CARGO_PKG_VERSION"),
            protocol::PRODUCT_VERSION,
            protocol::PROTOCOL_CURRENT
        )),
        Command::Protocol { view, json } => {
            let output = match (view, json) {
                (cli::ProtocolView::Summary, true) => protocol::summary_json().to_compact_string(),
                (cli::ProtocolView::Summary, false) => protocol::summary_text(),
                (cli::ProtocolView::Codes, true) => protocol::codes_json().to_compact_string(),
                (cli::ProtocolView::Codes, false) => protocol::codes_text(),
                (cli::ProtocolView::Features, true) => protocol::features_json().to_compact_string(),
                (cli::ProtocolView::Features, false) => protocol::features_text(),
                (cli::ProtocolView::Handshake, true) => protocol::handshake_json().to_compact_string(),
                (cli::ProtocolView::Handshake, false) => protocol::handshake_text(),
            };
            CommandOutput::success(output)
        }
        Command::Status { json, timeout_ms } => status::status_command(json, timeout_ms),
        Command::Health { json, timeout_ms } => status::health_command(json, timeout_ms),
        Command::WsHello { json, timeout_ms } => status::ws_hello_command(json, timeout_ms),
        Command::Session(command) => session_cmd::execute(&command),
        Command::Observe(options) => observe_cmd::execute(&options),
    }
}

/// 统一输出：stdout 成功体、stderr 错误体，各自 flush 后返回退出码。
fn emit(output: CommandOutput) -> ExitCode {
    if !output.stdout.is_empty() {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(output.stdout.as_bytes());
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
    if !output.stderr.is_empty() {
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(output.stderr.as_bytes());
        let _ = stderr.write_all(b"\n");
        let _ = stderr.flush();
    }
    ExitCode::from(output.exit_code)
}
