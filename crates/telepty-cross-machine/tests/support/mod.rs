#![allow(dead_code)]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    pub body: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Route {
    pub method: &'static str,
    pub path: &'static str,
    pub status: u16,
    pub body: &'static str,
}

pub struct MockServer {
    addr: SocketAddr,
    handle: Option<JoinHandle<()>>,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
}

impl MockServer {
    pub fn spawn(routes: Vec<Route>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("mock server addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_requests = Arc::clone(&requests);
        let handle = thread::spawn(move || {
            for route in routes {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                handle_stream(stream, route, &thread_requests);
            }
        });
        Self {
            addr,
            handle: Some(handle),
            requests,
        }
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn requests(&self) -> Vec<CapturedRequest> {
        self.requests.lock().expect("requests lock").clone()
    }

    pub fn join(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.join().expect("mock server thread");
        }
    }
}

pub fn temp_home(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "telepty-cross-machine-{label}-{}-{nanos}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(path.join(".telepty")).expect("create temp home");
    path
}

pub fn bin_command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_telepty-cross-machine-bin"))
}

pub fn write_peers(home: &std::path::Path, json: &str) {
    let dir = home.join(".telepty");
    fs::create_dir_all(&dir).expect("create .telepty");
    fs::write(dir.join("peers.json"), json).expect("write peers fixture");
}

fn handle_stream(mut stream: TcpStream, route: Route, requests: &Arc<Mutex<Vec<CapturedRequest>>>) {
    let raw = read_request(&mut stream);
    let (method, path) = parse_request_line(&raw);
    let body = request_body(&raw);
    let token = header_value(&raw, "x-telepty-token");
    requests
        .lock()
        .expect("requests lock")
        .push(CapturedRequest {
            method: method.clone(),
            path: path.clone(),
            body,
            token,
        });

    let (status, body) = if method == route.method && path == route.path {
        (route.status, route.body)
    } else {
        (404, r#"{"error":"not found"}"#)
    };
    let reason = if status == 200 { "OK" } else { "ERROR" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .expect("write mock response");
}

fn read_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let n = stream.read(&mut chunk).expect("read mock request");
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(header_end) = find_header_end(&buffer) {
            let content_length = content_length(&buffer[..header_end]).unwrap_or(0);
            if buffer.len() >= header_end + 4 + content_length {
                break;
            }
        }
    }
    buffer
}

fn parse_request_line(raw: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(raw);
    let line = text.lines().next().unwrap_or_default();
    let mut parts = line.split_whitespace();
    (
        parts.next().unwrap_or_default().to_string(),
        parts.next().unwrap_or_default().to_string(),
    )
}

fn request_body(raw: &[u8]) -> String {
    let Some(header_end) = find_header_end(raw) else {
        return String::new();
    };
    String::from_utf8_lossy(&raw[header_end + 4..]).to_string()
}

fn header_value(raw: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let needle = format!("{}:", name.to_ascii_lowercase());
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with(&needle) {
            return line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string());
        }
    }
    None
}

fn content_length(headers: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(headers);
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            return line
                .split_once(':')
                .and_then(|(_, value)| value.trim().parse::<usize>().ok());
        }
    }
    None
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}
