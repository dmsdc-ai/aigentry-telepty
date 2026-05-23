//! NDJSON wire schema (V1 ADR §6.1 envelope + §6.2 kind-conditional + §6.2.1 A1
//! + §6.4 A2).
//!
//! Full enum schema lands here per F12 (contract drift guard) even though
//! Phase 1 only emits POSIX values; cross-LLM amendments that grow the enums
//! must update the goldens, which the reviewer catches in PR diff.

use serde::{Deserialize, Serialize};

pub const WIRE_VERSION: u32 = 1;

/// V1 ADR §6.2 frame kinds. `#[serde(other)]` lets unknown kinds round-trip
/// through deserialization so we can emit `ERR_BAD_FRAME { data: kind_unknown }`
/// per dispatch smoke 5 instead of failing parse outright.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Inject,
    Output,
    Spawn,
    Delete,
    Resize,
    Signal,
    Ping,
    Pong,
    Error,
    Kill,
    ShutdownDrain,
    /// A5 reattach — client requests replay of Output frames with `seq > from_seq`
    /// from the supervisor's `log.jsonl` before subscribing to the live broadcast.
    /// Per C3 spec §1.4 reattach semantics + dispatch §A5 (P1 surface).
    Resume,
    #[serde(other)]
    Unknown,
}

/// V1 ADR §6.2.1 A1 — full enum schema. Phase 1 emit gate (Q-A hybrid r2):
/// POSIX-only `{Sigint, Sigterm, Sighup, Sigkill}` are reachable; Windows
/// `JobTerminate` / `CtrlBreakEvent` round-trip but are `unreachable!()` on
/// supervisor emit paths in Phase 1.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SignalKind {
    #[serde(rename = "SIGINT")]
    Sigint,
    #[serde(rename = "SIGTERM")]
    Sigterm,
    #[serde(rename = "SIGHUP")]
    Sighup,
    #[serde(rename = "SIGKILL")]
    Sigkill,
    #[serde(rename = "JOB_TERMINATE")]
    JobTerminate,
    #[serde(rename = "CTRL_BREAK_EVENT")]
    CtrlBreakEvent,
}

/// V1 ADR §6.4 — full A2 schema (Phase 1 minimal + SPEC-C3-r1 kill-gate extensions).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorCode {
    #[serde(rename = "ERR_UNKNOWN_SESSION")]
    UnknownSession,
    #[serde(rename = "ERR_BAD_FRAME")]
    BadFrame,
    #[serde(rename = "ERR_UNSUPPORTED_VERSION")]
    UnsupportedVersion,
    #[serde(rename = "ERR_PERMISSION_DENIED")]
    PermissionDenied,
    #[serde(rename = "ERR_NOT_REACHABLE")]
    NotReachable,
    #[serde(rename = "ERR_DUPLICATE_OP")]
    DuplicateOp,
    #[serde(rename = "ERR_SPAWN_FAILED")]
    SpawnFailed,
    #[serde(rename = "ERR_SHUTTING_DOWN")]
    ShuttingDown,
    #[serde(rename = "ERR_UNKNOWN_KIND")]
    UnknownKind,
    #[serde(rename = "ERR_UNKILLABLE_CHILD")]
    UnkillableChild,
    #[serde(rename = "ERR_PARENT_GONE")]
    ParentGone,
    #[serde(rename = "ERR_SUPERVISOR_GONE")]
    SupervisorGone,
    #[serde(rename = "ERR_MANIFEST_WRITE_FAIL")]
    ManifestWriteFail,
    #[serde(rename = "ERR_ESCAPED_DESCENDANT")]
    EscapedDescendant,
    #[serde(rename = "ERR_PGRP_LIVE_AFTER_KILL")]
    PgrpLiveAfterKill,
}

/// V1 ADR §7.3 A3 — terminal exit reasons. Mirrors `manifest::ExitReason` but
/// kept distinct here so the wire schema can grow independently of the
/// manifest schema (per SPEC-C3-r1 §6.4 — `v` on wire vs `schema_version` on
/// disk are deliberately separate).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExitReasonWire {
    Normal,
    Signaled,
    Killed,
    Crashed,
    Unkillable,
}

/// Frame envelope (§6.1) + kind-conditional fields (§6.2). Unused fields are
/// skipped on serialize via `Option::None`; unknown incoming fields are
/// ignored (per V1 ADR §6.7 backward-compat forward-additive policy).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Frame {
    pub v: u32,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub op_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub signal: Option<SignalKind>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<ErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frame_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rtt_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_reason: Option<ExitReasonWire>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub escalated: Option<bool>,
    /// A5 reattach: client-supplied last-seen seq for log replay. Replay emits
    /// frames where `seq > from_seq`. None or 0 ⇒ replay from beginning.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from_seq: Option<u64>,
}

impl Frame {
    pub fn new(kind: Kind) -> Self {
        Self {
            v: WIRE_VERSION,
            kind,
            sid: None,
            trace_id: None,
            op_id: None,
            ts: None,
            data: None,
            signal: None,
            code: None,
            force: None,
            seq: None,
            cols: None,
            rows: None,
            frame_ref: None,
            idempotency_key: None,
            from: None,
            rtt_ms: None,
            exit_reason: None,
            exit_code: None,
            escalated: None,
            from_seq: None,
        }
    }

    pub fn error(code: ErrorCode, data: impl Into<String>) -> Self {
        let mut f = Self::new(Kind::Error);
        f.code = Some(code);
        f.data = Some(data.into());
        f
    }

    pub fn pong(trace_id: Option<String>) -> Self {
        let mut f = Self::new(Kind::Pong);
        f.trace_id = trace_id;
        f
    }

    pub fn output(sid: &str, data: String, trace_id: Option<String>, seq: u64) -> Self {
        let mut f = Self::new(Kind::Output);
        f.sid = Some(sid.to_string());
        f.data = Some(data);
        f.trace_id = trace_id;
        f.seq = Some(seq);
        f
    }

    pub fn shutdown_drain(
        sid: &str,
        exit_reason: ExitReasonWire,
        exit_code: Option<i32>,
        escalated: bool,
    ) -> Self {
        let mut f = Self::new(Kind::ShutdownDrain);
        f.sid = Some(sid.to_string());
        f.exit_reason = Some(exit_reason);
        f.exit_code = exit_code;
        f.escalated = Some(escalated);
        f
    }

    pub fn to_ndjson_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// Per-kind validation per V1 ADR §6.1 B3 + §6.2 required-field table.
/// Returns the validated kind to dispatch, or an `ErrorCode` to bounce back.
pub fn validate_incoming(frame: &Frame) -> Result<Kind, (ErrorCode, &'static str)> {
    if frame.v != WIRE_VERSION {
        return Err((ErrorCode::BadFrame, "version_unsupported"));
    }
    match frame.kind {
        Kind::Unknown => Err((ErrorCode::BadFrame, "kind_unknown")),
        Kind::Inject => {
            if frame.trace_id.is_none() {
                return Err((ErrorCode::BadFrame, "inject_missing_trace_id"));
            }
            if frame.data.is_none() {
                return Err((ErrorCode::BadFrame, "inject_missing_data"));
            }
            Ok(Kind::Inject)
        }
        Kind::Output => {
            if frame.trace_id.is_none() {
                return Err((ErrorCode::BadFrame, "output_missing_trace_id"));
            }
            Ok(Kind::Output)
        }
        Kind::Signal => {
            // B3 (C3 spec §1002 audit linkage): signal frames must carry trace_id
            // so the log.jsonl `kind:"signal"` event correlates with the
            // originating injector. Per C3 spec §1002.
            if frame.trace_id.is_none() {
                return Err((ErrorCode::BadFrame, "signal_missing_trace_id"));
            }
            if frame.signal.is_none() {
                return Err((ErrorCode::BadFrame, "signal_missing_field"));
            }
            Ok(Kind::Signal)
        }
        Kind::Kill => {
            // B3 audit linkage: kill frames require trace_id (same rationale as signal).
            if frame.trace_id.is_none() {
                return Err((ErrorCode::BadFrame, "kill_missing_trace_id"));
            }
            Ok(Kind::Kill)
        }
        Kind::Delete => {
            // B3 audit linkage: delete frames require trace_id so the resulting
            // shutdown_drain event can reference the originating delete operation
            // (C3 spec §1002 parent_trace_id pattern).
            if frame.trace_id.is_none() {
                return Err((ErrorCode::BadFrame, "delete_missing_trace_id"));
            }
            Ok(Kind::Delete)
        }
        Kind::Resize => {
            if frame.cols.is_none() || frame.rows.is_none() {
                return Err((ErrorCode::BadFrame, "resize_missing_dims"));
            }
            Ok(Kind::Resize)
        }
        Kind::Resume => {
            // `from_seq` optional — None ⇒ replay from beginning. `trace_id`
            // recommended for client-side correlation but not strictly required;
            // P1 keeps it optional to lower the reattach friction.
            Ok(Kind::Resume)
        }
        // Optional/None-required kinds.
        k => Ok(k),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_every_signal_variant() {
        for sk in [
            SignalKind::Sigint,
            SignalKind::Sigterm,
            SignalKind::Sighup,
            SignalKind::Sigkill,
            SignalKind::JobTerminate,
            SignalKind::CtrlBreakEvent,
        ] {
            let j = serde_json::to_string(&sk).unwrap();
            let back: SignalKind = serde_json::from_str(&j).unwrap();
            assert_eq!(sk, back, "round-trip mismatch for {:?} -> {}", sk, j);
        }
    }

    #[test]
    fn round_trip_every_error_code_variant() {
        let all = [
            ErrorCode::UnknownSession,
            ErrorCode::BadFrame,
            ErrorCode::UnsupportedVersion,
            ErrorCode::PermissionDenied,
            ErrorCode::NotReachable,
            ErrorCode::DuplicateOp,
            ErrorCode::SpawnFailed,
            ErrorCode::ShuttingDown,
            ErrorCode::UnknownKind,
            ErrorCode::UnkillableChild,
            ErrorCode::ParentGone,
            ErrorCode::SupervisorGone,
            ErrorCode::ManifestWriteFail,
            ErrorCode::EscapedDescendant,
            ErrorCode::PgrpLiveAfterKill,
        ];
        for code in all {
            let j = serde_json::to_string(&code).unwrap();
            let back: ErrorCode = serde_json::from_str(&j).unwrap();
            assert_eq!(code, back);
            assert!(j.starts_with("\"ERR_"), "{} should be ERR_-prefixed", j);
        }
    }

    #[test]
    fn unknown_kind_round_trips() {
        let line = r#"{"v":1,"kind":"weirdthing","sid":"x"}"#;
        let f: Frame = serde_json::from_str(line).unwrap();
        assert_eq!(f.kind, Kind::Unknown);
        let err = validate_incoming(&f).unwrap_err();
        assert_eq!(err.0, ErrorCode::BadFrame);
        assert_eq!(err.1, "kind_unknown");
    }

    #[test]
    fn version_two_rejected() {
        let line = r#"{"v":2,"kind":"ping"}"#;
        let f: Frame = serde_json::from_str(line).unwrap();
        let err = validate_incoming(&f).unwrap_err();
        assert_eq!(err.0, ErrorCode::BadFrame);
        assert_eq!(err.1, "version_unsupported");
    }

    #[test]
    fn inject_without_trace_id_rejected() {
        let f: Frame =
            serde_json::from_str(r#"{"v":1,"kind":"inject","sid":"x","data":"hi"}"#).unwrap();
        let err = validate_incoming(&f).unwrap_err();
        assert_eq!(err.0, ErrorCode::BadFrame);
        assert_eq!(err.1, "inject_missing_trace_id");
    }

    #[test]
    fn inject_with_trace_id_ok() {
        let f: Frame =
            serde_json::from_str(r#"{"v":1,"kind":"inject","sid":"x","trace_id":"t","data":"hi"}"#)
                .unwrap();
        assert_eq!(validate_incoming(&f).unwrap(), Kind::Inject);
    }

    #[test]
    fn signal_without_trace_id_rejected() {
        let f: Frame =
            serde_json::from_str(r#"{"v":1,"kind":"signal","sid":"x","signal":"SIGTERM"}"#)
                .unwrap();
        let err = validate_incoming(&f).unwrap_err();
        assert_eq!(err.0, ErrorCode::BadFrame);
        assert_eq!(err.1, "signal_missing_trace_id");
    }

    #[test]
    fn kill_without_trace_id_rejected() {
        let f: Frame = serde_json::from_str(r#"{"v":1,"kind":"kill","sid":"x"}"#).unwrap();
        let err = validate_incoming(&f).unwrap_err();
        assert_eq!(err.0, ErrorCode::BadFrame);
        assert_eq!(err.1, "kill_missing_trace_id");
    }

    #[test]
    fn delete_without_trace_id_rejected() {
        let f: Frame = serde_json::from_str(r#"{"v":1,"kind":"delete","sid":"x"}"#).unwrap();
        let err = validate_incoming(&f).unwrap_err();
        assert_eq!(err.0, ErrorCode::BadFrame);
        assert_eq!(err.1, "delete_missing_trace_id");
    }

    #[test]
    fn delete_with_trace_id_ok() {
        let f: Frame = serde_json::from_str(
            r#"{"v":1,"kind":"delete","sid":"x","trace_id":"t","force":true}"#,
        )
        .unwrap();
        assert_eq!(validate_incoming(&f).unwrap(), Kind::Delete);
    }
}
