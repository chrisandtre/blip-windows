//! Blip for Windows: the Tauri shell.
//!
//! Same split as Linux Blip: the TypeScript core (collector.ts, thread.ts, ...)
//! does the thinking and the Mac bridge does the talking; this process runs
//! the core the way BarWidget.qml runs it, and the web UI renders what comes
//! back. Everything the QML did with Process/execDetached goes through the
//! commands below.
//!
//! The core runs with HOME = %LOCALAPPDATA%\Blip (Blip's Windows home), so its
//! ~/.config/blip, ~/.cache/blip, ~/.local/state/blip and ~/bin shims resolve
//! there with no path changes in the core.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The core scripts the UI may run. Mirrors what the QML spawns; anything
/// else is refused before a process starts.
const CORE_SCRIPTS: &[&str] = &[
    "collector", "thread", "send-file", "fetch", "avatar", "search", "linkpreview",
    "contact-search", "contact-review", "contact-details", "contact-save", "contact-vcard", "spellcheck",
];

#[derive(Serialize)]
struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

struct Tray(Mutex<Option<TrayIcon>>);
struct Watching(AtomicBool);

fn blip_home() -> PathBuf {
    blip_wire::local_dir()
}

fn bin_dir() -> PathBuf {
    blip_home().join("bin")
}

/// How to start a core script. A packaged build ships `blip-core.exe`
/// (the core compiled with Bun) beside the app; a dev build runs the repo's
/// .ts files with the bun on PATH.
fn core_command(script: &str) -> Command {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(core) = exe_dir.map(|d| d.join("blip-core.exe")).filter(|p| p.exists()) {
        let mut c = Command::new(core);
        c.arg(script);
        return c;
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
    let mut c = Command::new("bun");
    c.arg(repo.join(format!("{script}.ts"))).current_dir(repo);
    c
}

fn prepare(c: &mut Command) {
    let home = blip_home();
    let run = home.join("run");
    let _ = std::fs::create_dir_all(&run);
    c.env("HOME", &home)
        .env("XDG_RUNTIME_DIR", &run)
        .env_remove("XDG_CACHE_HOME")
        .env_remove("XDG_CONFIG_HOME")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
}

async fn run(mut c: Command, stdin: Option<String>, timeout: Duration) -> Result<Output, String> {
    prepare(&mut c);
    let mut child = c.spawn().map_err(|e| format!("cannot start: {e}"))?;
    let mut input = child.stdin.take();
    // stdin is always closed, even when empty: the shim reads to EOF.
    let feed = async move {
        if let (Some(pipe), Some(text)) = (input.as_mut(), stdin) {
            let _ = pipe.write_all(text.as_bytes()).await;
        }
        drop(input);
    };
    let wait = async {
        feed.await;
        child.wait_with_output().await
    };
    match tokio::time::timeout(timeout, wait).await {
        Ok(Ok(o)) => Ok(Output {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timed out".into()),
    }
}

/// Run one core script: `core("collector", ["--deep"], None)`.
#[tauri::command]
async fn core(script: String, args: Vec<String>, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<Output, String> {
    if !CORE_SCRIPTS.contains(&script.as_str()) {
        return Err(format!("'{script}' is not a Blip core script"));
    }
    let mut c = core_command(&script);
    c.args(&args);
    run(c, stdin, Duration::from_millis(timeout_ms.unwrap_or(60_000))).await
}

/// Run a bridge tool directly, as the QML does for text sends.
#[tauri::command]
async fn shim(tool: String, args: Vec<String>, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<Output, String> {
    if !blip_wire::is_tool(&tool) || tool == "ping" {
        return Err(format!("'{tool}' is not a Blip tool"));
    }
    let mut c = Command::new(bin_dir().join(format!("{tool}.exe")));
    c.args(&args);
    run(c, stdin, Duration::from_millis(timeout_ms.unwrap_or(60_000))).await
}

/// `imsg watch` blocks on the Mac and prints one line per chat.db change.
/// Each line becomes a "blip://watch" event; the UI refreshes on it. The
/// watcher restarts with backoff when it exits (Mac asleep, network change).
#[tauri::command]
fn start_watch(app: AppHandle, watching: State<'_, Watching>) {
    if watching.0.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut backoff = 2u64;
        loop {
            let mut c = Command::new(bin_dir().join("imsg.exe"));
            c.arg("watch");
            prepare(&mut c);
            c.stdin(Stdio::null());
            let started = std::time::Instant::now();
            match c.spawn() {
                Ok(mut child) => {
                    let _ = app.emit("blip://watch-state", "up");
                    if let Some(out) = child.stdout.take() {
                        let mut lines = BufReader::new(out).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            let _ = app.emit("blip://watch", line);
                        }
                    }
                    let _ = child.wait().await;
                }
                Err(_) => {}
            }
            let _ = app.emit("blip://watch-state", "down");
            if started.elapsed() > Duration::from_secs(60) {
                backoff = 2;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    });
}

/// Tray state: unread count and whether the Mac answers. The icon carries the
/// iMessage-blue dot when anything is unread and dims when offline.
#[tauri::command]
fn set_status(app: AppHandle, tray: State<'_, Tray>, unread: u32, online: bool) {
    let (icon, tip): (&[u8], String) = if !online {
        (include_bytes!("../icons/tray-offline.png"), "Blip - Mac unreachable".into())
    } else if unread > 0 {
        (include_bytes!("../icons/tray-unread.png"), format!("Blip - {unread} unread"))
    } else {
        (include_bytes!("../icons/tray.png"), "Blip".into())
    };
    if let Some(t) = tray.0.lock().unwrap().as_ref() {
        if let Ok(img) = Image::from_bytes(icon) {
            let _ = t.set_icon(Some(img));
        }
        let _ = t.set_tooltip(Some(&tip));
    }
    if let Some(w) = app.get_webview_window("main") {
        let title = if unread > 0 { format!("Blip ({unread})") } else { "Blip".to_string() };
        let _ = w.set_title(&title);
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

/// A pasted image (screenshot) as a draft file for send-file.ts. Lands in
/// Blip's runtime dir (the core's $XDG_RUNTIME_DIR), is named by us, never by
/// the page, and old drafts are swept after a day.
#[tauri::command]
fn write_draft(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        return Err("draft is empty or too large".into());
    }
    let ext: String = request
        .headers()
        .get("x-blip-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|n| n.rsplit('.').next())
        .unwrap_or("bin")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let dir = blip_home().join("run").join("drafts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
            if old.is_some_and(|age| age > Duration::from_secs(86_400)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("paste-{stamp}.{}", if ext.is_empty() { "bin" } else { &ext }));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn show_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_app() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app.clone())))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Tray(Mutex::new(None)))
        .manage(Watching(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![core, shim, start_watch, set_status, show_main, write_draft])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Blip", true, None::<&str>)?;
            let read = MenuItem::with_id(app, "mark-all-read", "Mark all as read", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Blip", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &read, &PredefinedMenuItem::separator(app)?, &quit])?;
            let tray = TrayIconBuilder::with_id("blip")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("Blip")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app.clone()),
                    "mark-all-read" => {
                        let _ = app.emit("blip://mark-all-read", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;
            *app.state::<Tray>().0.lock().unwrap() = Some(tray);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Blip in the tray, like the Omarchy bar widget.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Blip");
}
