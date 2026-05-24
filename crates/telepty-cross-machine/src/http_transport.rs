use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::addressing::build_daemon_url_from_parts;
use crate::error::{CrossMachineError, Result};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub machine_id: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new() -> Result<Self> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|err| CrossMachineError::Unreachable(err.to_string()))?;
        Ok(Self { client })
    }

    pub async fn health(&self, host: &str, port: u16) -> Result<()> {
        let url = format!("{}/api/health", build_daemon_url_from_parts(host, port));
        let res = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(map_reqwest_error)?;
        if !res.status().is_success() {
            return Err(CrossMachineError::HttpStatus {
                url,
                status: res.status().as_u16(),
            });
        }
        Ok(())
    }

    pub async fn meta(&self, host: &str, port: u16, token: Option<&str>) -> Result<Meta> {
        let url = format!("{}/api/meta", build_daemon_url_from_parts(host, port));
        let mut request = self.client.get(&url).timeout(Duration::from_secs(3));
        if let Some(token) = token {
            request = request.header("x-telepty-token", token);
        }
        let res = request.send().await.map_err(map_reqwest_error)?;
        if !res.status().is_success() {
            return Err(CrossMachineError::HttpStatus {
                url,
                status: res.status().as_u16(),
            });
        }
        res.json::<Meta>().await.map_err(map_reqwest_error)
    }

    pub async fn list_sessions(&self, host: &str, port: u16, token: Option<&str>) -> Result<Value> {
        let url = format!("{}/api/sessions", build_daemon_url_from_parts(host, port));
        let mut request = self.client.get(&url).timeout(Duration::from_secs(3));
        if let Some(token) = token {
            request = request.header("x-telepty-token", token);
        }
        let res = request.send().await.map_err(map_reqwest_error)?;
        if !res.status().is_success() {
            return Err(CrossMachineError::HttpStatus {
                url,
                status: res.status().as_u16(),
            });
        }
        res.json::<Value>().await.map_err(map_reqwest_error)
    }

    pub async fn inject(
        &self,
        host: &str,
        port: u16,
        sid: &str,
        text: &str,
        token: Option<&str>,
    ) -> Result<Value> {
        let url = format!(
            "{}/api/sessions/{}/inject",
            build_daemon_url_from_parts(host, port),
            encode_path_segment(sid)
        );
        let mut request = self
            .client
            .post(&url)
            .timeout(Duration::from_secs(5))
            .json(&serde_json::json!({ "prompt": text }));
        if let Some(token) = token {
            request = request.header("x-telepty-token", token);
        }
        let res = request.send().await.map_err(map_reqwest_error)?;
        if !res.status().is_success() {
            return Err(CrossMachineError::HttpStatus {
                url,
                status: res.status().as_u16(),
            });
        }
        res.json::<Value>().await.map_err(map_reqwest_error)
    }
}

fn map_reqwest_error(err: reqwest::Error) -> CrossMachineError {
    if err.is_decode() {
        CrossMachineError::Schema(err.to_string())
    } else {
        CrossMachineError::Unreachable(err.to_string())
    }
}

fn encode_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::encode_path_segment;

    #[test]
    fn encodes_session_id_as_path_segment() {
        assert_eq!(encode_path_segment("a/b c"), "a%2Fb%20c");
    }
}
