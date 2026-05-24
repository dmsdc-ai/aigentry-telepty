mod support;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use telepty_cross_machine::{load_peers, save_peers, PeerEntry, PeerStore};

#[test]
fn save_peers_writes_json_atomically_and_loads_back() {
    let home = support::temp_home("peers-atomic-basic");
    let path = home.join(".telepty").join("peers.json");
    let mut store = PeerStore::default();
    store.peers.insert(
        "lab".to_string(),
        PeerEntry::http("127.0.0.1".to_string(), 3848, "machine-a".to_string(), None),
    );

    save_peers(&path, &store).expect("save peers");
    assert!(path.exists());
    assert!(!path.with_extension("json.tmp").exists());
    let loaded = load_peers(&path).expect("load peers");
    assert_eq!(loaded.peers["lab"].host.as_deref(), Some("127.0.0.1"));
}

#[test]
fn concurrent_readers_never_observe_partial_peers_json() {
    let home = support::temp_home("peers-atomic-race");
    let path = home.join(".telepty").join("peers.json");
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let deadline = Instant::now() + Duration::from_millis(500);

    let writer_path = path.clone();
    let writer = thread::spawn(move || {
        let mut i = 0_u16;
        while Instant::now() < deadline {
            let mut store = PeerStore::default();
            store.peers.insert(
                "lab".to_string(),
                PeerEntry::http(
                    "127.0.0.1".to_string(),
                    3000 + (i % 100),
                    format!("machine-{i}"),
                    None,
                ),
            );
            save_peers(&writer_path, &store).expect("atomic save peers");
            i = i.wrapping_add(1);
        }
    });

    let readers = (0..4)
        .map(|_| {
            let path = path.clone();
            let errors = Arc::clone(&errors);
            thread::spawn(move || {
                while Instant::now() < deadline {
                    match std::fs::read_to_string(&path) {
                        Ok(contents) => {
                            if let Err(err) = serde_json::from_str::<PeerStore>(&contents) {
                                errors
                                    .lock()
                                    .expect("errors lock")
                                    .push(format!("{err}: {contents:?}"));
                            }
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                        Err(err) => errors.lock().expect("errors lock").push(err.to_string()),
                    }
                }
            })
        })
        .collect::<Vec<_>>();

    writer.join().expect("writer thread");
    for reader in readers {
        reader.join().expect("reader thread");
    }
    let errors = errors.lock().expect("errors lock");
    assert!(
        errors.is_empty(),
        "readers observed invalid JSON: {errors:?}"
    );
}
