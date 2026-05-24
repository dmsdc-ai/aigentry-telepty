use telepty_cross_machine::{PeerStore, Transport};

#[test]
fn missing_transport_defaults_to_ssh_and_round_trip_omits_transport() {
    let fixture = r#"{
      "peers": {
        "winserver": {
          "target": "Administrator@win.tail.ts.net",
          "machineId": "WIN-T6T20OIKEMR",
          "lastConnected": "2026-05-17T14:10:29.883Z"
        }
      }
    }"#;

    let store: PeerStore = serde_json::from_str(fixture).expect("deserialize legacy peer");
    let peer = store.peers.get("winserver").expect("legacy peer exists");
    assert_eq!(peer.transport, Transport::Ssh);
    assert_eq!(
        peer.target.as_deref(),
        Some("Administrator@win.tail.ts.net")
    );

    let round_trip = serde_json::to_string_pretty(&store).expect("serialize legacy peer");
    assert!(
        !round_trip.contains("\"transport\""),
        "legacy SSH peer round-trip must not inject a transport field: {round_trip}"
    );
    assert!(round_trip.contains("\"machineId\""));
    assert!(round_trip.contains("\"lastConnected\""));
}
