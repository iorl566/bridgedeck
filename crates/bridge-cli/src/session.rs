//! 会话生命周期状态机（8 状态），行为对齐 `lib/session-state.mjs`（只读参考）。
//!
//! ```text
//!   idle → preparing → starting → ready ⇄ paused
//!                          │           │
//!                          └──────→ stopping → stopped
//!                          └──────→ failed
//! ```
//!
//! 与 JS 侧一致的语义：
//! - 每次迁移记录 `from/to/at/reason/forced` 证据；同状态重复迁移幂等（不写历史）；
//! - 非法迁移抛 `E_SESSION_TRANSITION`，错误 data 带 `allowed`（当前状态允许的目标）与最近历史，
//!   供 CLI/日志解释“为什么被拒绝”；
//! - 未知目标标签抛 `E_SESSION_STATE`；`begin` 在 starting/ready 上抛 `E_SESSION_BUSY`；
//! - `ready`/`preparing` 对外 phase 仍用 0.3.0 旧标签 `active`/`recovering`；
//! - `finish` 是清理入口：即使迁移表不允许也会退休为 `stopped`，但留下 `forced` 违规证据。
//!
//! 时钟可注入（`fn() -> u64`），保证单测可复现；默认使用 `SystemTime`。

use std::fmt;

use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;

/// 规范化会话状态（与 JS `SESSION_STATES` 同序）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SessionState {
    Idle,
    Preparing,
    Starting,
    Ready,
    Paused,
    Stopping,
    Stopped,
    Failed,
}

impl SessionState {
    /// 全部状态，声明顺序（与 JS `SESSION_STATES` 一致）。
    pub const ALL: [SessionState; 8] = [
        SessionState::Idle,
        SessionState::Preparing,
        SessionState::Starting,
        SessionState::Ready,
        SessionState::Paused,
        SessionState::Stopping,
        SessionState::Stopped,
        SessionState::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Idle => "idle",
            SessionState::Preparing => "preparing",
            SessionState::Starting => "starting",
            SessionState::Ready => "ready",
            SessionState::Paused => "paused",
            SessionState::Stopping => "stopping",
            SessionState::Stopped => "stopped",
            SessionState::Failed => "failed",
        }
    }

    /// 0.3.0 旧 phase 标签：`ready` → `active`，`preparing` → `recovering`。
    pub fn phase_label(self) -> &'static str {
        match self {
            SessionState::Ready => "active",
            SessionState::Preparing => "recovering",
            other => other.as_str(),
        }
    }

    /// 标签（含旧别名）→ 规范状态；未知返回 `None`。
    pub fn canonical(label: &str) -> Option<SessionState> {
        match label.trim() {
            "" => None,
            "active" => Some(SessionState::Ready),
            "recovering" => Some(SessionState::Preparing),
            other => SessionState::ALL.iter().copied().find(|state| state.as_str() == other),
        }
    }

    /// 迁移表（唯一源；测试逐项对照 JS `SESSION_TRANSITIONS`）。
    pub fn allowed_transitions(self) -> &'static [SessionState] {
        match self {
            SessionState::Idle => &[
                SessionState::Preparing,
                SessionState::Starting,
                SessionState::Ready,
                SessionState::Paused,
                SessionState::Stopping,
                SessionState::Failed,
            ],
            SessionState::Preparing => &[
                SessionState::Starting,
                SessionState::Ready,
                SessionState::Paused,
                SessionState::Failed,
                SessionState::Stopped,
            ],
            SessionState::Starting => &[
                SessionState::Ready,
                SessionState::Preparing,
                SessionState::Stopping,
                SessionState::Failed,
            ],
            SessionState::Ready => &[SessionState::Paused, SessionState::Stopping, SessionState::Failed],
            SessionState::Paused => &[SessionState::Ready, SessionState::Stopping, SessionState::Failed],
            SessionState::Stopping => &[SessionState::Stopped, SessionState::Starting, SessionState::Failed],
            SessionState::Stopped => &[SessionState::Preparing, SessionState::Starting, SessionState::Failed],
            SessionState::Failed => &[SessionState::Preparing, SessionState::Starting, SessionState::Stopped],
        }
    }

    /// 迁移是否合法；同状态迁移按幂等处理（与 JS `isLegalTransition` 一致）。
    pub fn can_transition_to(self, target: SessionState) -> bool {
        self == target || self.allowed_transitions().contains(&target)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, SessionState::Stopped | SessionState::Failed)
    }

    pub fn to_json(self) -> Json {
        crate::json_obj! {
            "state" => Json::string(self.as_str()),
            "phase" => Json::string(self.phase_label()),
            "allowed" => Json::Array(self.allowed_transitions().iter().map(|state| Json::string(state.as_str())).collect()),
            "terminal" => Json::Bool(self.is_terminal()),
        }
    }
}

impl fmt::Display for SessionState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 一次成功迁移的证据。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionTransition {
    pub seq: u64,
    pub at_ms: u64,
    pub from: SessionState,
    pub to: SessionState,
    pub reason: String,
    pub forced: bool,
    pub evidence: Option<Json>,
}

impl SessionTransition {
    pub fn to_json(&self) -> Json {
        let mut entries = vec![
            ("seq".to_string(), Json::Number(self.seq as f64)),
            ("at".to_string(), Json::Number(self.at_ms as f64)),
            ("from".to_string(), Json::string(self.from.as_str())),
            ("to".to_string(), Json::string(self.to.as_str())),
            ("reason".to_string(), Json::string(self.reason.clone())),
            ("forced".to_string(), Json::Bool(self.forced)),
        ];
        if let Some(evidence) = &self.evidence {
            entries.push(("evidence".to_string(), evidence.clone()));
        }
        Json::Object(entries)
    }
}

/// 违规证据（非法迁移 / 绕过迁移表的清理）。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionViolation {
    pub from: SessionState,
    pub to: SessionState,
    pub reason: String,
    pub at_ms: u64,
    pub allowed: Vec<SessionState>,
    pub forced: bool,
}

impl SessionViolation {
    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "from" => Json::string(self.from.as_str()),
            "to" => Json::string(self.to.as_str()),
            "reason" => Json::string(self.reason.clone()),
            "at" => Json::Number(self.at_ms as f64),
            "allowed" => Json::Array(self.allowed.iter().map(|state| Json::string(state.as_str())).collect()),
            "forced" => Json::Bool(self.forced),
        }
    }
}

/// 状态机错误类别 → 协议错误码映射（`E_SESSION_TRANSITION` / `E_SESSION_STATE` / `E_SESSION_BUSY`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionErrorKind {
    IllegalTransition,
    UnknownState,
    Busy,
}

impl SessionErrorKind {
    pub fn code(self) -> ErrorCode {
        match self {
            SessionErrorKind::IllegalTransition => ErrorCode::SessionTransition,
            SessionErrorKind::UnknownState => ErrorCode::SessionState,
            SessionErrorKind::Busy => ErrorCode::SessionBusy,
        }
    }
}

/// 结构化状态机错误：既可直接 `Display`，也可转成协议信封的 `RpcError`。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionError {
    pub kind: SessionErrorKind,
    pub session_id: String,
    pub from: SessionState,
    pub to: Option<SessionState>,
    pub target_label: String,
    pub reason: String,
    pub allowed: Vec<SessionState>,
    pub history: Vec<SessionTransition>,
}

impl SessionError {
    fn illegal(session_id: &str, from: SessionState, to: SessionState, reason: &str, history: Vec<SessionTransition>) -> Self {
        Self {
            kind: SessionErrorKind::IllegalTransition,
            session_id: session_id.to_string(),
            from,
            to: Some(to),
            target_label: to.as_str().to_string(),
            reason: reason.to_string(),
            allowed: from.allowed_transitions().to_vec(),
            history,
        }
    }

    fn unknown_state(session_id: &str, from: SessionState, label: &str) -> Self {
        Self {
            kind: SessionErrorKind::UnknownState,
            session_id: session_id.to_string(),
            from,
            to: None,
            target_label: label.to_string(),
            reason: String::new(),
            allowed: from.allowed_transitions().to_vec(),
            history: Vec::new(),
        }
    }

    fn busy(session_id: &str, from: SessionState, history: Vec<SessionTransition>) -> Self {
        Self {
            kind: SessionErrorKind::Busy,
            session_id: session_id.to_string(),
            from,
            to: Some(SessionState::Starting),
            target_label: SessionState::Starting.as_str().to_string(),
            reason: "begin".to_string(),
            allowed: vec![SessionState::Starting, SessionState::Ready],
            history,
        }
    }

    pub fn code(&self) -> ErrorCode {
        self.kind.code()
    }

    /// 错误 data（对齐 JS `SessionTransitionError.data`）。
    pub fn data_json(&self) -> Json {
        let to = match self.to {
            Some(to) => Json::string(to.as_str()),
            None => Json::string(self.target_label.clone()),
        };
        crate::json_obj! {
            "sessionId" => Json::string(self.session_id.clone()),
            "from" => Json::string(self.from.as_str()),
            "to" => to,
            "reason" => Json::string(self.reason.clone()),
            "allowed" => Json::Array(self.allowed.iter().map(|state| Json::string(state.as_str())).collect()),
            "states" => Json::Array(SessionState::ALL.iter().map(|state| Json::string(state.as_str())).collect()),
            "history" => Json::Array(self.history.iter().map(SessionTransition::to_json).collect()),
        }
    }

    /// 转成协议信封错误（`{code, message, data}`），供 CLI `--json` 与 RPC 响应复用。
    pub fn to_rpc_error(&self) -> RpcError {
        RpcError::new(self.code(), self.to_string()).with_data(self.data_json())
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let allowed = self.allowed.iter().map(|state| state.as_str()).collect::<Vec<_>>().join(", ");
        let allowed = if allowed.is_empty() { "(无)".to_string() } else { allowed };
        match self.kind {
            SessionErrorKind::IllegalTransition => write!(
                formatter,
                "会话 {} 的非法生命周期迁移：{} → {}（{}）；当前状态允许：{}",
                self.session_id,
                self.from,
                self.target_label,
                if self.reason.is_empty() { "未说明" } else { &self.reason },
                allowed
            ),
            SessionErrorKind::UnknownState => write!(
                formatter,
                "会话 {} 的未知生命周期状态：{}；允许：{}",
                self.session_id, self.target_label, allowed
            ),
            SessionErrorKind::Busy => write!(
                formatter,
                "会话 {} 已经在 {} 状态，不能重复 begin；先 stop 或继续使用现有会话",
                self.session_id, self.from
            ),
        }
    }
}

impl std::error::Error for SessionError {}

/// 快照（CLI `status --json` / 日志用）。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub state: SessionState,
    pub retired: bool,
    pub since_ms: u64,
    pub entered_at_ms: u64,
    pub reason: String,
    pub transitions: usize,
    pub last_transition: Option<SessionTransition>,
    pub history: Vec<SessionTransition>,
}

impl SessionSnapshot {
    pub fn to_json(&self) -> Json {
        let last = match &self.last_transition {
            Some(transition) => transition.to_json(),
            None => Json::Null,
        };
        crate::json_obj! {
            "sessionId" => Json::string(self.session_id.clone()),
            "state" => Json::string(self.state.as_str()),
            "canonical" => Json::string(self.state.as_str()),
            "phase" => Json::string(self.state.phase_label()),
            "retired" => Json::Bool(self.retired),
            "since" => Json::Number(self.since_ms as f64),
            "enteredAt" => Json::Number(self.entered_at_ms as f64),
            "reason" => Json::string(self.reason.clone()),
            "transitions" => Json::Number(self.transitions as f64),
            "lastTransition" => last,
            "history" => Json::Array(self.history.iter().map(SessionTransition::to_json).collect()),
        }
    }
}

/// `finish` 的结果：正常退休或绕过迁移表（forced）都会给出证据。
#[derive(Debug, Clone, PartialEq)]
pub struct FinishOutcome {
    pub forced: bool,
    pub already_stopped: bool,
    pub snapshot: SessionSnapshot,
}

/// 会话生命周期状态机实例（每个 session 一个）。
#[derive(Debug, Clone)]
pub struct SessionStateMachine {
    session_id: String,
    state: SessionState,
    retired: bool,
    since_ms: u64,
    entered_at_ms: u64,
    reason: String,
    history: Vec<SessionTransition>,
    violations: Vec<SessionViolation>,
    transition_count: u64,
    violation_count: u64,
    seq: u64,
    history_limit: usize,
    violation_limit: usize,
    clock: fn() -> u64,
}

impl SessionStateMachine {
    /// 默认时钟 + 默认历史上限（50）/违规上限（100），与 JS 默认值一致。
    pub fn new(session_id: impl Into<String>) -> Self {
        Self::with_clock(session_id, system_now_ms)
    }

    pub fn with_clock(session_id: impl Into<String>, clock: fn() -> u64) -> Self {
        Self::with_options(session_id, clock, 50, 100)
    }

    pub fn with_options(session_id: impl Into<String>, clock: fn() -> u64, history_limit: usize, violation_limit: usize) -> Self {
        let now = clock();
        Self {
            session_id: session_id.into(),
            state: SessionState::Idle,
            retired: false,
            since_ms: now,
            entered_at_ms: now,
            reason: "new".to_string(),
            history: Vec::new(),
            violations: Vec::new(),
            transition_count: 0,
            violation_count: 0,
            seq: 0,
            history_limit: history_limit.max(1),
            violation_limit: violation_limit.max(1),
            clock,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    /// 0.3.0 兼容 phase 标签。
    pub fn phase(&self) -> &'static str {
        self.state.phase_label()
    }

    pub fn is_retired(&self) -> bool {
        self.retired
    }

    pub fn allowed_transitions(&self) -> &'static [SessionState] {
        self.state.allowed_transitions()
    }

    pub fn history(&self) -> &[SessionTransition] {
        &self.history
    }

    pub fn violations(&self) -> &[SessionViolation] {
        &self.violations
    }

    pub fn transition_count(&self) -> u64 {
        self.transition_count
    }

    pub fn violation_count(&self) -> u64 {
        self.violation_count
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            session_id: self.session_id.clone(),
            state: self.state,
            retired: self.retired,
            since_ms: self.since_ms,
            entered_at_ms: self.entered_at_ms,
            reason: self.reason.clone(),
            transitions: self.history.len(),
            last_transition: self.history.last().cloned(),
            history: self.history.iter().rev().take(5).rev().cloned().collect(),
        }
    }

    pub fn snapshot_json(&self) -> Json {
        self.snapshot().to_json()
    }

    /// 按标签迁移（接受旧别名 `active`/`recovering`）；未知标签 → `E_SESSION_STATE`。
    pub fn enter(&mut self, target_label: &str, reason: impl Into<String>) -> Result<SessionSnapshot, SessionError> {
        let reason = reason.into();
        let Some(target) = SessionState::canonical(target_label) else {
            return Err(SessionError::unknown_state(&self.session_id, self.state, target_label));
        };
        self.enter_state(target, &reason, None)
    }

    pub fn transition_to(&mut self, target: SessionState, reason: impl Into<String>) -> Result<SessionSnapshot, SessionError> {
        let reason = reason.into();
        self.enter_state(target, &reason, None)
    }

    /// 严格迁移但允许带证据（`fail` 用）。
    pub fn transition_with_evidence(
        &mut self,
        target: SessionState,
        reason: impl Into<String>,
        evidence: Json,
    ) -> Result<SessionSnapshot, SessionError> {
        let reason = reason.into();
        self.enter_state(target, &reason, Some(evidence))
    }

    fn enter_state(&mut self, target: SessionState, reason: &str, evidence: Option<Json>) -> Result<SessionSnapshot, SessionError> {
        let from = self.state;
        if from == target {
            // 幂等：刷新 since，不写历史（与 JS enter 同状态分支一致）。
            self.since_ms = (self.clock)();
            return Ok(self.snapshot());
        }
        if !from.can_transition_to(target) {
            self.record_violation(from, target, reason, false);
            let history = self.history.iter().rev().take(8).rev().cloned().collect();
            return Err(SessionError::illegal(&self.session_id, from, target, reason, history));
        }
        Ok(self.push_transition(target, reason, evidence, false))
    }

    /// 强制迁移：绕过迁移表、记录违规与 `forced` 证据（`finish` / 运维用）。
    pub fn force_transition(&mut self, target: SessionState, reason: impl Into<String>) -> Result<SessionSnapshot, SessionError> {
        let reason = reason.into();
        let from = self.state;
        if from == target {
            self.since_ms = (self.clock)();
            return Ok(self.snapshot());
        }
        let legal = from.can_transition_to(target);
        if !legal {
            self.record_violation(from, target, &reason, true);
        }
        Ok(self.push_transition(target, &reason, None, !legal))
    }

    fn push_transition(&mut self, target: SessionState, reason: &str, evidence: Option<Json>, forced: bool) -> SessionSnapshot {
        let at = (self.clock)();
        self.seq += 1;
        self.transition_count += 1;
        let transition = SessionTransition {
            seq: self.seq,
            at_ms: at,
            from: self.state,
            to: target,
            reason: reason.to_string(),
            forced,
            evidence,
        };
        self.history.push(transition);
        let overflow = self.history.len().saturating_sub(self.history_limit);
        if overflow > 0 {
            self.history.drain(0..overflow);
        }
        self.state = target;
        self.since_ms = at;
        self.entered_at_ms = at;
        self.reason = reason.to_string();
        self.snapshot()
    }

    fn record_violation(&mut self, from: SessionState, to: SessionState, reason: &str, forced: bool) {
        self.violation_count += 1;
        self.violations.push(SessionViolation {
            from,
            to,
            reason: reason.to_string(),
            at_ms: (self.clock)(),
            allowed: from.allowed_transitions().to_vec(),
            forced,
        });
        let overflow = self.violations.len().saturating_sub(self.violation_limit);
        if overflow > 0 {
            self.violations.drain(0..overflow);
        }
    }

    // —— 0.3.0 兼容入口 ——

    pub fn prepare(&mut self, reason: impl Into<String>) -> Result<SessionSnapshot, SessionError> {
        self.enter_state(SessionState::Preparing, &reason.into(), None)
    }

    /// `begin`：starting/ready 上重复启动返回 `E_SESSION_BUSY`（与 JS begin 一致）。
    pub fn begin(&mut self) -> Result<SessionSnapshot, SessionError> {
        if matches!(self.state, SessionState::Starting | SessionState::Ready) {
            let history = self.history.iter().rev().take(5).rev().cloned().collect();
            return Err(SessionError::busy(&self.session_id, self.state, history));
        }
        self.enter_state(SessionState::Starting, "begin", None)
    }

    pub fn activate(&mut self) -> Result<SessionSnapshot, SessionError> {
        self.enter_state(SessionState::Ready, "activate", None)
    }

    pub fn pause(&mut self, reason: impl Into<String>) -> Result<SessionSnapshot, SessionError> {
        self.enter_state(SessionState::Paused, &reason.into(), None)
    }

    /// 仅 paused → ready；其它状态返回 `Ok(false)`（与 JS resume 一致）。
    pub fn resume(&mut self, reason: impl Into<String>) -> Result<bool, SessionError> {
        if self.state != SessionState::Paused {
            return Ok(false);
        }
        self.enter_state(SessionState::Ready, &reason.into(), None)?;
        Ok(true)
    }

    /// 已是 stopping 时返回 `Ok(false)`（幂等）；否则迁移并返回 `Ok(true)`。
    pub fn request_stop(&mut self) -> Result<bool, SessionError> {
        if self.state == SessionState::Stopping {
            return Ok(false);
        }
        self.enter_state(SessionState::Stopping, "request-stop", None)?;
        Ok(true)
    }

    /// 进入 failed 并保留错误证据（code/message），失败不是清理，不退休。
    pub fn fail(&mut self, code: ErrorCode, message: impl Into<String>) -> Result<SessionSnapshot, SessionError> {
        let evidence = crate::json_obj! {
            "code" => Json::string(code.as_str()),
            "message" => Json::string(message.into()),
        };
        self.enter_state(SessionState::Failed, "fail", Some(evidence))
    }

    /// 清理入口：退休为 stopped；迁移表不允许时仍执行，但记 `forced` 证据。
    pub fn finish(&mut self, reason: impl Into<String>) -> FinishOutcome {
        let reason = reason.into();
        let from = self.state;
        let already_stopped = from == SessionState::Stopped;
        let legal = from.can_transition_to(SessionState::Stopped);
        let forced = !legal;
        if !already_stopped {
            if !legal {
                self.record_violation(from, SessionState::Stopped, &reason, true);
            }
            self.push_transition(SessionState::Stopped, &reason, None, forced);
        }
        self.retired = true;
        FinishOutcome { forced, already_stopped, snapshot: self.snapshot() }
    }
}

/// 默认时钟：Unix 毫秒（与 JS `Date.now()` 同口径）。
pub fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn clock_from(seed: u64) -> fn() -> u64 {
        // 每个测试用自己的静态时钟，避免并行测试互相污染。
        match seed {
            0 => {
                fn c() -> u64 {
                    static CLOCK: AtomicU64 = AtomicU64::new(1_000);
                    CLOCK.fetch_add(10, Ordering::SeqCst)
                }
                c
            }
            1 => {
                fn c() -> u64 {
                    static CLOCK: AtomicU64 = AtomicU64::new(2_000);
                    CLOCK.fetch_add(10, Ordering::SeqCst)
                }
                c
            }
            _ => {
                fn c() -> u64 {
                    static CLOCK: AtomicU64 = AtomicU64::new(3_000);
                    CLOCK.fetch_add(10, Ordering::SeqCst)
                }
                c
            }
        }
    }

    fn machine() -> SessionStateMachine {
        SessionStateMachine::with_clock("s1", clock_from(0))
    }

    fn state_names(states: &[SessionState]) -> Vec<&'static str> {
        states.iter().map(|state| state.as_str()).collect()
    }

    #[test]
    fn canonical_labels_and_legacy_aliases() {
        assert_eq!(SessionState::canonical("active"), Some(SessionState::Ready));
        assert_eq!(SessionState::canonical("recovering"), Some(SessionState::Preparing));
        assert_eq!(SessionState::canonical(" ready "), Some(SessionState::Ready));
        assert_eq!(SessionState::canonical("nope"), None);
        assert_eq!(SessionState::canonical(""), None);
        assert_eq!(SessionState::Ready.phase_label(), "active");
        assert_eq!(SessionState::Preparing.phase_label(), "recovering");
        assert_eq!(SessionState::Ready.as_str(), "ready");
        assert_eq!(SessionState::ALL.len(), 8);
    }

    #[test]
    fn transition_table_matches_js_single_source() {
        let expected: [(&str, &[&str]); 8] = [
            ("idle", &["preparing", "starting", "ready", "paused", "stopping", "failed"]),
            ("preparing", &["starting", "ready", "paused", "failed", "stopped"]),
            ("starting", &["ready", "preparing", "stopping", "failed"]),
            ("ready", &["paused", "stopping", "failed"]),
            ("paused", &["ready", "stopping", "failed"]),
            ("stopping", &["stopped", "starting", "failed"]),
            ("stopped", &["preparing", "starting", "failed"]),
            ("failed", &["preparing", "starting", "stopped"]),
        ];
        for (state, allowed) in expected {
            let state = SessionState::canonical(state).expect("状态名");
            assert_eq!(state_names(state.allowed_transitions()), allowed, "状态 {state} 的迁移表");
        }
    }

    #[test]
    fn legal_and_illegal_matrix_is_stable() {
        let expected_legal: [&[SessionState]; 8] = [
            SessionState::Idle.allowed_transitions(),
            SessionState::Preparing.allowed_transitions(),
            SessionState::Starting.allowed_transitions(),
            SessionState::Ready.allowed_transitions(),
            SessionState::Paused.allowed_transitions(),
            SessionState::Stopping.allowed_transitions(),
            SessionState::Stopped.allowed_transitions(),
            SessionState::Failed.allowed_transitions(),
        ];
        for (source_index, source) in SessionState::ALL.iter().enumerate() {
            for target in SessionState::ALL {
                let legal = source.can_transition_to(target);
                let expected = *source == target || expected_legal[source_index].contains(&target);
                assert_eq!(legal, expected, "{source} → {target} 的合法性");
            }
        }
        assert!(!SessionState::Ready.can_transition_to(SessionState::Starting));
        assert!(!SessionState::Stopped.can_transition_to(SessionState::Ready));
    }

    #[test]
    fn happy_path_records_history_and_phases() {
        let mut sm = machine();
        assert_eq!(sm.state(), SessionState::Idle);
        sm.prepare("prepare").expect("idle→preparing");
        assert_eq!(sm.phase(), "recovering");
        sm.begin().expect("preparing→starting");
        sm.activate().expect("starting→ready");
        assert_eq!(sm.phase(), "active");
        sm.pause("human-takeover").expect("ready→paused");
        assert!(sm.resume("resume").expect("paused→ready"));
        assert!(sm.request_stop().expect("ready→stopping"));
        let outcome = sm.finish("finish");
        assert!(!outcome.forced);
        assert!(!outcome.already_stopped);
        assert_eq!(sm.state(), SessionState::Stopped);
        assert!(sm.is_retired());
        assert_eq!(sm.transition_count(), 7);
        let reasons: Vec<&str> = sm.history().iter().map(|step| step.reason.as_str()).collect();
        assert_eq!(
            reasons,
            vec!["prepare", "begin", "activate", "human-takeover", "resume", "request-stop", "finish"]
        );
        assert_eq!(sm.history().last().expect("最后一步").to, SessionState::Stopped);
        assert!(sm.violations().is_empty());
        assert_eq!(sm.snapshot().transitions, 7);
    }

    #[test]
    fn same_state_transition_is_idempotent() {
        let mut sm = machine();
        sm.activate().expect("idle→ready 宽松边");
        let first = sm.snapshot();
        let second = sm.activate().expect("重复 activate 幂等");
        assert_eq!(sm.transition_count(), 1);
        assert_eq!(second.history.len(), first.history.len());
        assert!(second.since_ms >= first.since_ms);
    }

    #[test]
    fn illegal_transition_reports_allowed_and_history() {
        let mut sm = machine();
        sm.activate().expect("idle→ready");
        let error = sm.enter("starting", "bad").expect_err("ready→starting 非法");
        assert_eq!(error.code(), ErrorCode::SessionTransition);
        assert_eq!(error.kind, SessionErrorKind::IllegalTransition);
        assert_eq!(error.from, SessionState::Ready);
        assert_eq!(error.to, Some(SessionState::Starting));
        assert_eq!(state_names(&error.allowed), vec!["paused", "stopping", "failed"]);
        assert_eq!(error.history.len(), 1);
        let message = error.to_string();
        assert!(message.contains("非法生命周期迁移"));
        assert!(message.contains("ready → starting"));
        assert!(message.contains("paused, stopping, failed"));
        assert_eq!(sm.violation_count(), 1);
        assert_eq!(sm.violations().len(), 1);
        assert!(!sm.violations()[0].forced);
        assert_eq!(sm.state(), SessionState::Ready, "非法迁移不能改变状态");
        let data = error.data_json();
        assert_eq!(data.get("code"), None, "data 不含 code（在信封顶层）");
        assert_eq!(data.get("from").and_then(Json::as_str), Some("ready"));
        assert_eq!(data.get("states").and_then(Json::as_array).map(<[Json]>::len), Some(8));
        let envelope = error.to_rpc_error();
        assert_eq!(envelope.code, ErrorCode::SessionTransition);
        assert!(envelope.data.is_some());
    }

    #[test]
    fn unknown_target_state_is_session_state_error() {
        let mut sm = machine();
        let error = sm.enter("flying", "typo").expect_err("未知状态");
        assert_eq!(error.code(), ErrorCode::SessionState);
        assert_eq!(error.kind, SessionErrorKind::UnknownState);
        assert_eq!(error.target_label, "flying");
        assert_eq!(error.to, None);
        assert!(error.to_string().contains("未知生命周期状态"));
        assert_eq!(sm.violation_count(), 0, "未知标签不是迁移违规");
    }

    #[test]
    fn begin_is_busy_while_starting_or_ready() {
        let mut sm = machine();
        sm.begin().expect("idle→starting");
        let error = sm.begin().expect_err("starting 重复 begin");
        assert_eq!(error.code(), ErrorCode::SessionBusy);
        assert!(error.to_string().contains("starting"));
        sm.activate().expect("starting→ready");
        assert_eq!(sm.begin().expect_err("ready 重复 begin").code(), ErrorCode::SessionBusy);
    }

    #[test]
    fn resume_and_request_stop_are_idempotent_guards() {
        let mut sm = machine();
        assert!(!sm.resume("noop").expect("非 paused 返回 false"));
        sm.activate().expect("ready");
        assert!(!sm.resume("noop").expect("ready 不能 resume"));
        sm.pause("pause").expect("paused");
        assert!(sm.resume("resume").expect("paused→ready"));
        assert!(sm.request_stop().expect("ready→stopping"));
        assert!(!sm.request_stop().expect("stopping 重复返回 false"));
    }

    #[test]
    fn fail_records_evidence_and_can_recover() {
        let mut sm = machine();
        sm.activate().expect("ready");
        let snapshot = sm.fail(ErrorCode::NavFail, "导航失败").expect("ready→failed");
        assert_eq!(snapshot.state, SessionState::Failed);
        let last = sm.history().last().expect("失败迁移");
        let evidence = last.evidence.as_ref().expect("失败证据");
        assert_eq!(evidence.get("code").and_then(Json::as_str), Some("E_NAV_FAIL"));
        assert_eq!(evidence.get("message").and_then(Json::as_str), Some("导航失败"));
        assert!(!sm.is_retired());
        sm.prepare("retry").expect("failed→preparing");
        assert_eq!(sm.state(), SessionState::Preparing);
    }

    #[test]
    fn finish_forces_from_ready_and_leaves_violation() {
        let mut sm = machine();
        sm.activate().expect("ready");
        let outcome = sm.finish("cleanup");
        assert!(outcome.forced, "ready→stopped 不在迁移表中，必须 forced");
        assert!(!outcome.already_stopped);
        assert_eq!(outcome.snapshot.state, SessionState::Stopped);
        assert!(sm.is_retired());
        assert_eq!(sm.violation_count(), 1);
        assert!(sm.violations()[0].forced);
        assert!(sm.history().last().expect("退休迁移").forced);
        let again = sm.finish("cleanup-again");
        assert!(again.already_stopped);
        assert!(!again.forced);
        assert_eq!(sm.transition_count(), 2, "重复 finish 不写历史");
    }

    #[test]
    fn finish_from_stopping_is_legal() {
        let mut sm = machine();
        sm.activate().expect("ready");
        sm.request_stop().expect("stopping");
        let outcome = sm.finish("stop");
        assert!(!outcome.forced);
        assert!(sm.violations().is_empty());
        assert_eq!(outcome.snapshot.state, SessionState::Stopped);
    }

    #[test]
    fn history_and_violation_limits_keep_tail() {
        let mut sm = SessionStateMachine::with_options("s-limits", clock_from(1), 3, 2);
        sm.prepare("p").expect("preparing");
        sm.begin().expect("starting");
        sm.activate().expect("ready");
        sm.pause("p1").expect("paused");
        sm.resume("r1").expect("ready");
        sm.pause("p2").expect("paused");
        assert_eq!(sm.history().len(), 3);
        assert_eq!(state_names(&[sm.history()[0].to]), vec!["paused"]);
        assert_eq!(state_names(&[sm.history()[1].to]), vec!["ready"]);
        let _ = sm.enter("starting", "bad-1");
        let _ = sm.enter("starting", "bad-2");
        let _ = sm.enter("starting", "bad-3");
        assert_eq!(sm.violations().len(), 2);
        assert_eq!(sm.violation_count(), 3);
        assert_eq!(sm.violations().last().expect("最新违规").reason, "bad-3");
    }

    #[test]
    fn snapshot_json_has_expected_shape() {
        let mut sm = machine();
        sm.activate().expect("ready");
        let json = sm.snapshot_json();
        assert_eq!(json.get("sessionId").and_then(Json::as_str), Some("s1"));
        assert_eq!(json.get("state").and_then(Json::as_str), Some("ready"));
        assert_eq!(json.get("canonical").and_then(Json::as_str), Some("ready"));
        assert_eq!(json.get("phase").and_then(Json::as_str), Some("active"));
        assert_eq!(json.get("retired").and_then(Json::as_bool), Some(false));
        assert_eq!(json.get("transitions").and_then(Json::as_u64), Some(1));
        let last = json.get("lastTransition").expect("最后迁移");
        assert_eq!(last.get("to").and_then(Json::as_str), Some("ready"));
        let history = json.get("history").and_then(Json::as_array).expect("history");
        assert_eq!(history.len(), 1);
        let state_json = SessionState::Ready.to_json();
        assert_eq!(state_json.get("phase").and_then(Json::as_str), Some("active"));
        assert_eq!(state_json.get("allowed").and_then(Json::as_array).map(<[Json]>::len), Some(3));
    }

    #[test]
    fn retired_snapshot_reports_state() {
        let mut sm = machine();
        sm.activate().expect("ready");
        sm.finish("cleanup");
        let json = sm.snapshot_json();
        assert_eq!(json.get("retired").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("state").and_then(Json::as_str), Some("stopped"));
    }

    #[test]
    fn system_clock_is_wall_clock_millis() {
        let now = system_now_ms();
        assert!(now > 1_600_000_000_000, "Unix 毫秒应远大于 2020 年：{now}");
        let sm = SessionStateMachine::new("s-system");
        assert!(sm.snapshot().since_ms > 1_600_000_000_000);
    }

    #[test]
    fn force_transition_marks_forced() {
        let mut sm = machine();
        sm.activate().expect("ready");
        let snapshot = sm.force_transition(SessionState::Starting, "force-restart").expect("强制迁移");
        assert_eq!(snapshot.state, SessionState::Starting);
        assert!(sm.history().last().expect("迁移").forced);
        assert_eq!(sm.violation_count(), 1);
        assert!(sm.violations()[0].forced);
    }
}
