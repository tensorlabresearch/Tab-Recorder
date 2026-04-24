// Tab Recorder Desktop - Audio Module
// Handles system audio capture, microphone capture, and audio mixing

use std::sync::Arc;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use anyhow::{Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

mod capture;
mod mixer;
mod platform;

pub use capture::{AudioCapture, CaptureConfig};
pub use mixer::{AudioMixer, MixConfig};

/// Audio capture manager that handles system and microphone audio
pub struct AudioCaptureManager {
    /// Configuration for audio capture
    config: CaptureConfig,
    /// Active system audio capture
    system_capture: Option<Arc<RwLock<AudioCapture>>>,
    /// Active microphone capture
    mic_capture: Option<Arc<RwLock<AudioCapture>>>,
    /// Audio mixer for combining streams
    mixer: Option<Arc<RwLock<AudioMixer>>>,
    /// Whether currently recording
    is_recording: bool,
    /// Output file path
    output_path: Option<std::path::PathBuf>,
}

impl AudioCaptureManager {
    /// Create a new audio capture manager
    pub fn new() -> Self {
        Self {
            config: CaptureConfig::default(),
            system_capture: None,
            mic_capture: None,
            mixer: None,
            is_recording: false,
            output_path: None,
        }
    }

    /// Check if currently recording
    pub fn is_recording(&self) -> bool {
        self.is_recording
    }

    /// Get available audio devices
    pub fn get_devices(&self) -> Result<AudioDevices> {
        let host = cpal::default_host();

        // Get output devices (for system audio loopback)
        let output_devices: Vec<AudioDevice> = host.output_devices()?
            .filter_map(|d| {
                d.name().ok().map(|name| AudioDevice {
                    id: name.clone(),
                    name,
                    device_type: DeviceType::System,
                    is_default: false,
                })
            })
            .collect();

        // Get input devices (for microphone)
        let input_devices: Vec<AudioDevice> = host.input_devices()?
            .filter_map(|d| {
                d.name().ok().map(|name| AudioDevice {
                    id: name.clone(),
                    name,
                    device_type: DeviceType::Microphone,
                    is_default: false,
                })
            })
            .collect();

        Ok(AudioDevices {
            system: output_devices,
            microphones: input_devices,
        })
    }

    /// Start recording with the specified configuration
    pub async fn start_recording(&mut self, config: RecordingConfig) -> Result<()> {
        if self.is_recording {
            return Err(anyhow!("Already recording"));
        }

        log::info!("Starting audio recording with config: {:?}", config);

        // Create capture configuration
        let capture_config = CaptureConfig {
            sample_rate: config.sample_rate.unwrap_or(48000),
            channels: config.channels.unwrap_or(2),
            buffer_size: config.buffer_size.unwrap_or(1024),
        };

        // Initialize system audio capture
        let system_capture = AudioCapture::new_system_capture(&capture_config).await?;
        self.system_capture = Some(Arc::new(RwLock::new(system_capture)));

        // Initialize microphone capture if requested
        if config.include_microphone {
            let mic_capture = AudioCapture::new_microphone_capture(&capture_config, config.microphone_device.as_deref()).await?;
            self.mic_capture = Some(Arc::new(RwLock::new(mic_capture)));
        }

        // Initialize mixer to combine streams
        let mixer_config = MixConfig {
            system_volume: config.system_volume.unwrap_or(1.0),
            mic_volume: config.mic_volume.unwrap_or(1.0),
        };
        let mixer = AudioMixer::new(mixer_config);
        self.mixer = Some(Arc::new(RwLock::new(mixer)));

        // Set output path
        self.output_path = Some(std::path::PathBuf::from(&config.output_path));

        // Start captures
        if let Some(ref capture) = self.system_capture {
            capture.write().await.start().await?;
        }

        if let Some(ref capture) = self.mic_capture {
            capture.write().await.start().await?;
        }

        self.is_recording = true;
        log::info!("Audio recording started successfully");

        Ok(())
    }

    /// Stop recording and save the file
    pub async fn stop_recording(&mut self) -> Result<String> {
        if !self.is_recording {
            return Err(anyhow!("Not currently recording"));
        }

        log::info!("Stopping audio recording");

        // Stop captures
        if let Some(ref capture) = self.system_capture {
            capture.write().await.stop().await?;
        }

        if let Some(ref capture) = self.mic_capture {
            capture.write().await.stop().await?;
        }

        // Mix and save audio
        let output_path = self.output_path.take().ok_or_else(|| anyhow!("No output path set"))?;

        // Get audio data from captures
        let system_data = if let Some(ref capture) = self.system_capture {
            capture.write().await.get_recorded_data().await?
        } else {
            Vec::new()
        };

        let mic_data = if let Some(ref capture) = self.mic_capture {
            capture.write().await.get_recorded_data().await?
        } else {
            Vec::new()
        };

        // Mix the audio streams
        if let Some(ref mixer) = self.mixer {
            let mixed_data = mixer.write().await.mix(&system_data, &mic_data).await?;

            // Save to WAV file
            save_wav_file(&output_path, &mixed_data, self.config.sample_rate, self.config.channels)?;
        }

        // Clean up
        self.system_capture = None;
        self.mic_capture = None;
        self.mixer = None;
        self.is_recording = false;

        log::info!("Audio recording saved to: {:?}", output_path);

        Ok(output_path.to_string_lossy().to_string())
    }

    /// Get current recording status
    pub fn get_status(&self) -> RecordingStatus {
        RecordingStatus {
            is_recording: self.is_recording,
            duration_ms: None, // TODO: Track duration
            output_path: self.output_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        }
    }

    /// Set system audio volume (0.0 to 1.0)
    pub fn set_system_volume(&mut self, volume: f32) -> Result<()> {
        if let Some(ref mixer) = self.mixer {
            // This would need to be async in production
            // For now, just update the config
            log::info!("Setting system volume to: {}", volume);
        }
        Ok(())
    }
}

/// Save audio data to a WAV file
fn save_wav_file(path: &std::path::Path, data: &[f32], sample_rate: u32, channels: u16) -> Result<()> {
    use hound::{WavSpec, WavWriter};
    use std::i16;

    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(path, spec)?;

    // Convert f32 samples to i16 and write
    for &sample in data {
        let int_sample = (sample * i16::MAX as f32) as i16;
        writer.write_sample(int_sample)?;
    }

    writer.finalize()?;
    Ok(())
}

/// Audio device information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    /// Device ID
    pub id: String,
    /// Device name
    pub name: String,
    /// Device type
    pub device_type: DeviceType,
    /// Whether this is the default device
    pub is_default: bool,
}

/// Device type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceType {
    /// System audio output (requires loopback)
    System,
    /// Microphone input
    Microphone,
}

/// Collection of available audio devices
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevices {
    /// System audio output devices
    pub system: Vec<AudioDevice>,
    /// Microphone input devices
    pub microphones: Vec<AudioDevice>,
}

/// Recording configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    /// Output file path
    pub output_path: String,
    /// Whether to include microphone audio
    pub include_microphone: bool,
    /// Specific microphone device to use (None for default)
    pub microphone_device: Option<String>,
    /// Sample rate (default: 48000)
    pub sample_rate: Option<u32>,
    /// Number of channels (default: 2 for stereo)
    pub channels: Option<u16>,
    /// Buffer size (default: 1024)
    pub buffer_size: Option<usize>,
    /// System audio volume (0.0 to 1.0, default: 1.0)
    pub system_volume: Option<f32>,
    /// Microphone volume (0.0 to 1.0, default: 1.0)
    pub mic_volume: Option<f32>,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            output_path: String::new(),
            include_microphone: true,
            microphone_device: None,
            sample_rate: Some(48000),
            channels: Some(2),
            buffer_size: Some(1024),
            system_volume: Some(1.0),
            mic_volume: Some(1.0),
        }
    }
}

/// Recording status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingStatus {
    /// Whether currently recording
    pub is_recording: bool,
    /// Recording duration in milliseconds
    pub duration_ms: Option<u64>,
    /// Output file path
    pub output_path: Option<String>,
}
