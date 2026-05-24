use clap::Subcommand;

use telepty_cross_machine::Result;

pub mod connect_http;
pub mod inject_peer;
pub mod list_peer_sessions;
pub mod list_peers;
pub mod remove_peer;

#[derive(Debug, Subcommand)]
pub enum Command {
    ConnectHttp(connect_http::Args),
    ListPeerSessions(list_peer_sessions::Args),
    InjectPeer(inject_peer::Args),
    ListPeers(list_peers::Args),
    RemovePeer(remove_peer::Args),
}

impl Command {
    pub async fn run(self) -> Result<()> {
        match self {
            Self::ConnectHttp(args) => connect_http::run(args).await,
            Self::ListPeerSessions(args) => list_peer_sessions::run(args).await,
            Self::InjectPeer(args) => inject_peer::run(args).await,
            Self::ListPeers(args) => list_peers::run(args).await,
            Self::RemovePeer(args) => remove_peer::run(args).await,
        }
    }
}
