mod support;

#[test]
fn http_subcommand_on_ssh_peer_exits_4() {
    let home = support::temp_home("ssh-peer-gate");
    support::write_peers(
        &home,
        r#"{
          "peers": {
            "winserver": {
              "target": "Administrator@win.tail.ts.net",
              "machineId": "WIN-T6T20OIKEMR"
            }
          }
        }"#,
    );

    let output = support::bin_command()
        .env("HOME", &home)
        .args(["list-peer-sessions", "winserver"])
        .output()
        .expect("run binary");

    assert_eq!(output.status.code(), Some(4));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim(),
        "ERR peer \"winserver\" is SSH transport; not supported by this binary (use JS path)"
    );
}
