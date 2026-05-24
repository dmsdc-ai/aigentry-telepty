use clap::Args as ClapArgs;
use serde::Serialize;
use telepty_cross_machine::peers::{load_peers, peers_path, PeerEntry};
use telepty_cross_machine::Result;

#[derive(Debug, ClapArgs)]
pub struct Args {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerRow<'a> {
    name: &'a str,
    transport: &'a str,
    target: Option<&'a str>,
    host: Option<&'a str>,
    port: Option<u16>,
    machine_id: Option<&'a str>,
    last_connected: Option<&'a str>,
    has_token: bool,
}

pub async fn run(args: Args) -> Result<()> {
    let path = peers_path()?;
    let store = load_peers(&path)?;
    let rows = store
        .peers
        .iter()
        .map(|(name, entry)| row(name, entry))
        .collect::<Vec<_>>();
    if args.json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else {
        println!(
            "{:<20} {:<9} {:<24} {:<24} TOKEN",
            "NAME", "TRANSPORT", "TARGET", "MACHINE"
        );
        for row in rows {
            println!(
                "{:<20} {:<9} {:<24} {:<24} {}",
                row.name,
                row.transport,
                row.target.unwrap_or("-"),
                row.machine_id.unwrap_or("-"),
                if row.has_token { "yes" } else { "no" }
            );
        }
    }
    Ok(())
}

fn row<'a>(name: &'a str, entry: &'a PeerEntry) -> PeerRow<'a> {
    PeerRow {
        name,
        transport: entry.transport.as_str(),
        target: entry.target.as_deref(),
        host: entry.host.as_deref(),
        port: entry.port,
        machine_id: entry.machine_id.as_deref(),
        last_connected: entry.last_connected.as_deref(),
        has_token: entry.token.is_some(),
    }
}
