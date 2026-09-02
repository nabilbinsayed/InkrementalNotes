// inkwell-app/src-tauri/src/stylus_linux.rs
// Native Linux evdev hardware stylus stream for Inkwell.
// Reads raw absolute pressure, contact, and tool state directly from kernel evdev device nodes.

use serde::Serialize;
use tauri::ipc::Channel;

#[cfg(target_os = "linux")]
use std::fs::{self, OpenOptions};
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(target_os = "linux")]
use std::os::unix::io::AsRawFd;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Copy, Clone, Default, Debug)]
struct InputEvent {
    tv_sec: u64,
    tv_usec: u64,
    type_: u16,
    code: u16,
    value: i32,
}

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Copy, Clone, Default, Debug)]
struct InputAbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct KernelTimespec {
    tv_sec: i64,
    tv_nsec: i64,
}

#[cfg(target_os = "linux")]
extern "C" {
    fn clock_gettime(clk_id: i32, tp: *mut KernelTimespec) -> i32;
    fn ioctl(fd: std::os::raw::c_int, request: std::os::raw::c_ulong, ...) -> std::os::raw::c_int;
}

// IOCTL command definitions
#[cfg(target_os = "linux")]
const EVIOCGNAME_256: std::os::raw::c_ulong = 0x80ff4506;
#[cfg(target_os = "linux")]
const EVIOCGBIT_EV_ABS: std::os::raw::c_ulong = 0x80084523; // EV_ABS = 3
#[cfg(target_os = "linux")]
const EVIOCGABS_PRESSURE: std::os::raw::c_ulong = 0x80184558; // 0x40 + ABS_PRESSURE (0x18) = 0x58
#[cfg(target_os = "linux")]
const EVIOCSCLOCKID: std::os::raw::c_ulong = 0x400445a0; // Set evdev clock domain

#[allow(dead_code)]
const EVIOCGABS_X: std::os::raw::c_ulong = 0x80184540;
#[allow(dead_code)]
const EVIOCGABS_Y: std::os::raw::c_ulong = 0x80184541;

#[cfg(target_os = "linux")]
const CLOCK_MONOTONIC: i32 = 1;
#[cfg(target_os = "linux")]
const O_NONBLOCK: i32 = 0x800; // Linux O_NONBLOCK (octal 04000)

// Event constants
#[cfg(target_os = "linux")]
const EV_SYN: u16 = 0x00;
#[cfg(target_os = "linux")]
const EV_KEY: u16 = 0x01;
#[cfg(target_os = "linux")]
const EV_ABS: u16 = 0x03;

#[cfg(target_os = "linux")]
const SYN_REPORT: u16 = 0x00;
#[cfg(target_os = "linux")]
const ABS_X: u16 = 0x00;
#[cfg(target_os = "linux")]
const ABS_Y: u16 = 0x01;
#[cfg(target_os = "linux")]
const ABS_PRESSURE: u16 = 0x18;

#[cfg(target_os = "linux")]
const BTN_TOOL_PEN: u16 = 0x140;
#[cfg(target_os = "linux")]
const BTN_TOOL_RUBBER: u16 = 0x141;
#[cfg(target_os = "linux")]
const BTN_TOUCH: u16 = 0x14a;

#[derive(Debug, Clone, Serialize)]
pub struct NativeStylusSample {
    pub timestamp_us: u64,
    pub pressure: f32,
    pub x: i32,
    pub y: i32,
    pub down: bool,
    pub tool: u8, // 1 = pen, 2 = eraser
    pub device_name: String,
    pub device_path: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum StylusMessage {
    #[serde(rename = "handshake")]
    Handshake {
        kernel_timestamp_us: u64,
        device_name: String,
        device_path: String,
        pressure_min: i32,
        pressure_max: i32,
    },
    #[serde(rename = "sample")]
    Sample(NativeStylusSample),
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone)]
struct TargetDevice {
    path: String,
    name: String,
    score: i32,
    min_pressure: i32,
    max_pressure: i32,
}

#[cfg(target_os = "linux")]
fn get_kernel_monotonic_us() -> u64 {
    let mut ts = KernelTimespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe {
        clock_gettime(CLOCK_MONOTONIC, &mut ts);
    }
    (ts.tv_sec as u64) * 1_000_000 + (ts.tv_nsec as u64 / 1_000)
}

#[cfg(target_os = "linux")]
fn discover_best_tablet() -> Option<TargetDevice> {
    let mut candidates: Vec<TargetDevice> = Vec::new();

    let paths = match fs::read_dir("/dev/input") {
        Ok(p) => p,
        Err(_) => return None,
    };

    for entry in paths.flatten() {
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !file_name.starts_with("event") {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        let file = match OpenOptions::new().read(true).custom_flags(O_NONBLOCK).open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let fd = file.as_raw_fd();

        // 1. Check if EV_ABS is supported and ABS_PRESSURE is available
        let mut abs_bits = [0u8; 8];
        let ret = unsafe { ioctl(fd, EVIOCGBIT_EV_ABS, abs_bits.as_mut_ptr()) };
        if ret < 0 {
            continue;
        }

        // ABS_PRESSURE is bit 24 -> byte index 3, bit 0
        let has_pressure = (abs_bits[3] & 0x01) != 0;
        if !has_pressure {
            continue;
        }

        // 2. Query device name
        let mut name_buf = [0u8; 256];
        let _ = unsafe { ioctl(fd, EVIOCGNAME_256, name_buf.as_mut_ptr()) };
        let name_end = name_buf.iter().position(|&b| b == 0).unwrap_or(name_buf.len());
        let name = String::from_utf8_lossy(&name_buf[..name_end]).trim().to_string();

        // 3. Query pressure bounds
        let mut abs_info = InputAbsInfo::default();
        let _ = unsafe { ioctl(fd, EVIOCGABS_PRESSURE, &mut abs_info) };
        let min_p = abs_info.minimum;
        let mut max_p = abs_info.maximum;
        if max_p <= min_p {
            max_p = 65535;
        }

        // 4. Score device
        let name_lower = name.to_lowercase();
        let mut score = 50;
        if name_lower.contains("opentabletdriver") || name_lower.contains("virtual artist") {
            score = 100;
        } else if name_lower.contains("huion") || name_lower.contains("256c:006d") {
            score = 90;
        } else if name_lower.contains("wacom") || name_lower.contains("xp-pen") || name_lower.contains("gaomon") || name_lower.contains("ugtablet") {
            score = 80;
        } else if name_lower.contains("synaptics") || name_lower.contains("touchpad") || name_lower.contains("trackpad") {
            score = 10;
        }

        candidates.push(TargetDevice {
            path: path_str,
            name,
            score,
            min_pressure: min_p,
            max_pressure: max_p,
        });
    }

    candidates.sort_by(|a, b| b.score.cmp(&a.score));
    candidates.into_iter().next()
}

#[cfg(target_os = "linux")]
pub fn spawn_stylus_worker(channel: Channel<StylusMessage>, is_running: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("inkwell-evdev-stylus".into())
        .spawn(move || {
            let mut active_device: Option<TargetDevice> = None;

            while is_running.load(Ordering::Relaxed) {
                if active_device.is_none() {
                    active_device = discover_best_tablet();
                    if let Some(ref dev) = active_device {
                        eprintln!(
                            "[inkwell/stylus] Connected to native tablet: '{}' at '{}' (pressure: {}..{})",
                            dev.name, dev.path, dev.min_pressure, dev.max_pressure
                        );
                        let handshake = StylusMessage::Handshake {
                            kernel_timestamp_us: get_kernel_monotonic_us(),
                            device_name: dev.name.clone(),
                            device_path: dev.path.clone(),
                            pressure_min: dev.min_pressure,
                            pressure_max: dev.max_pressure,
                        };
                        let _ = channel.send(handshake);
                    } else {
                        thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                }

                let dev = active_device.as_ref().unwrap().clone();
                let file = match OpenOptions::new().read(true).open(&dev.path) {
                    Ok(f) => f,
                    Err(err) => {
                        eprintln!("[inkwell/stylus] Failed to open device {}: {err}. Retrying in 1s...", dev.path);
                        active_device = None;
                        thread::sleep(Duration::from_millis(1000));
                        continue;
                    }
                };

                let fd = file.as_raw_fd();
                let clock_id: i32 = CLOCK_MONOTONIC;
                let _ = unsafe { ioctl(fd, EVIOCSCLOCKID, &clock_id) };

                let mut reader = file;
                let mut event_buf = [0u8; std::mem::size_of::<InputEvent>()];

                let mut cur_raw_pressure = 0i32;
                let mut cur_x = 0i32;
                let mut cur_y = 0i32;
                let mut is_touch_down = false;
                let mut has_btn_touch = false;
                let mut cur_tool = 1u8; // 1 = pen, 2 = eraser
                let mut state_changed = false;

                let mut last_sent_pressure = -1.0f32;
                let mut last_sent_down = false;
                let mut last_sent_tool = 1u8;
                let mut last_sent_time = std::time::Instant::now();

                while is_running.load(Ordering::Relaxed) {
                    match reader.read_exact(&mut event_buf) {
                        Ok(()) => {
                            let ev: InputEvent = unsafe { std::ptr::read_unaligned(event_buf.as_ptr() as *const InputEvent) };

                            match ev.type_ {
                                EV_ABS => match ev.code {
                                    ABS_PRESSURE => {
                                        cur_raw_pressure = ev.value.max(0);
                                        state_changed = true;
                                    }
                                    ABS_X => {
                                        cur_x = ev.value;
                                    }
                                    ABS_Y => {
                                        cur_y = ev.value;
                                    }
                                    _ => {}
                                },
                                EV_KEY => match ev.code {
                                    BTN_TOUCH => {
                                        is_touch_down = ev.value != 0;
                                        has_btn_touch = true;
                                        if !is_touch_down {
                                            cur_raw_pressure = 0;
                                        }
                                        state_changed = true;
                                    }
                                    BTN_TOOL_RUBBER => {
                                        cur_tool = if ev.value != 0 { 2 } else { 1 };
                                        state_changed = true;
                                    }
                                    BTN_TOOL_PEN => {
                                        if ev.value != 0 {
                                            cur_tool = 1;
                                        }
                                        state_changed = true;
                                    }
                                    _ => {}
                                },
                                EV_SYN => {
                                    if ev.code == SYN_REPORT && state_changed {
                                        let is_now_down = if has_btn_touch {
                                            is_touch_down
                                        } else {
                                            cur_raw_pressure > 0
                                        };

                                        let norm_p = if is_now_down && cur_raw_pressure > dev.min_pressure {
                                            let raw_clamped = cur_raw_pressure.clamp(dev.min_pressure, dev.max_pressure);
                                            let range = (dev.max_pressure - dev.min_pressure).max(1) as f32;
                                            (raw_clamped - dev.min_pressure) as f32 / range
                                        } else {
                                            0.0f32
                                        };

                                        let down_changed = is_now_down != last_sent_down;
                                        let tool_changed = cur_tool != last_sent_tool;
                                        let pressure_changed = (norm_p - last_sent_pressure).abs() >= 0.003;
                                        let heartbeat_needed = is_now_down && last_sent_time.elapsed() >= Duration::from_millis(16);

                                        if down_changed || tool_changed || pressure_changed || heartbeat_needed {
                                            let ts_us = get_kernel_monotonic_us();

                                            let sample = NativeStylusSample {
                                                timestamp_us: ts_us,
                                                pressure: norm_p,
                                                x: cur_x,
                                                y: cur_y,
                                                down: is_now_down,
                                                tool: cur_tool,
                                                device_name: dev.name.clone(),
                                                device_path: dev.path.clone(),
                                            };

                                            if channel.send(StylusMessage::Sample(sample)).is_err() {
                                                eprintln!("[inkwell/stylus] Channel closed by frontend. Exiting stream thread.");
                                                return;
                                            }

                                            last_sent_pressure = norm_p;
                                            last_sent_down = is_now_down;
                                            last_sent_tool = cur_tool;
                                            last_sent_time = std::time::Instant::now();
                                        }

                                        state_changed = false;
                                    }
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            eprintln!("[inkwell/stylus] Read error on {}: {e}. Rescanning devices...", dev.path);
                            active_device = None;
                            break;
                        }
                    }
                }
            }
        })
        .expect("failed to spawn evdev stylus worker thread");
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_stylus_worker(_channel: Channel<StylusMessage>, _is_running: Arc<AtomicBool>) {
    // No-op on Windows/macOS where PointerEvent pressure is natively supported.
}
