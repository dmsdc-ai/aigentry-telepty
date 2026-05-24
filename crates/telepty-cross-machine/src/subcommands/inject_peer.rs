use std::io::Read;

use clap::{ArgGroup, Args as ClapArgs};
use telepty_cross_machine::http_transport::HttpTransport;
use telepty_cross_machine::peers::{load_peers, peers_path};
use telepty_cross_machine::{CrossMachineError, Result};

#[derive(Debug, ClapArgs)]
#[command(group(
    ArgGroup::new("input")
        .required(true)
        .args(["text", "stdin"])
))]
pub struct Args {
    pub peer_name: String,
    pub sid: String,
    #[arg(long)]
    pub text: Option<String>,
    #[arg(long)]
    pub stdin: bool,
}

pub async fn run(args: Args) -> Result<()> {
    let text = if args.stdin {
        let mut value = String::new();
        std::io::stdin().read_to_string(&mut value)?;
        value
    } else {
        args.text.unwrap_or_default()
    };
    let bytes = text.len();

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
    let _ = transport
        .inject(host, port, &args.sid, &text, peer.token.as_deref())
        .await?;
    println!(
        "OK injected to {}@{} ({} bytes)",
        args.sid, args.peer_name, bytes
    );
    Ok(())
}
