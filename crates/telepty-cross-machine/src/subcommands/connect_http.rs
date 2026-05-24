use clap::Args as ClapArgs;
use telepty_cross_machine::addressing::{parse_host_spec, DEFAULT_PORT};
use telepty_cross_machine::http_transport::HttpTransport;
use telepty_cross_machine::peers::{load_peers, peers_path, save_peers, PeerEntry};
use telepty_cross_machine::{CrossMachineError, Result};

#[derive(Debug, ClapArgs)]
pub struct Args {
    pub target: String,
    #[arg(long)]
    pub token: Option<String>,
    #[arg(long)]
    pub name: Option<String>,
}

pub async fn run(args: Args) -> Result<()> {
    let spec = parse_host_spec(&args.target, DEFAULT_PORT);
    if spec.host.is_empty() {
        return Err(CrossMachineError::Parse(
            "connect-http requires a host (got empty value).".to_string(),
        ));
    }

    let name = args.name.unwrap_or_else(|| default_peer_name(&spec.host));
    let transport = HttpTransport::new()?;
    transport.health(&spec.host, spec.port).await?;

    let mut machine_id = name.clone();
    if let Ok(meta) = transport
        .meta(&spec.host, spec.port, args.token.as_deref())
        .await
    {
        if let Some(id) = meta.machine_id.filter(|id| !id.is_empty()) {
            machine_id = id;
        } else if let Some(host) = meta.host.filter(|host| !host.is_empty()) {
            machine_id = host;
        }
    }

    let path = peers_path()?;
    let mut store = load_peers(&path)?;
    store.peers.insert(
        name.clone(),
        PeerEntry::http(spec.host.clone(), spec.port, machine_id.clone(), args.token),
    );
    save_peers(&path, &store)?;

    println!(
        "OK peer \"{name}\" registered (host={}:{}, machine_id={machine_id})",
        spec.host, spec.port
    );
    Ok(())
}

fn default_peer_name(host: &str) -> String {
    host.split('.')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(host)
        .to_string()
}
