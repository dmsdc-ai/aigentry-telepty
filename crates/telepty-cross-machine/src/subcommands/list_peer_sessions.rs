use clap::Args as ClapArgs;
use serde_json::Value;
use telepty_cross_machine::http_transport::HttpTransport;
use telepty_cross_machine::peers::{load_peers, peers_path};
use telepty_cross_machine::{CrossMachineError, Result};

#[derive(Debug, ClapArgs)]
pub struct Args {
    pub peer_name: String,
    #[arg(long)]
    pub json: bool,
}

pub async fn run(args: Args) -> Result<()> {
    let path = peers_path()?;
    let store = load_peers(&path)?;
    let peer = store.require_http_peer(&args.peer_name)?;
    let host = peer
        .host
        .as_deref()
        .ok_or_else(|| CrossMachineError::InvalidPeer {
            name: args.peer_name.clone(),
            details: "missing host".to_string(),
        })?;
    let port = peer.port.ok_or_else(|| CrossMachineError::InvalidPeer {
        name: args.peer_name.clone(),
        details: "missing port".to_string(),
    })?;

    let transport = HttpTransport::new()?;
    let sessions = transport
        .list_sessions(host, port, peer.token.as_deref())
        .await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
    } else {
        print_sessions_table(&sessions);
    }
    Ok(())
}

fn print_sessions_table(sessions: &Value) {
    let Some(rows) = sessions.as_array() else {
        println!("No sessions");
        return;
    };
    println!("{:<32} {:<12} DETAILS", "ID", "TYPE");
    for row in rows {
        let id = row.get("id").and_then(Value::as_str).unwrap_or("-");
        let kind = row
            .get("type")
            .or_else(|| row.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("-");
        let details = row
            .get("command")
            .or_else(|| row.get("cwd"))
            .and_then(Value::as_str)
            .unwrap_or("-");
        println!("{id:<32} {kind:<12} {details}");
    }
}
