//! Identity-stable SQLite file locking.

use napi::{Error, Result, Status};
use napi_derive::napi;
use std::fs::File;

#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

#[napi]
pub struct SqliteFileIdentityLock {
    file: Option<File>,
}

#[napi]
impl SqliteFileIdentityLock {
    #[napi(constructor)]
    pub fn new(path: String, create: bool) -> Result<Self> {
        #[cfg(windows)]
        {
            let mut options = OpenOptions::new();
            options
                .read(true)
                .write(create)
                .share_mode(0x0000_0001 | 0x0000_0002);
            if create {
                options.create(true);
            }
            let file = options.open(path).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("could not lock SQLite file identity: {error}"),
                )
            })?;
            return Ok(Self { file: Some(file) });
        }
        #[cfg(not(windows))]
        {
            let _ = (path, create);
            Err(Error::new(
                Status::GenericFailure,
                "SQLite file identity locking is only available on Windows".to_owned(),
            ))
        }
    }

    #[napi]
    pub fn close(&mut self) {
        self.file.take();
    }
}
