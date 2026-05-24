use std::fmt;

pub type Result<T> = std::result::Result<T, CrossMachineError>;

#[derive(Debug)]
pub enum CrossMachineError {
    WrongTransport { name: String, transport: String },
    Unreachable(String),
    PeerNotFound(String),
    InvalidPeer { name: String, details: String },
    HttpStatus { url: String, status: u16 },
    Schema(String),
    Parse(String),
    Io(std::io::Error),
}

impl CrossMachineError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::WrongTransport { .. } => 4,
            Self::Unreachable(_) => 5,
            _ => 1,
        }
    }
}

impl fmt::Display for CrossMachineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongTransport { name, transport } if transport == "ssh" => write!(
                f,
                "ERR peer \"{name}\" is SSH transport; not supported by this binary (use JS path)"
            ),
            Self::WrongTransport { name, transport } => write!(
                f,
                "ERR peer \"{name}\" uses unsupported transport \"{transport}\"; not supported by this binary"
            ),
            Self::Unreachable(details) => write!(f, "ERR peer unreachable: {details}"),
            Self::PeerNotFound(name) => write!(f, "ERR peer \"{name}\" not found"),
            Self::InvalidPeer { name, details } => {
                write!(f, "ERR peer \"{name}\" is invalid: {details}")
            }
            Self::HttpStatus { url, status } => {
                write!(f, "ERR {url} returned HTTP {status}")
            }
            Self::Schema(details) => write!(f, "ERR schema error: {details}"),
            Self::Parse(details) => write!(f, "ERR parse error: {details}"),
            Self::Io(err) => write!(f, "ERR io error: {err}"),
        }
    }
}

impl std::error::Error for CrossMachineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for CrossMachineError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for CrossMachineError {
    fn from(value: serde_json::Error) -> Self {
        Self::Schema(value.to_string())
    }
}
