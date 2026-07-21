//! N-API addon for GSD.
//!
//! Exposes high-performance Rust modules to Node.js via napi-rs.
//! ```text
//! JS (packages/native) -> N-API -> Rust modules (ast, clipboard, grep, image, ...)
//! ```

#![allow(clippy::needless_pass_by_value)]
#![cfg_attr(test, allow(dead_code))]

mod ast;
mod clipboard;
mod diff;
mod directory_sync;
mod fd;
mod fs_cache;
mod git;
mod glob;
mod glob_util;
mod grep;
mod gsd_parser;
mod highlight;
mod html;
mod image;
mod json_parse;
mod projection_root_identity_lock;
mod ps;
mod sqlite_file_lock;
mod stream_process;
mod task;
mod text;
mod truncate;
mod ttsr;
mod xxhash;
