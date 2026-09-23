//! blip-shim: the Windows side of Blip's Mac bridge, like bridge/linux/blip-shim.
//!
//! Installed as imsg.exe, imsg-send.exe, imsg-read.exe, contacts.exe,
//! contact-save.exe and blip-check.exe; it dispatches on its own name.
//! (`blip-shim <tool> args...` works too, for testing.)
//!
//! Where the Linux shim runs ssh through a ControlMaster socket, this one hands
//! argv + stdin to blip-mux over its named pipe and replays the tool's stdout,
//! stderr and exit code. It starts blip-mux if none is running.
//!
//! Exit codes match the Linux shim: 69 offline (Blip greys out), 64 not a tool,
//! 78 no/bad config, otherwise the Mac tool's own code.

use std::fs::OpenOptions;
use std::io::{self, IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use blip_wire as wire;

const START_WAIT: Duration = Duration::from_secs(6);

fn die(code: i32, msg: &str) -> ! {
    let _ = writeln!(io::stderr(), "{msg}");
    std::process::exit(code);
}

fn tool_and_args() -> (String, Vec<String>) {
    let mut args: Vec<String> = std::env::args().collect();
    let me = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    args.remove(0);
    if me == "blip-shim" {
        if args.is_empty() {
            die(wire::EXIT_USAGE, "usage: blip-shim <tool> [args...]  (or install as imsg.exe, imsg-send.exe, ...)");
        }
        let tool = args.remove(0);
        (tool, args)
    } else {
        (me, args)
    }
}

/// Keep our own std handles out of the mux: Rust spawns with handle
/// inheritance on, and a mux holding the caller's stdout pipe would make
/// node's spawnSync wait for it to exit (10 minutes).
fn no_inherit_std_handles() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: plain Win32 calls on this process's own std handles.
        unsafe {
            let h = GetStdHandle(which);
            if !h.is_null() {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

fn start_mux() {
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("blip-mux.exe")));
    let Some(exe) = exe.filter(|p| p.exists()) else {
        die(wire::EXIT_OFFLINE, "blip: blip-mux.exe is not next to this shim - re-run blip-setup");
    };
    no_inherit_std_handles();
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new(exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn();
}

fn open_pipe() -> Option<std::fs::File> {
    let name = std::fs::read_to_string(wire::pipe_name_file()).ok()?;
    let name = name.trim();
    if !name.starts_with(r"\\.\pipe\blip-mux-") {
        return None;
    }
    use std::os::windows::fs::OpenOptionsExt;
    // SECURITY_IDENTIFICATION: whatever serves this pipe may learn who we are
    // but not act as us (only relevant if the name were ever squatted).
    const SECURITY_IDENTIFICATION: u32 = 1 << 16;
    OpenOptions::new().read(true).write(true).security_qos_flags(SECURITY_IDENTIFICATION).open(PathBuf::from(name)).ok()
}

fn connect() -> std::fs::File {
    if let Some(p) = open_pipe() {
        return p;
    }
    start_mux();
    let t0 = Instant::now();
    while t0.elapsed() < START_WAIT {
        std::thread::sleep(Duration::from_millis(25));
        if let Some(p) = open_pipe() {
            return p;
        }
    }
    die(wire::EXIT_OFFLINE, "blip: blip-mux did not start - see %LOCALAPPDATA%\\Blip\\mux.log");
}

fn main() {
    let (tool, args) = tool_and_args();
    if !wire::is_tool(&tool) {
        die(
            wire::EXIT_USAGE,
            &format!("blip-shim: unknown tool name '{tool}' (install as imsg, imsg-send, imsg-read, contacts, contact-save)"),
        );
    }

    // All of stdin, then the request. Callers hand stdin whole (spawnSync
    // input) and close it; a terminal means "no stdin", not "wait for ^Z".
    let mut stdin = Vec::new();
    if !io::stdin().is_terminal() {
        if let Err(e) = io::stdin().read_to_end(&mut stdin) {
            die(wire::EXIT_USAGE, &format!("blip-shim: cannot read stdin: {e}"));
        }
    }

    let mut argv = Vec::with_capacity(args.len() + 1);
    argv.push(tool);
    argv.extend(args);

    let mut pipe = connect();
    if let Err(e) = wire::write_request(&mut pipe, &argv, &stdin) {
        die(wire::EXIT_OFFLINE, &format!("blip: lost the mux: {e}"));
    }
    drop(stdin);

    let mut out = io::stdout().lock();
    let mut err = io::stderr().lock();
    loop {
        match wire::read_frame(&mut pipe) {
            Ok(Some((wire::FRAME_STDOUT, d))) => {
                // A reader that stopped reading (| head) is not an error worth reporting.
                if out.write_all(&d).and_then(|_| out.flush()).is_err() {
                    std::process::exit(0);
                }
            }
            Ok(Some((wire::FRAME_STDERR, d))) => {
                let _ = err.write_all(&d);
                let _ = err.flush();
            }
            Ok(Some((wire::FRAME_EXIT, d))) if d.len() == 4 => {
                std::process::exit(i32::from_le_bytes([d[0], d[1], d[2], d[3]]));
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => die(wire::EXIT_OFFLINE, "blip: the mux closed the connection early"),
        }
    }
}
