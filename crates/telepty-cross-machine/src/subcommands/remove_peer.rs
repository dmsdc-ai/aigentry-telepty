use clap::Args as ClapArgs;
use telepty_cross_machine::peers::{load_peers, peers_path, save_peers};
use telepty_cross_machine::Result;

#[derive(Debug, ClapArgs)]
pub struct Args {
    pub peer_name: String,
}

pub async fn run(args: Args) -> Result<()> {
    let path = peers_path()?;
    let mut store = load_peers(&path)?;
    store.peers.remove(&args.peer_name);
    save_peers(&path, &store)?;
    println!("OK peer \"{}\" removed", args.peer_name);
    Ok(())
}
