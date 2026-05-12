//! Wire-schema golden round-trips per F12 (contract drift guard).
//!
//! Each enum variant must serialize/deserialize through the V1 ADR §6.2.1
//! (A1) / §6.4 (A2) / §7.3 (A3) names. A future enum amendment that fails to
//! update the wire crate breaks this test, surfacing the divergence at PR
//! review.

use telepty_supervisor_core::wire::{
    validate_incoming, ErrorCode, ExitReasonWire, Frame, Kind, SignalKind, WIRE_VERSION,
};

#[test]
fn signal_kind_full_six_variants_round_trip() {
    let pairs = [
        (SignalKind::Sigint, "\"SIGINT\""),
        (SignalKind::Sigterm, "\"SIGTERM\""),
        (SignalKind::Sighup, "\"SIGHUP\""),
        (SignalKind::Sigkill, "\"SIGKILL\""),
        (SignalKind::JobTerminate, "\"JOB_TERMINATE\""),
        (SignalKind::CtrlBreakEvent, "\"CTRL_BREAK_EVENT\""),
    ];
    for (variant, expected) in pairs {
        let json = serde_json::to_string(&variant).unwrap();
        assert_eq!(json, expected, "serialize mismatch for {:?}", variant);
        let back: SignalKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, variant);
    }
}

#[test]
fn error_code_full_a2_set_round_trips() {
    let pairs = [
        (ErrorCode::UnknownSession, "ERR_UNKNOWN_SESSION"),
        (ErrorCode::BadFrame, "ERR_BAD_FRAME"),
        (ErrorCode::UnsupportedVersion, "ERR_UNSUPPORTED_VERSION"),
        (ErrorCode::PermissionDenied, "ERR_PERMISSION_DENIED"),
        (ErrorCode::NotReachable, "ERR_NOT_REACHABLE"),
        (ErrorCode::DuplicateOp, "ERR_DUPLICATE_OP"),
        (ErrorCode::SpawnFailed, "ERR_SPAWN_FAILED"),
        (ErrorCode::ShuttingDown, "ERR_SHUTTING_DOWN"),
        (ErrorCode::UnknownKind, "ERR_UNKNOWN_KIND"),
        (ErrorCode::UnkillableChild, "ERR_UNKILLABLE_CHILD"),
        (ErrorCode::ParentGone, "ERR_PARENT_GONE"),
        (ErrorCode::SupervisorGone, "ERR_SUPERVISOR_GONE"),
        (ErrorCode::ManifestWriteFail, "ERR_MANIFEST_WRITE_FAIL"),
        (ErrorCode::EscapedDescendant, "ERR_ESCAPED_DESCENDANT"),
        (ErrorCode::PgrpLiveAfterKill, "ERR_PGRP_LIVE_AFTER_KILL"),
    ];
    for (variant, expected) in pairs {
        let json = serde_json::to_string(&variant).unwrap();
        let quoted = format!("\"{}\"", expected);
        assert_eq!(json, quoted, "serialize mismatch for {:?}", variant);
        let back: ErrorCode = serde_json::from_str(&json).unwrap();
        assert_eq!(back, variant);
    }
}

#[test]
fn exit_reason_all_five_round_trip() {
    for r in [
        ExitReasonWire::Normal,
        ExitReasonWire::Signaled,
        ExitReasonWire::Killed,
        ExitReasonWire::Crashed,
        ExitReasonWire::Unkillable,
    ] {
        let j = serde_json::to_string(&r).unwrap();
        let back: ExitReasonWire = serde_json::from_str(&j).unwrap();
        assert_eq!(back, r);
    }
}

#[test]
fn frame_inject_with_trace_id_emits_canonical_shape() {
    let mut f = Frame::new(Kind::Inject);
    f.sid = Some("demo".into());
    f.trace_id = Some("trace-1".into());
    f.data = Some("echo hi\n".into());
    let line = f.to_ndjson_line();
    assert!(line.ends_with('\n'));
    let parsed: Frame = serde_json::from_str(line.trim_end()).unwrap();
    assert_eq!(parsed.kind, Kind::Inject);
    assert_eq!(parsed.v, WIRE_VERSION);
    assert_eq!(validate_incoming(&parsed).unwrap(), Kind::Inject);
}

#[test]
fn frame_unknown_kind_validation_error() {
    let line = r#"{"v":1,"kind":"telepathy","sid":"x"}"#;
    let f: Frame = serde_json::from_str(line).unwrap();
    let (code, detail) = validate_incoming(&f).unwrap_err();
    assert_eq!(code, ErrorCode::BadFrame);
    assert_eq!(detail, "kind_unknown");
}

#[test]
fn frame_v2_validation_error() {
    let f: Frame = serde_json::from_str(r#"{"v":2,"kind":"ping"}"#).unwrap();
    let (code, detail) = validate_incoming(&f).unwrap_err();
    assert_eq!(code, ErrorCode::BadFrame);
    assert_eq!(detail, "version_unsupported");
}
