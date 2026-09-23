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
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri_plugin_autostart::ManagerExt as _;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Passed by the login item: start in the tray, window hidden.
const HIDDEN_ARG: &str = "--hidden";

/// The core scripts the UI runs, and only those: anything else is refused
/// before a process starts. (contact-vcard, which writes files to a chosen
/// folder, and the other contact-review scripts join when the UI uses them.)
const CORE_SCRIPTS: &[&str] = &[
    "collector", "thread", "send-file", "fetch", "avatar", "search", "linkpreview", "contact-search", "contact-save",
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

/// The installed app's resource dir (blip-core.exe, blip-mux.exe,
/// blip-shim.exe, setup/). Unset in a dev run that has not bundled them.
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();

fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn resource(name: &str) -> Option<PathBuf> {
    RESOURCES.get().map(|r| r.join(name)).filter(|p| p.exists())
}

/// How to start a core script. An installed build ships `blip-core.exe`
/// (the core compiled with Bun); a dev build runs the repo's .ts files with
/// the bun on PATH.
fn core_command(script: &str) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        // Debug builds always run the live .ts files, never a stale bundled core.
        let repo = repo_dir();
        let mut c = Command::new("bun");
        c.arg(repo.join(format!("{script}.ts"))).current_dir(repo);
        return Ok(c);
    }
    // A release never falls back to bun on PATH or a path from the build machine.
    let core = resource("blip-core.exe").ok_or("blip-core.exe is missing - reinstall Blip")?;
    let mut c = Command::new(core);
    c.arg(script);
    Ok(c)
}

/// Keep %LOCALAPPDATA%\Blip\bin (the core's ~/bin) matching the installed
/// shims and mux: the shim under each tool name, like bridge/linux/blip-shim.
/// An update can find the old mux still running from there; Windows will not
/// overwrite a running exe but will rename it, so it is moved aside first.
fn sync_bin() {
    let (Some(shim), Some(mux)) = (resource("blip-shim.exe"), resource("blip-mux.exe")) else { return };
    let bin = bin_dir();
    let _ = std::fs::create_dir_all(&bin);
    let mut pairs: Vec<(PathBuf, PathBuf)> = blip_wire::TOOLS.iter().map(|t| (shim.clone(), bin.join(format!("{t}.exe")))).collect();
    pairs.push((mux, bin.join("blip-mux.exe")));
    for (src, dst) in pairs {
        let same = match (std::fs::read(&src), std::fs::read(&dst)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if same {
            continue;
        }
        if std::fs::copy(&src, &dst).is_err() {
            let old = dst.with_extension("exe.old");
            let _ = std::fs::remove_file(&old);
            if std::fs::rename(&dst, &old).is_ok() {
                let _ = std::fs::copy(&src, &dst);
            }
        }
    }
}

#[derive(Serialize)]
struct SetupState {
    configured: bool,
    host: String,
    shims: bool,
}

/// Is there a bridge.conf with a host, and are the shims in place?
#[tauri::command]
fn setup_state() -> SetupState {
    let conf = std::fs::read_to_string(blip_wire::conf_path()).unwrap_or_default();
    let host = conf
        .lines()
        .filter_map(|l| l.split('#').next())
        .filter_map(|l| l.trim().strip_prefix("host="))
        .map(|v| v.trim().trim_matches('\'').trim_matches('"').to_string())
        .last()
        .unwrap_or_default();
    SetupState { configured: !host.is_empty(), host, shims: bin_dir().join("imsg.exe").exists() }
}

/// Run blip-setup.ps1 in its own console window, where ssh can ask for the
/// Mac's password and fingerprint itself; resolves with its exit code.
#[tauri::command]
async fn run_setup(host: String) -> Result<i32, String> {
    let ok = !host.is_empty()
        && host.split('@').all(|p| !p.is_empty() && !p.starts_with('-') && p.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c)))
        && host.matches('@').count() <= 1;
    if !ok {
        return Err("expected [user@]host".into());
    }
    let script = match resource("setup/blip-setup.ps1") {
        Some(p) => p,
        None if cfg!(debug_assertions) => repo_dir().join("windows").join("scripts").join("blip-setup.ps1"),
        None => return Err("the setup script is missing - reinstall Blip".into()),
    };
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    // By full path: a bare name would search the app folder first.
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).filter(|p| p.is_absolute()).ok_or("SystemRoot is not set")?;
    let status = Command::new(system.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"))
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .arg(&host)
        .arg("-FromApp")
        .creation_flags(CREATE_NEW_CONSOLE)
        .status()
        .await
        .map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(-1))
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
    let mut c = core_command(&script)?;
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

/// When the popout last hid itself on losing focus. Clicking the tray icon
/// while it is open blurs it first; that click must close it, not reopen it.
static PANEL_BLURRED: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// The tray popout (Panel.qml's equivalent): toggled by a left click, placed
/// against the tray icon inside the work area, above a bottom taskbar and
/// below a top one.
fn toggle_panel(app: &AppHandle, rect: tauri::Rect) {
    let Some(panel) = app.get_webview_window("panel") else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    if PANEL_BLURRED.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(300)) {
        return;
    }
    let icon = rect.position.to_physical::<f64>(1.0);
    let icon_size = rect.size.to_physical::<f64>(1.0);
    if let Ok(size) = panel.outer_size() {
        let (w, h) = (size.width as f64, size.height as f64);
        let mut x = icon.x + icon_size.width / 2.0 - w / 2.0;
        let mut y = icon.y - h - 8.0;
        if let Ok(Some(m)) = app.monitor_from_point(icon.x, icon.y) {
            let wa = m.work_area();
            let (left, top) = (wa.position.x as f64, wa.position.y as f64);
            let (right, bottom) = (left + wa.size.width as f64, top + wa.size.height as f64);
            if icon.y < top + (bottom - top) / 2.0 {
                y = icon.y + icon_size.height + 8.0; // taskbar on top
            }
            x = x.clamp(left + 8.0, right - w - 8.0);
            y = y.clamp(top + 8.0, bottom - h - 8.0);
        }
        let _ = panel.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = panel.show();
    let _ = panel.set_focus();
    let _ = app.emit_to("panel", "blip://panel-shown", ());
}

/// A Windows toast. Clicking it opens that conversation ("" just shows the
/// window), which the notification plugin cannot do on desktop. The title and
/// body are already allowlist-gated and capped by the UI; a security code's
/// toast never carries the digits.
#[tauri::command]
fn toast(app: AppHandle, title: String, body: String, chat: String) -> Result<(), String> {
    use tauri_winrt_notification::Toast;
    // An installed build is registered under its identifier (the Start menu
    // shortcut carries it); a dev build borrows PowerShell's, as Tauri does.
    let id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let handle = app.clone();
    Toast::new(&id)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            show_main(handle.clone());
            if !chat.is_empty() {
                let _ = handle.emit("blip://open-chat", chat.clone());
            }
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
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
        // Ctrl+Alt+M raises Blip (Win+ combinations belong to the shell).
        // Registered here, not by the page, so the page needs no shortcut rights.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("ctrl+alt+m")
                .expect("valid shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        show_main(app.clone());
                    }
                })
                .build(),
        )
        // Size and position survive a restart (BlipWindow's window.json).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Not visibility: quitting from the tray must not mean "start hidden".
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                // The popout is placed against the tray icon every time it opens.
                .with_denylist(&["panel"])
                .build(),
        )
        // Off until chosen in the tray menu; a login start goes straight to the tray.
        .plugin(tauri_plugin_autostart::Builder::new().arg(HIDDEN_ARG).build())
        .manage(Tray(Mutex::new(None)))
        .manage(Watching(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![core, shim, start_watch, set_status, show_main, write_draft, setup_state, run_setup, toast])
        .setup(|app| {
            if let Ok(dir) = app.path().resource_dir() {
                let _ = RESOURCES.set(dir);
            }
            sync_bin();
            if std::env::args().any(|a| a == HIDDEN_ARG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            let open = MenuItem::with_id(app, "open", "Open Blip", true, None::<&str>)?;
            let read = MenuItem::with_id(app, "mark-all-read", "Mark all as read", true, None::<&str>)?;
            let login_on = app.autolaunch().is_enabled().unwrap_or(false);
            let login = CheckMenuItem::with_id(app, "autostart", "Start Blip at login", true, login_on, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Blip", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &read, &PredefinedMenuItem::separator(app)?, &login, &PredefinedMenuItem::separator(app)?, &quit])?;
            let login_item = login.clone();
            let tray = TrayIconBuilder::with_id("blip")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("Blip")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, e| match e.id.as_ref() {
                    "open" => show_main(app.clone()),
                    "autostart" => {
                        let al = app.autolaunch();
                        let want = !al.is_enabled().unwrap_or(false);
                        let _ = if want { al.enable() } else { al.disable() };
                        let _ = login_item.set_checked(al.is_enabled().unwrap_or(false));
                    }
                    "mark-all-read" => {
                        let _ = app.emit("blip://mark-all-read", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                // Left click: the popout. Double click: the full window (as on the Omarchy bar).
                .on_tray_icon_event(|tray, e| match e {
                    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } => {
                        toggle_panel(tray.app_handle(), rect);
                    }
                    TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                        if let Some(p) = tray.app_handle().get_webview_window("panel") {
                            let _ = p.hide();
                        }
                        show_main(tray.app_handle().clone());
                    }
                    _ => {}
                })
                .build(app)?;
            *app.state::<Tray>().0.lock().unwrap() = Some(tray);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing a window keeps Blip in the tray, like the Omarchy bar widget.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The popout goes away when anything else is clicked.
            WindowEvent::Focused(false) if window.label() == "panel" => {
                *PANEL_BLURRED.lock().unwrap() = Some(std::time::Instant::now());
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Blip");
}
