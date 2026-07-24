use napi::{Error, Result, Status};
use napi_derive::napi;
use std::fs::OpenOptions;

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

#[napi]
pub fn sync_directory_entry(path: String) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options
        .write(true)
        .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
        .custom_flags(0x0200_0000);
    let directory = options.open(path).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not open directory durability handle: {error}"),
        )
    })?;
    directory.sync_all().map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not flush directory durability handle: {error}"),
        )
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::sync_directory_entry;
    use std::fs::{create_dir, remove_dir};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn syncs_directory_with_write_capable_handle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gsd-directory-sync-{nonce}"));
        create_dir(&path).unwrap();
        let result = sync_directory_entry(path.to_string_lossy().into_owned());
        remove_dir(path).unwrap();
        assert!(result.is_ok(), "{result:?}");
    }
}
