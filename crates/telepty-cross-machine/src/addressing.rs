use crate::error::{CrossMachineError, Result};

pub const DEFAULT_PORT: u16 = 3848;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostSpec {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTarget {
    pub session_id: String,
    pub host: String,
    pub port: u16,
}

pub fn parse_host_spec(value: &str, default_port: u16) -> HostSpec {
    let mut raw = value.trim().to_string();
    if raw.is_empty() {
        return HostSpec {
            host: "127.0.0.1".to_string(),
            port: default_port,
        };
    }

    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("http://") {
        raw = raw[7..].to_string();
    } else if lower.starts_with("https://") {
        raw = raw[8..].to_string();
    }

    if let Some((head, _)) = raw.split_once('/') {
        raw = head.to_string();
    }

    if let Some(spec) = parse_bracketed_ipv6(&raw, default_port) {
        return spec;
    }

    let colon_count = raw.matches(':').count();
    if colon_count > 1 {
        return HostSpec {
            host: raw,
            port: default_port,
        };
    }

    if let Some((host, port)) = raw.rsplit_once(':') {
        if !host.is_empty() && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(port) = port.parse::<u16>() {
                return HostSpec {
                    host: host.to_string(),
                    port,
                };
            }
        }
    }

    HostSpec {
        host: raw,
        port: default_port,
    }
}

fn parse_bracketed_ipv6(raw: &str, default_port: u16) -> Option<HostSpec> {
    if !raw.starts_with('[') {
        return None;
    }
    let end = raw.find(']')?;
    let host = &raw[1..end];
    let rest = &raw[end + 1..];
    if rest.is_empty() {
        return Some(HostSpec {
            host: host.to_string(),
            port: default_port,
        });
    }
    let port = rest.strip_prefix(':')?;
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let port = port.parse::<u16>().ok()?;
    Some(HostSpec {
        host: host.to_string(),
        port,
    })
}

pub fn format_host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub fn build_daemon_url(value: &str, default_port: u16) -> String {
    let spec = parse_host_spec(value, default_port);
    build_daemon_url_from_parts(&spec.host, spec.port)
}

pub fn build_daemon_url_from_parts(host: &str, port: u16) -> String {
    format!("http://{}:{port}", format_host_for_url(host))
}

pub fn build_daemon_ws_url(value: &str, default_port: u16) -> String {
    let spec = parse_host_spec(value, default_port);
    build_daemon_ws_url_from_parts(&spec.host, spec.port)
}

pub fn build_daemon_ws_url_from_parts(host: &str, port: u16) -> String {
    format!("ws://{}:{port}", format_host_for_url(host))
}

pub fn parse_session_target(value: &str, default_port: u16) -> Result<SessionTarget> {
    let (session_id, host_spec) = value.rsplit_once('@').ok_or_else(|| {
        CrossMachineError::Parse("expected <session-id>@<host>:<port>".to_string())
    })?;
    if session_id.is_empty() {
        return Err(CrossMachineError::Parse(
            "session id before @ must not be empty".to_string(),
        ));
    }
    if host_spec.trim().is_empty() {
        return Err(CrossMachineError::Parse(
            "host after @ must not be empty".to_string(),
        ));
    }
    let spec = parse_host_spec(host_spec, default_port);
    Ok(SessionTarget {
        session_id: session_id.to_string(),
        host: spec.host,
        port: spec.port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_target_at_last_at() {
        let target = parse_session_target("sid@with-at@127.0.0.1:4848", DEFAULT_PORT).unwrap();
        assert_eq!(target.session_id, "sid@with-at");
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 4848);
    }
}
