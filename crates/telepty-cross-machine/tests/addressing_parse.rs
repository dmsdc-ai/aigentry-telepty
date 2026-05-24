use telepty_cross_machine::{
    build_daemon_url, build_daemon_ws_url, format_host_for_url, parse_host_spec,
    parse_session_target, DEFAULT_PORT,
};

#[test]
fn parse_host_spec_returns_localhost_defaults_for_empty_input() {
    assert_eq!(parse_host_spec("", DEFAULT_PORT).host, "127.0.0.1");
    assert_eq!(parse_host_spec("", DEFAULT_PORT).port, 3848);
    assert_eq!(parse_host_spec("   ", DEFAULT_PORT).host, "127.0.0.1");
    assert_eq!(parse_host_spec("   ", DEFAULT_PORT).port, 3848);
}

#[test]
fn parse_host_spec_accepts_bare_host_without_port() {
    let ip = parse_host_spec("192.168.4.165", DEFAULT_PORT);
    assert_eq!(ip.host, "192.168.4.165");
    assert_eq!(ip.port, 3848);
    let dns = parse_host_spec("build-server.local", DEFAULT_PORT);
    assert_eq!(dns.host, "build-server.local");
    assert_eq!(dns.port, 3848);
}

#[test]
fn parse_host_spec_extracts_embedded_port_from_host_port() {
    let default = parse_host_spec("192.168.4.165:3848", DEFAULT_PORT);
    assert_eq!(default.host, "192.168.4.165");
    assert_eq!(default.port, 3848);
    let custom = parse_host_spec("192.168.4.165:9090", DEFAULT_PORT);
    assert_eq!(custom.host, "192.168.4.165");
    assert_eq!(custom.port, 9090);
}

#[test]
fn parse_host_spec_strips_scheme_and_trailing_path() {
    let http = parse_host_spec("http://192.168.4.165:9090", DEFAULT_PORT);
    assert_eq!(http.host, "192.168.4.165");
    assert_eq!(http.port, 9090);
    let https = parse_host_spec("https://example.com:443", DEFAULT_PORT);
    assert_eq!(https.host, "example.com");
    assert_eq!(https.port, 443);
    let path = parse_host_spec("http://example.com:9090/api/sessions", DEFAULT_PORT);
    assert_eq!(path.host, "example.com");
    assert_eq!(path.port, 9090);
}

#[test]
fn parse_host_spec_uses_provided_default_port_when_none_embedded() {
    let host = parse_host_spec("host", 4000);
    assert_eq!(host.host, "host");
    assert_eq!(host.port, 4000);
    let explicit = parse_host_spec("host:9090", 4000);
    assert_eq!(explicit.host, "host");
    assert_eq!(explicit.port, 9090);
}

#[test]
fn parse_host_spec_handles_bracketed_ipv6_with_and_without_port() {
    let local = parse_host_spec("[::1]:3848", DEFAULT_PORT);
    assert_eq!(local.host, "::1");
    assert_eq!(local.port, 3848);
    let no_port = parse_host_spec("[::1]", DEFAULT_PORT);
    assert_eq!(no_port.host, "::1");
    assert_eq!(no_port.port, 3848);
    let custom = parse_host_spec("[fe80::1]:9090", DEFAULT_PORT);
    assert_eq!(custom.host, "fe80::1");
    assert_eq!(custom.port, 9090);
}

#[test]
fn parse_host_spec_preserves_bare_ipv6_literally() {
    let local = parse_host_spec("::1", DEFAULT_PORT);
    assert_eq!(local.host, "::1");
    assert_eq!(local.port, 3848);
    let link = parse_host_spec("fe80::1", DEFAULT_PORT);
    assert_eq!(link.host, "fe80::1");
    assert_eq!(link.port, 3848);
}

#[test]
fn build_daemon_url_produces_correct_http_url_for_various_inputs() {
    assert_eq!(
        build_daemon_url("192.168.4.165", DEFAULT_PORT),
        "http://192.168.4.165:3848"
    );
    assert_eq!(
        build_daemon_url("192.168.4.165:9090", DEFAULT_PORT),
        "http://192.168.4.165:9090"
    );
    assert_eq!(
        build_daemon_url("192.168.4.165:3848", DEFAULT_PORT),
        "http://192.168.4.165:3848"
    );
    assert_eq!(
        build_daemon_url("http://192.168.4.165:3848", DEFAULT_PORT),
        "http://192.168.4.165:3848"
    );
}

#[test]
fn build_daemon_ws_url_produces_correct_ws_url_for_various_inputs() {
    assert_eq!(
        build_daemon_ws_url("192.168.4.165", DEFAULT_PORT),
        "ws://192.168.4.165:3848"
    );
    assert_eq!(
        build_daemon_ws_url("192.168.4.165:9090", DEFAULT_PORT),
        "ws://192.168.4.165:9090"
    );
    assert_eq!(
        build_daemon_ws_url("192.168.4.165:3848", DEFAULT_PORT),
        "ws://192.168.4.165:3848"
    );
}

#[test]
fn format_host_for_url_brackets_bare_ipv6_addresses() {
    assert_eq!(format_host_for_url("::1"), "[::1]");
    assert_eq!(format_host_for_url("fe80::1"), "[fe80::1]");
    assert_eq!(format_host_for_url("192.168.4.165"), "192.168.4.165");
    assert_eq!(format_host_for_url("[::1]"), "[::1]");
}

#[test]
fn parse_session_target_splits_at_last_at_and_reuses_host_parser() {
    let target = parse_session_target("sid@with-at@http://example.com:9090/path", DEFAULT_PORT)
        .expect("parse session target");
    assert_eq!(target.session_id, "sid@with-at");
    assert_eq!(target.host, "example.com");
    assert_eq!(target.port, 9090);
}
