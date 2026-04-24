// Tab Recorder Desktop - Library Module
// Re-exports for use across the application

pub mod audio;
pub mod commands;

pub use audio::AudioCaptureManager;
pub use commands::*;
