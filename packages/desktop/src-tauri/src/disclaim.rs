//! `<this exe> --cez-disclaim-exec <program> <args…>`: become `program`, disclaiming the app.
//!
//! macOS privacy (TCC) prompts name the RESPONSIBLE process, and everything the app starts —
//! the cockpit server, the agents it runs, the tools they call — inherits the app as that
//! process. So an agent listing `~/Documents` asked in Cezar's name, and one Allow granted every
//! agent. cezar (`CEZ_DISCLAIM_EXEC`, set by `spawn_sidecar`) starts agents through this
//! trampoline instead: `posix_spawn` with `POSIX_SPAWN_SETEXEC` replaces this process in place
//! — same pid, same stdio, so cezar's process handle stays valid — and the disclaim attribute
//! makes the new image its own responsible process. The prompt then names the agent.
//!
//! It runs before Tauri initializes anything, and never returns on success.

pub const FLAG: &str = "--cez-disclaim-exec";

/// Exec the requested program when invoked as the trampoline; return otherwise.
pub fn disclaim_exec_if_asked() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(FLAG)) {
        return;
    }
    let rest: Vec<std::ffi::OsString> = args.collect();
    let Some(program) = rest.first() else {
        eprintln!("{FLAG}: no program given");
        std::process::exit(127);
    };
    let error = exec(program, &rest);
    eprintln!("{FLAG}: could not start {}: {error}", program.to_string_lossy());
    std::process::exit(127);
}

#[cfg(target_os = "macos")]
fn exec(program: &std::ffi::OsStr, argv: &[std::ffi::OsString]) -> std::io::Error {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    // Private but stable since macOS 10.14 (Chromium, LLDB and VS Code's terminal rely on it);
    // looked up at run time so a system without it still runs the program, merely undisclaimed.
    type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
    extern "C" {
        static environ: *const *mut libc::c_char;
    }

    let to_c = |value: &std::ffi::OsStr| CString::new(value.as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput));
    let (path, args) = match (to_c(program), argv.iter().map(|arg| to_c(arg)).collect::<Result<Vec<_>, _>>()) {
        (Ok(path), Ok(args)) => (path, args),
        (Err(error), _) | (_, Err(error)) => return error,
    };
    let mut pointers: Vec<*mut libc::c_char> = args.iter().map(|arg| arg.as_ptr() as *mut libc::c_char).collect();
    pointers.push(std::ptr::null_mut());

    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return std::io::Error::last_os_error();
        }
        libc::posix_spawnattr_setflags(&mut attr, libc::POSIX_SPAWN_SETEXEC as libc::c_short);
        let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_spawnattrs_setdisclaim".as_ptr());
        if !symbol.is_null() {
            let set_disclaim: SetDisclaim = std::mem::transmute(symbol);
            set_disclaim(&mut attr, 1);
        }
        let status = libc::posix_spawn(std::ptr::null_mut(), path.as_ptr(), std::ptr::null(), &attr, pointers.as_ptr(), environ);
        libc::posix_spawnattr_destroy(&mut attr);
        std::io::Error::from_raw_os_error(status)
    }
}

/// Elsewhere there is no responsible process to disclaim: a plain exec keeps the contract.
#[cfg(all(unix, not(target_os = "macos")))]
fn exec(program: &std::ffi::OsStr, argv: &[std::ffi::OsString]) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    std::process::Command::new(program).args(&argv[1..]).exec()
}

#[cfg(windows)]
fn exec(program: &std::ffi::OsStr, argv: &[std::ffi::OsString]) -> std::io::Error {
    match std::process::Command::new(program).args(&argv[1..]).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => error,
    }
}
