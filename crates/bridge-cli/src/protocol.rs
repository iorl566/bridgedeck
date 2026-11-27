//! 协议摘要 / feature floor / 错误码 / 握手视图（`bridge-rs protocol` 的数据源）。
//!
//! 所有数量与清单来自生成物（`crate::generated::*`），本文件只做聚合与 JSON 编码；
//! MCP 工具数需要运行时 ctx 才能枚举，保留 0.3.0 冻结口径常量并注明来源。

use crate::errors;
pub use crate::generated::protocol_catalog::{
    PROTOCOL_BASELINE, PROTOCOL_CURRENT, PROTOCOL_MAJOR, PROTOCOL_MINOR, PRODUCT_VERSION,
};
use crate::generated::protocol_catalog::{
    MethodSpec, EFFECT_COUNTS, FEATURE_COUNT, FEATURE_FLOORS, METHOD_CATALOG, METHOD_COUNT, OWNER_COUNTS,
};
use crate::handshake::{
    feature_availability, generate_instance_id, negotiate, DaemonProfile, Hello, ProtocolVersion, ServerHandshake,
    DAEMON_CAPABILITIES,
};
use crate::json::Json;
use crate::session::SessionState;

/// MCP 工具数（0.3.0 冻结口径，W4 验收 67；MCP 注册表依赖 ctx，无法无运行时生成）。
pub const MCP_TOOL_COUNT: usize = 67;

/// 兼容性探测的协议版本（1.8 旧客户端 / 1.9 当前 / 2.0 未来 major）。
pub const COMPATIBILITY_PEERS: [&str; 3] = ["1.8", "1.9", "2.0"];

/// 按方法名查目录行（线性扫描 165 行，CLI 冷路径足够）。
pub fn method_spec(method: &str) -> Option<&'static MethodSpec> {
    METHOD_CATALOG.iter().find(|spec| spec.method == method)
}

fn owner_counts_json() -> Json {
    Json::Object(OWNER_COUNTS.iter().map(|(owner, count)| (owner.to_string(), Json::Number(*count as f64))).collect())
}

fn effect_counts_json() -> Json {
    Json::Object(EFFECT_COUNTS.iter().map(|(effect, count)| (effect.to_string(), Json::Number(*count as f64))).collect())
}

fn session_transitions_json() -> Json {
    Json::Object(
        SessionState::ALL
            .iter()
            .map(|state| {
                (
                    state.as_str().to_string(),
                    Json::Array(state.allowed_transitions().iter().map(|target| Json::string(target.as_str())).collect()),
                )
            })
            .collect(),
    )
}

fn compatibility_json() -> Json {
    let mut entries = Vec::new();
    for peer in COMPATIBILITY_PEERS {
        let negotiation = negotiate(Some(peer), PROTOCOL_CURRENT);
        let features = feature_availability(Some(peer));
        // 被拒绝的对端（major≠1）连不上，feature 可用性没有意义：按 0 可用上报。
        let (available, missing): (usize, Vec<&str>) = if negotiation.accepted {
            let available = features.iter().filter(|feature| feature.available).count();
            let missing = features.iter().filter(|feature| !feature.available).map(|feature| feature.feature).collect();
            (available, missing)
        } else {
            (0, FEATURE_FLOORS.iter().map(|feature| feature.feature).collect())
        };
        let mut value = match negotiation.to_json() {
            Json::Object(entries) => entries,
            other => vec![("negotiation".to_string(), other)],
        };
        value.push(("featuresAvailable".to_string(), Json::Number(available as f64)));
        value.push(("featuresMissing".to_string(), Json::Number(missing.len() as f64)));
        value.push((
            "missing".to_string(),
            Json::Array(missing.into_iter().map(Json::string).collect()),
        ));
        entries.push((peer.to_string(), Json::Object(value)));
    }
    Json::Object(entries)
}

fn feature_rows_json() -> Json {
    Json::Array(
        FEATURE_FLOORS
            .iter()
            .map(|spec| {
                let mut availability = Vec::new();
                for peer in COMPATIBILITY_PEERS {
                    // 连接被拒绝的 major（2.0）不提供任何 feature：可用性按 false 上报。
                    let accepted = negotiate(Some(peer), PROTOCOL_CURRENT).accepted;
                    let available = accepted
                        && feature_availability(Some(peer))
                            .into_iter()
                            .find(|feature| feature.feature == spec.feature)
                            .map(|feature| feature.available)
                            .unwrap_or(false);
                    availability.push((peer.to_string(), Json::Bool(available)));
                }
                crate::json_obj! {
                    "feature" => Json::string(spec.feature),
                    "required" => Json::string(spec.floor),
                    "label" => Json::string(spec.label),
                    "kind" => Json::string(spec.kind),
                    "availability" => Json::Object(availability),
                }
            })
            .collect(),
    )
}

/// protocol 示例 hello（协议当前版本 + 扩展能力位），供 `protocol handshake --json` 展示。
pub fn sample_hello() -> Hello {
    let mut hello = Hello::new(PRODUCT_VERSION, "edge", "156.0.4314.58");
    hello.protocol = Some(PROTOCOL_CURRENT.to_string());
    hello.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36".to_string();
    hello.capabilities = ["observe", "frames", "dialog", "screenshot"]
        .iter()
        .map(|cap| cap.to_string())
        .collect();
    hello.browser_id = "0f1e2d3c4b5a6978".to_string();
    hello.label = "bridge-rs".to_string();
    hello
}

fn sample_hello_ack() -> crate::handshake::HelloAck {
    let daemon = DaemonProfile::current();
    let profile_id = "a1b2c3d4";
    let mut handshake = ServerHandshake::with_instance_id(profile_id);
    match handshake.handle_hello(&sample_hello().to_json(), &daemon) {
        crate::handshake::HelloOutcome::Ack(ack) => ack,
        crate::handshake::HelloOutcome::Rejected(_) => {
            // 示例 hello 用当前协议，正常不会走到这里；保底仍返回形状完整的 ack。
            let mut ack = crate::handshake::HelloAck::new(profile_id, PRODUCT_VERSION, PROTOCOL_CURRENT);
            ack.capabilities = DAEMON_CAPABILITIES.iter().map(|cap| cap.to_string()).collect();
            ack
        }
    }
}

/// `protocol --json`（summary）：保留 0.3.0 骨架的 `product/protocol/canonicalMethods/mcpTools`，
/// 追加错误码、feature floor、兼容矩阵、会话状态机与握手示例。
pub fn summary_json() -> Json {
    let current_features = feature_availability(Some(PROTOCOL_CURRENT));
    let mut entries = vec![
        ("ok".to_string(), Json::Bool(true)),
        ("product".to_string(), Json::string(PRODUCT_VERSION)),
        ("protocol".to_string(), Json::string(PROTOCOL_CURRENT)),
        ("baseline".to_string(), Json::string(PROTOCOL_BASELINE)),
        ("major".to_string(), Json::Number(PROTOCOL_MAJOR as f64)),
        ("minor".to_string(), Json::Number(PROTOCOL_MINOR as f64)),
        ("canonicalMethods".to_string(), Json::Number(METHOD_COUNT as f64)),
        ("mcpTools".to_string(), Json::Number(MCP_TOOL_COUNT as f64)),
        ("errorCodes".to_string(), Json::Number(errors::ERROR_CODE_COUNT as f64)),
        ("errorRecovery".to_string(), Json::Number(errors::ERROR_RECOVERY_COUNT as f64)),
        ("featureFloors".to_string(), Json::Number(FEATURE_COUNT as f64)),
        ("methodOwners".to_string(), owner_counts_json()),
        ("methodEffects".to_string(), effect_counts_json()),
        ("features".to_string(), feature_rows_json()),
        ("compatibility".to_string(), compatibility_json()),
        ("sessionStates".to_string(), Json::Array(SessionState::ALL.iter().map(|state| Json::string(state.as_str())).collect())),
        ("sessionTransitions".to_string(), session_transitions_json()),
        (
            "hello".to_string(),
            crate::json_obj! {
                "client" => sample_hello().to_json(),
                "ack" => sample_hello_ack().to_json(),
            },
        ),
        (
            "capabilities".to_string(),
            Json::Array(DAEMON_CAPABILITIES.iter().map(|cap| Json::string(*cap)).collect()),
        ),
    ];
    // 键顺序按插入（与 JSON.stringify 风格一致）；后面追加“当前版本特性可用数”。
    let available = current_features.iter().filter(|feature| feature.available).count();
    entries.push((
        "featuresAvailable".to_string(),
        crate::json_obj! {
            "peer" => Json::string(PROTOCOL_CURRENT),
            "available" => Json::Number(available as f64),
            "total" => Json::Number(current_features.len() as f64),
        },
    ));
    Json::Object(entries)
}

/// `protocol codes --json`。
pub fn codes_json() -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "count" => Json::Number(errors::ERROR_CODE_COUNT as f64),
        "recoveryCount" => Json::Number(errors::ERROR_RECOVERY_COUNT as f64),
        "codes" => errors::list_json(),
    }
}

/// `protocol features --json`。
pub fn features_json() -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "baseline" => Json::string(PROTOCOL_BASELINE),
        "current" => Json::string(PROTOCOL_CURRENT),
        "count" => Json::Number(FEATURE_COUNT as f64),
        "peers" => Json::Array(COMPATIBILITY_PEERS.iter().map(|peer| Json::string(*peer)).collect()),
        "compatibility" => compatibility_json(),
        "features" => feature_rows_json(),
    }
}

/// `protocol handshake --json`：示例 hello / hello-ack、版本协商、ack 往返验证。
pub fn handshake_json() -> Json {
    let hello = sample_hello();
    let ack = sample_hello_ack();
    let round_trip = match crate::handshake::HelloAck::from_json(&ack.to_json()) {
        Ok(decoded) => decoded == ack,
        Err(error) => {
            let _ = error;
            false
        }
    };
    let peers: Vec<Json> = COMPATIBILITY_PEERS
        .iter()
        .map(|peer| {
            let negotiation = negotiate(Some(*peer), PROTOCOL_CURRENT);
            let mut value = negotiation.to_json();
            if let Json::Object(entries) = &mut value {
                // 被拒绝的 major 不提供 feature：按 0 可用上报，避免“连不上但显示可用”。
                let available = if negotiation.accepted {
                    feature_availability(Some(*peer)).iter().filter(|feature| feature.available).count()
                } else {
                    0
                };
                entries.push(("featuresAvailable".to_string(), Json::Number(available as f64)));
                entries.push(("featuresTotal".to_string(), Json::Number(FEATURE_COUNT as f64)));
            }
            value
        })
        .collect();
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "daemon" => DaemonProfile::current().to_json(),
        "hello" => hello.to_json(),
        "helloAck" => ack.to_json(),
        "helloAckRoundTrip" => Json::Bool(round_trip),
        "peers" => Json::Array(peers),
        "instanceIdSample" => Json::string(generate_instance_id()),
    }
}

/// `protocol` 人类可读摘要。
pub fn summary_text() -> String {
    let owners = crate::generated::protocol_catalog::OWNER_COUNTS
        .iter()
        .map(|(owner, count)| format!("{owner} {count}"))
        .collect::<Vec<_>>()
        .join(" / ");
    let compatibility = COMPATIBILITY_PEERS
        .iter()
        .map(|peer| {
            let negotiation = negotiate(Some(*peer), PROTOCOL_CURRENT);
            if negotiation.accepted {
                format!("{peer} accepted")
            } else {
                format!("{peer} rejected {}", negotiation.code.map(|code| code.as_str()).unwrap_or("E_PROTOCOL_UNSUPPORTED"))
            }
        })
        .collect::<Vec<_>>()
        .join(" | ");
    format!(
        "product {PRODUCT_VERSION} / protocol {PROTOCOL_CURRENT}（baseline {PROTOCOL_BASELINE}）\n\
         canonical methods {METHOD_COUNT}（{owners}）\n\
         MCP tools {MCP_TOOL_COUNT} / error codes {} / feature floors {FEATURE_COUNT}\n\
         session states 8：{}\n\
         compatibility：{compatibility}",
        errors::ERROR_CODE_COUNT,
        SessionState::ALL.iter().map(|state| state.as_str()).collect::<Vec<_>>().join(" ")
    )
}

/// `protocol codes` 人类可读清单。
pub fn codes_text() -> String {
    let mut lines = vec![format!(
        "错误码 {} 个（恢复建议 {} 条），单源 lib/error-codes.mjs：",
        errors::ERROR_CODE_COUNT,
        errors::ERROR_RECOVERY_COUNT
    )];
    for code in errors::all() {
        let line = match errors::recovery(code) {
            Some(recovery) => format!("{:<32} {}（重试：{}；{}）", code.as_str(), code.description(), recovery.retry, recovery.hint),
            None => format!("{:<32} {}", code.as_str(), code.description()),
        };
        lines.push(line);
    }
    lines.join("\n")
}

/// `protocol features` 人类可读清单。
pub fn features_text() -> String {
    let mut lines = vec![format!(
        "feature floors {FEATURE_COUNT} 项（baseline {PROTOCOL_BASELINE} / current {PROTOCOL_CURRENT}）："
    )];
    for spec in FEATURE_FLOORS {
        let peers = COMPATIBILITY_PEERS
            .iter()
            .map(|peer| {
                let available = feature_availability(Some(*peer))
                    .into_iter()
                    .find(|feature| feature.feature == spec.feature)
                    .map(|feature| feature.available)
                    .unwrap_or(false);
                format!("{peer}={}", if available { "on" } else { "off" })
            })
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!(
            "{:<16} floor {:<5} {:<12} {:<12} {peers}",
            spec.feature, spec.floor, spec.label, spec.kind
        ));
    }
    lines.join("\n")
}

/// `protocol handshake` 人类可读摘要。
pub fn handshake_text() -> String {
    let hello = sample_hello();
    let ack = sample_hello_ack();
    let negotiation = negotiate(hello.protocol.as_deref(), PROTOCOL_CURRENT);
    format!(
        "hello：browser {} / ext {} / protocol {}（{}）\n\
         hello-ack：instanceId {} / daemon {} / protocol {} / capabilities {}\n\
         localAuth：{}（strict={}）\n\
         协商：{}",
        hello.browser,
        hello.ext_version,
        hello.protocol_label(),
        negotiation.message,
        ack.instance_id,
        ack.daemon_version,
        ack.protocol,
        ack.capabilities.len(),
        ack.local_auth.state,
        ack.local_auth.strict,
        if negotiation.accepted { "accepted" } else { "rejected" }
    )
}

/// 协议版本是否被本 daemon 接受（供测试/未来 status 使用）。
pub fn accepts_protocol(peer: Option<&str>) -> bool {
    negotiate(peer, PROTOCOL_CURRENT).accepted
}

/// 解析协议版本（供 CLI 参数校验复用）。
pub fn parse_protocol_version(text: &str) -> Option<ProtocolVersion> {
    ProtocolVersion::parse(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_backward_compatible_fields() {
        let json = summary_json();
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("product").and_then(Json::as_str), Some("0.3.0"));
        assert_eq!(json.get("protocol").and_then(Json::as_str), Some("1.9"));
        assert_eq!(json.get("canonicalMethods").and_then(Json::as_u64), Some(165));
        assert_eq!(json.get("mcpTools").and_then(Json::as_u64), Some(67));
        assert_eq!(json.get("errorCodes").and_then(Json::as_u64), Some(158));
        assert_eq!(json.get("featureFloors").and_then(Json::as_u64), Some(9));
        assert_eq!(json.get("baseline").and_then(Json::as_str), Some("1.8"));
        let encoded = json.to_compact_string();
        assert!(encoded.starts_with('{') && encoded.ends_with('}'));
        assert!(!encoded.contains(": "), "紧凑 JSON 不应带空格分隔符");
    }

    #[test]
    fn summary_aggregates_generated_catalog() {
        let json = summary_json();
        let owners = json.get("methodOwners").expect("methodOwners");
        assert_eq!(owners.get("local").and_then(Json::as_u64), Some(39));
        assert_eq!(owners.get("session").and_then(Json::as_u64), Some(109));
        assert_eq!(owners.get("instance").and_then(Json::as_u64), Some(17));
        let effect = json.get("methodEffects").expect("methodEffects");
        assert_eq!(effect.get("control_plane").and_then(Json::as_u64), Some(58));
        assert_eq!(effect.get("browser_mutation").and_then(Json::as_u64), Some(68));
        assert_eq!(effect.get("passive_read").and_then(Json::as_u64), Some(36));
        assert_eq!(effect.get("transient_input").and_then(Json::as_u64), Some(1));
        assert_eq!(effect.get("read").and_then(Json::as_u64), Some(2));
        let states = json.get("sessionStates").and_then(Json::as_array).expect("sessionStates");
        assert_eq!(states.len(), 8);
        assert_eq!(states[0].as_str(), Some("idle"));
        assert_eq!(states[7].as_str(), Some("failed"));
        let transitions = json.get("sessionTransitions").expect("transitions");
        assert_eq!(
            transitions.get("stopping").and_then(Json::as_array).map(<[Json]>::len),
            Some(3)
        );
    }

    #[test]
    fn summary_compatibility_matrix_covers_three_peers() {
        let json = summary_json();
        let compatibility = json.get("compatibility").expect("compatibility");
        let baseline = compatibility.get("1.8").expect("1.8");
        assert_eq!(baseline.get("accepted").and_then(Json::as_bool), Some(true));
        assert_eq!(baseline.get("skew").and_then(Json::as_str), Some("older"));
        assert_eq!(baseline.get("featuresAvailable").and_then(Json::as_u64), Some(0));
        assert_eq!(baseline.get("featuresMissing").and_then(Json::as_u64), Some(9));
        let current = compatibility.get("1.9").expect("1.9");
        assert_eq!(current.get("accepted").and_then(Json::as_bool), Some(true));
        assert_eq!(current.get("featuresAvailable").and_then(Json::as_u64), Some(9));
        let future = compatibility.get("2.0").expect("2.0");
        assert_eq!(future.get("accepted").and_then(Json::as_bool), Some(false));
        assert_eq!(future.get("code").and_then(Json::as_str), Some("E_PROTOCOL_UNSUPPORTED"));
        assert_eq!(future.get("featuresAvailable").and_then(Json::as_u64), Some(0), "被拒绝的 major 不提供 feature");
        assert_eq!(future.get("featuresMissing").and_then(Json::as_u64), Some(9));
    }

    #[test]
    fn summary_contains_hello_round_trip_sample() {
        let json = summary_json();
        let hello = json.get("hello").expect("hello");
        let client = hello.get("client").expect("client");
        assert_eq!(client.get("type").and_then(Json::as_str), Some("hello"));
        assert_eq!(client.get("protocol").and_then(Json::as_str), Some("1.9"));
        assert_eq!(client.get("browser").and_then(Json::as_str), Some("edge"));
        let ack = hello.get("ack").expect("ack");
        assert_eq!(ack.get("type").and_then(Json::as_str), Some("hello-ack"));
        assert_eq!(ack.get("protocol").and_then(Json::as_str), Some("1.9"));
        assert_eq!(
            ack.get("capabilities").and_then(Json::as_array).map(<[Json]>::len),
            Some(DAEMON_CAPABILITIES.len())
        );
        // 示例 hello 必须真的能被服务端解码器接受（不是手写的假 JSON）。
        let decoded = Hello::from_json(client).expect("示例 hello 应可解码");
        assert_eq!(decoded.protocol_version(), Some(ProtocolVersion::V1_9));
    }

    #[test]
    fn method_catalog_lookup_works() {
        assert_eq!(METHOD_CATALOG.len(), METHOD_COUNT);
        assert_eq!(METHOD_COUNT, 165);
        let start = method_spec("session.start").expect("session.start 在目录中");
        assert_eq!(start.owner, "local");
        assert_eq!(start.effect, "control_plane");
        assert!(start.unknown);
        assert_eq!(start.reconcile, "ledger");
        let navigate = method_spec("navigate").expect("navigate 在目录中");
        assert_eq!(navigate.effect, "browser_mutation");
        let screenshot = method_spec("screenshot").expect("screenshot 在目录中");
        assert!(screenshot.partial);
        assert_eq!(method_spec("not.a.method"), None);
        let unique: std::collections::BTreeSet<&str> = METHOD_CATALOG.iter().map(|spec| spec.method).collect();
        assert_eq!(unique.len(), METHOD_COUNT, "方法名必须唯一");
    }

    #[test]
    fn codes_json_wraps_generated_error_codes() {
        let json = codes_json();
        assert_eq!(json.get("count").and_then(Json::as_u64), Some(158));
        assert_eq!(json.get("recoveryCount").and_then(Json::as_u64), Some(48));
        let codes = json.get("codes").and_then(Json::as_array).expect("codes");
        assert_eq!(codes.len(), 158);
        assert_eq!(codes[0].get("code").and_then(Json::as_str), Some("E_BAD_ARG"));
        assert!(codes.iter().any(|code| code.get("code").and_then(Json::as_str) == Some("E_SESSION_TRANSITION")));
    }

    #[test]
    fn features_json_shows_nine_floors_with_availability() {
        let json = features_json();
        assert_eq!(json.get("count").and_then(Json::as_u64), Some(9));
        let features = json.get("features").and_then(Json::as_array).expect("features");
        assert_eq!(features.len(), 9);
        let first = &features[0];
        assert_eq!(first.get("feature").and_then(Json::as_str), Some("unverified"));
        assert_eq!(first.get("required").and_then(Json::as_str), Some("1.9"));
        let availability = first.get("availability").expect("availability");
        assert_eq!(availability.get("1.8").and_then(Json::as_bool), Some(false));
        assert_eq!(availability.get("1.9").and_then(Json::as_bool), Some(true));
        assert_eq!(availability.get("2.0").and_then(Json::as_bool), Some(false), "被拒绝的 major 不提供 feature");
        let compatibility = json.get("compatibility").expect("compatibility");
        assert_eq!(compatibility.get("2.0").and_then(|peer| peer.get("accepted")).and_then(Json::as_bool), Some(false));
    }

    #[test]
    fn handshake_json_round_trips_ack() {
        let json = handshake_json();
        assert_eq!(json.get("helloAckRoundTrip").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("daemon").and_then(|daemon| daemon.get("protocol")).and_then(Json::as_str), Some("1.9"));
        let instance = json.get("instanceIdSample").and_then(Json::as_str).expect("instanceIdSample");
        assert_eq!(instance.len(), 8);
        let peers = json.get("peers").and_then(Json::as_array).expect("peers");
        assert_eq!(peers.len(), 3);
        assert_eq!(peers[0].get("peer").and_then(Json::as_str), Some("1.8"));
        assert_eq!(peers[0].get("accepted").and_then(Json::as_bool), Some(true));
        assert_eq!(peers[0].get("featuresAvailable").and_then(Json::as_u64), Some(0));
        assert_eq!(peers[2].get("accepted").and_then(Json::as_bool), Some(false));
    }

    #[test]
    fn human_text_views_are_non_empty_and_consistent() {
        let summary = summary_text();
        assert!(summary.contains("canonical methods 165"));
        assert!(summary.contains("error codes 158"));
        assert!(summary.contains("feature floors 9"));
        assert!(summary.contains("1.8 accepted"));
        assert!(summary.contains("2.0 rejected E_PROTOCOL_UNSUPPORTED"));
        let codes = codes_text();
        assert!(codes.starts_with("错误码 158 个"));
        assert!(codes.contains("E_SESSION_TRANSITION"));
        assert_eq!(codes.lines().count(), 159, "标题 + 158 条");
        let features = features_text();
        assert!(features.contains("feature floors 9 项"));
        assert!(features.contains("capture.stream"));
        let handshake = handshake_text();
        assert!(handshake.contains("hello-ack"));
        assert!(handshake.contains("accepted"));
    }

    #[test]
    fn protocol_helpers_accept_baseline_and_reject_major_two() {
        assert!(accepts_protocol(Some("1.8")));
        assert!(accepts_protocol(None));
        assert!(!accepts_protocol(Some("2.0")));
        assert_eq!(parse_protocol_version("1.8"), Some(ProtocolVersion::V1_8));
        assert_eq!(parse_protocol_version("x"), None);
    }
}
