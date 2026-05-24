mod support;

use telepty_cross_machine::{load_peers, Transport};

#[test]
fn connect_http_probes_health_fetches_meta_and_persists_peer() {
    let mut server = support::MockServer::spawn(vec![
        support::Route {
            method: "GET",
            path: "/api/health",
            status: 200,
            body: r#"{"status":"ok"}"#,
        },
        support::Route {
            method: "GET",
            path: "/api/meta",
            status: 200,
            body: r#"{"machine_id":"machine-xyz","host":"ignored-host"}"#,
        },
    ]);
    let home = support::temp_home("connect-http");

    let output = support::bin_command()
        .env("HOME", &home)
        .args([
            "connect-http",
            &format!("127.0.0.1:{}", server.port()),
            "--token",
            "secret-token",
            "--name",
            "lab",
        ])
        .output()
        .expect("run binary");

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("OK peer \"lab\" registered"));
    assert!(stdout.contains("machine_id=machine-xyz"));

    server.join();
    let requests = server.requests();
    assert_eq!(requests[0].path, "/api/health");
    assert_eq!(requests[0].token, None);
    assert_eq!(requests[1].path, "/api/meta");
    assert_eq!(requests[1].token.as_deref(), Some("secret-token"));

    let store = load_peers(&home.join(".telepty").join("peers.json")).expect("load peers");
    let peer = store.peers.get("lab").expect("peer persisted");
    assert_eq!(peer.transport, Transport::Http);
    assert_eq!(peer.host.as_deref(), Some("127.0.0.1"));
    assert_eq!(peer.port, Some(server.port()));
    assert_eq!(peer.machine_id.as_deref(), Some("machine-xyz"));
    assert_eq!(peer.token.as_deref(), Some("secret-token"));
}
