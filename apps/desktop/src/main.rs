// Tab Recorder Desktop - Main Application Entry Point
// Prevents additional console window on Windows in release builds

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;

use tauri::{Manager, RunEvent};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::audio::AudioCaptureManager;
use crate::commands::{
    start_recording, stop_recording, get_recording_status,
    get_audio_devices, set_system_volume, mix_audio_streams
};

/// Application state shared across commands
pub struct AppState {
    /// Audio capture manager for handling system audio and microphone
    audio_manager: Arc<RwLock<AudioCaptureManager>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            audio_manager: Arc::new(RwLock::new(AudioCaptureManager::new())),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            // Initialize application state
            let state = AppState::new();
            app.manage(state);

            // Log successful initialization
            log::info!("Tab Recorder Desktop initialized successfully");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            get_recording_status,
            get_audio_devices,
            set_system_volume,
            mix_audio_streams
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| match event {
            RunEvent::ExitRequested { api: _, .. } => {
                // Ensure cleanup happens before exit
                log::info!("Tab Recorder Desktop shutting down");
            }
            _ => {}
        });
}
