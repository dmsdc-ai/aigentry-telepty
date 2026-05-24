use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::atomic_write::write_atomic_bytes;
use crate::error::{CrossMachineError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Ssh,
    Http,
}

impl Default for Transport {
    fn default() -> Self {
        Self::Ssh
    }
}

impl Transport {
    pub fn is_ssh(&self) -> bool {
        matches!(self, Self::Ssh)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Http => "http",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerEntry {
    #[serde(default, skip_serializing_if = "Transport::is_ssh")]
    pub transport: Transport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(rename = "machineId", default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(
        rename = "lastConnected",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_connected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl PeerEntry {
    pub fn http(host: String, port: u16, machine_id: String, token: Option<String>) -> Self {
        Self {
            transport: Transport::Http,
            target: Some(format!("{host}:{port}")),
            host: Some(host),
            port: Some(port),
            machine_id: Some(machine_id),
            last_connected: Some(now_rfc3339()),
            token,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerStore {
    #[serde(default)]
    pub peers: BTreeMap<String, PeerEntry>,
}

impl PeerStore {
    pub fn require_http_peer(&self, name: &str) -> Result<&PeerEntry> {
        let entry = self
            .peers
            .get(name)
            .ok_or_else(|| CrossMachineError::PeerNotFound(name.to_string()))?;
        if entry.transport != Transport::Http {
            return Err(CrossMachineError::WrongTransport {
                name: name.to_string(),
                transport: entry.transport.as_str().to_string(),
            });
        }
        if entry.host.as_deref().unwrap_or("").is_empty() || entry.port.is_none() {
            return Err(CrossMachineError::InvalidPeer {
                name: name.to_string(),
                details: "HTTP peer requires host and port".to_string(),
            });
        }
        Ok(entry)
    }
}

pub fn peers_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| CrossMachineError::Parse("HOME env unset".to_string()))?;
    Ok(PathBuf::from(home).join(".telepty").join("peers.json"))
}

pub fn load_peers(path: &Path) -> Result<PeerStore> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(PeerStore::default()),
        Err(err) => Err(err.into()),
    }
}

pub fn save_peers(path: &Path, store: &PeerStore) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(store)?;
    write_atomic_bytes(path, &bytes)
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
