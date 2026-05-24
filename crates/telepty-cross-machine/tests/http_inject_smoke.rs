mod support;

#[test]
fn inject_peer_posts_prompt_to_stored_http_peer() {
    let mut server = support::MockServer::spawn(vec![support::Route {
        method: "POST",
        path: "/api/sessions/target-session/inject",
        status: 200,
        body: r#"{"success":true,"inject_id":"abc"}"#,
    }]);
    let home = support::temp_home("inject-peer");
    support::write_peers(
        &home,
        &format!(
            r#"{{
              "peers": {{
                "lab": {{
                  "transport": "http",
                  "host": "127.0.0.1",
                  "port": {},
                  "target": "127.0.0.1:{}",
                  "machineId": "machine-xyz",
                  "token": "secret-token"
                }}
              }}
            }}"#,
            server.port(),
            server.port()
        ),
    );

    let output = support::bin_command()
        .env("HOME", &home)
        .args(["inject-peer", "lab", "target-session", "--text", "hello"])
        .output()
        .expect("run binary");

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "OK injected to target-session@lab (5 bytes)"
    );

    server.join();
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/api/sessions/target-session/inject");
    assert_eq!(requests[0].token.as_deref(), Some("secret-token"));
    assert!(
        requests[0].body.contains(r#""prompt":"hello""#),
        "request body: {}",
        requests[0].body
    );
}

#[test]
fn list_peer_sessions_json_prints_remote_sessions() {
    let mut server = support::MockServer::spawn(vec![support::Route {
        method: "GET",
        path: "/api/sessions",
        status: 200,
        body: r#"[{"id":"s1","type":"wrapped","command":"codex"}]"#,
    }]);
    let home = support::temp_home("list-peer-sessions");
    support::write_peers(
        &home,
        &format!(
            r#"{{
              "peers": {{
                "lab": {{
                  "transport": "http",
                  "host": "127.0.0.1",
                  "port": {},
                  "target": "127.0.0.1:{}",
                  "machineId": "machine-xyz",
                  "token": "secret-token"
                }}
              }}
            }}"#,
            server.port(),
            server.port()
        ),
    );

    let output = support::bin_command()
        .env("HOME", &home)
        .args(["list-peer-sessions", "lab", "--json"])
        .output()
        .expect("run binary");

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains(r#""id": "s1""#));
    assert!(stdout.contains(r#""command": "codex""#));

    server.join();
    let requests = server.requests();
    assert_eq!(requests[0].token.as_deref(), Some("secret-token"));
}
