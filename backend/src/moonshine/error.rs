//! Port of `app/src-tauri/src/moonshine/error.rs` (verbatim).

use std::fmt;

#[derive(Debug)]
pub struct MoonshineError {
    pub code: i32,
    pub message: String,
}

impl MoonshineError {
    pub fn from_code(code: i32) -> Self {
        unsafe {
            let ptr = moonshine_sys::moonshine_error_to_string(code);
            let message = if ptr.is_null() {
                "Unknown error".to_string()
            } else {
                std::ffi::CStr::from_ptr(ptr)
                    .to_string_lossy()
                    .into_owned()
            };
            MoonshineError { code, message }
        }
    }
}

impl fmt::Display for MoonshineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Moonshine error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for MoonshineError {}

impl From<MoonshineError> for String {
    fn from(e: MoonshineError) -> String {
        e.to_string()
    }
}
