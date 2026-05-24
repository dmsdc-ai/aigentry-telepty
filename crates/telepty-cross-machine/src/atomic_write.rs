use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::Result;

/// Fsync-backed atomic write copied from
/// `crates/telepty-supervisor-core/src/manifest.rs:117-131`.
pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        crate::error::CrossMachineError::Parse(format!("path {} has no parent", path.display()))
    })?;
    fs::create_dir_all(parent)?;
    let tmp = tmp_path(path);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    fsync_dir(parent)?;
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => path.with_extension(format!("{ext}.tmp")),
        None => path.with_extension("tmp"),
    }
}

fn fsync_dir(dir: &Path) -> Result<()> {
    let f = fs::File::open(dir)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_path_preserves_json_extension() {
        assert_eq!(
            tmp_path(Path::new("/tmp/peers.json")),
            PathBuf::from("/tmp/peers.json.tmp")
        );
    }
}
