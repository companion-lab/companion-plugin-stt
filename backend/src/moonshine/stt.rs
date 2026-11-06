//! Port of `app/src-tauri/src/moonshine/stt.rs` (verbatim).

use super::error::MoonshineError;
use super::types::*;

pub struct MoonshineTranscriber {
    handle: i32,
}

impl MoonshineTranscriber {
    pub fn load(model_path: &str, model_arch: u32) -> Result<Self, MoonshineError> {
        let path = std::ffi::CString::new(model_path).unwrap();
        let handle = unsafe {
            moonshine_sys::moonshine_load_transcriber_from_files(
                path.as_ptr(),
                model_arch,
                std::ptr::null(),
                0u64,
                moonshine_sys::MOONSHINE_HEADER_VERSION as i32,
            )
        };
        if handle < 0 {
            return Err(MoonshineError::from_code(handle));
        }
        Ok(MoonshineTranscriber { handle })
    }

    pub fn transcribe_without_streaming(
        &mut self,
        audio: &[f32],
        sample_rate: i32,
    ) -> Result<TranscriptResult, MoonshineError> {
        let mut transcript_ptr: *mut moonshine_sys::transcript_t = std::ptr::null_mut();
        let error = unsafe {
            moonshine_sys::moonshine_transcribe_without_streaming(
                self.handle,
                audio.as_ptr() as *mut f32,
                audio.len() as u64,
                sample_rate,
                0,
                &mut transcript_ptr,
            )
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        if transcript_ptr.is_null() {
            return Err(MoonshineError {
                code: -1,
                message: "Null transcript".to_string(),
            });
        }
        let result = unsafe { transcript_to_result(&*transcript_ptr) };
        Ok(result)
    }

    pub fn create_stream(&self, flags: u32) -> Result<StreamHandle, MoonshineError> {
        let stream = unsafe {
            moonshine_sys::moonshine_create_stream(self.handle, flags)
        };
        if stream < 0 {
            return Err(MoonshineError::from_code(stream));
        }
        Ok(StreamHandle {
            transcriber_handle: self.handle,
            stream_handle: stream,
        })
    }

    #[allow(dead_code)]
    pub fn set_keyterms(&self, terms: &str) -> Result<(), MoonshineError> {
        let c_terms = std::ffi::CString::new(terms).unwrap();
        let error = unsafe {
            moonshine_sys::moonshine_transcriber_set_keyterms(self.handle, c_terms.as_ptr())
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub fn set_context(&self, context: &str, max_terms: i32) -> Result<(), MoonshineError> {
        let c_ctx = std::ffi::CString::new(context).unwrap();
        let error = unsafe {
            moonshine_sys::moonshine_transcriber_set_context(self.handle, c_ctx.as_ptr(), max_terms)
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub fn handle(&self) -> i32 {
        self.handle
    }
}

impl Drop for MoonshineTranscriber {
    fn drop(&mut self) {
        unsafe {
            moonshine_sys::moonshine_free_transcriber(self.handle);
        }
    }
}

pub struct StreamHandle {
    transcriber_handle: i32,
    stream_handle: i32,
}

impl StreamHandle {
    pub fn transcriber_handle(&self) -> i32 {
        self.transcriber_handle
    }

    pub fn stream_handle(&self) -> i32 {
        self.stream_handle
    }

    pub fn start(&self) -> Result<(), MoonshineError> {
        let error = unsafe {
            moonshine_sys::moonshine_start_stream(self.transcriber_handle, self.stream_handle)
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        Ok(())
    }

    pub fn add_audio(&self, audio: &[f32], sample_rate: i32) -> Result<(), MoonshineError> {
        let error = unsafe {
            moonshine_sys::moonshine_transcribe_add_audio_to_stream(
                self.transcriber_handle,
                self.stream_handle,
                audio.as_ptr(),
                audio.len() as u64,
                sample_rate,
                0,
            )
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        Ok(())
    }

    pub fn transcribe(&self, flags: u32) -> Result<TranscriptResult, MoonshineError> {
        let mut transcript_ptr: *mut moonshine_sys::transcript_t = std::ptr::null_mut();
        let error = unsafe {
            moonshine_sys::moonshine_transcribe_stream(
                self.transcriber_handle,
                self.stream_handle,
                flags,
                &mut transcript_ptr,
            )
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        if transcript_ptr.is_null() {
            return Ok(TranscriptResult { lines: vec![] });
        }
        let result = unsafe { transcript_to_result(&*transcript_ptr) };
        Ok(result)
    }

    pub fn stop(&self) -> Result<TranscriptResult, MoonshineError> {
        let error = unsafe {
            moonshine_sys::moonshine_stop_stream(self.transcriber_handle, self.stream_handle)
        };
        if error != 0 {
            return Err(MoonshineError::from_code(error));
        }
        // Drain remaining audio
        self.transcribe(0)
    }
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        unsafe {
            moonshine_sys::moonshine_free_stream(self.transcriber_handle, self.stream_handle);
        }
    }
}

unsafe fn transcript_to_result(transcript: &moonshine_sys::transcript_t) -> TranscriptResult {
    let mut lines = Vec::with_capacity(transcript.line_count as usize);
    for i in 0..transcript.line_count as usize {
        let line = &*transcript.lines.add(i);
        let text = if line.text.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(line.text)
                .to_string_lossy()
                .into_owned()
        };
        let mut words = Vec::new();
        if !line.words.is_null() && line.word_count > 0 {
            for w in 0..line.word_count as usize {
                let word = &*line.words.add(w);
                let w_text = if word.text.is_null() {
                    String::new()
                } else {
                    std::ffi::CStr::from_ptr(word.text)
                        .to_string_lossy()
                        .into_owned()
                };
                words.push(TranscriptWord {
                    text: w_text,
                    start: word.start,
                    end: word.end,
                    confidence: word.confidence,
                });
            }
        }
        lines.push(TranscriptLine {
            text,
            start_time: line.start_time,
            duration: line.duration,
            is_complete: line.is_complete != 0,
            id: line.id,
            words,
            last_transcription_latency_ms: line.last_transcription_latency_ms,
        });
    }
    TranscriptResult { lines }
}
