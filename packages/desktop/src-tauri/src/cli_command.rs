//! The Cezar menu's "Install 'cez' command in PATH…" / "Uninstall 'cez' command": symlinks the
//! bundle's shim (`Contents/Resources/bin/{cez,cezar}`) into `/usr/local/bin` or `~/.local/bin`,
//! like VS Code's `code`. Planning is pure and unix-wide (tested on Linux CI); the dialogs and
//! the admin prompt are macOS-only, through `osascript`.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};

pub const NAMES: [&str; 2] = ["cez", "cezar"];
pub const SYSTEM_DIR: &str = "/usr/local/bin";

#[derive(Debug, Clone, PartialEq)]
pub enum LinkState {
    Missing,
    /// A link to this bundle's shim, or to the shim of any other `Cezar.app` copy.
    Ours,
    /// Anything else: the description says what is there.
    Foreign(String),
}

#[derive(Debug, Clone)]
pub struct Link {
    pub path: PathBuf,
    pub source: PathBuf,
    pub state: LinkState,
}

/// `~/.local/bin` for the given home.
pub fn user_dir(home: &Path) -> PathBuf {
    home.join(".local").join("bin")
}

/// A symlink target that is some Cezar.app's shim — the app may have moved, or come from brew.
fn is_cezar_shim(target: &Path, name: &str) -> bool {
    let text = target.to_string_lossy();
    text.ends_with(&format!(".app/Contents/Resources/bin/{name}")) && text.contains("Cezar")
}

pub fn link_state(link: &Path, source: &Path, name: &str) -> LinkState {
    let Ok(meta) = std::fs::symlink_metadata(link) else { return LinkState::Missing };
    if !meta.file_type().is_symlink() {
        return LinkState::Foreign(format!("{} is a file, not a link", link.display()));
    }
    match std::fs::read_link(link) {
        Ok(target) if target == source || is_cezar_shim(&target, name) => LinkState::Ours,
        Ok(target) => LinkState::Foreign(format!("{} points to {}", link.display(), target.display())),
        Err(_) => LinkState::Foreign(format!("{} cannot be read", link.display())),
    }
}

/// What installing into `dir` would meet, for every command name.
pub fn plan(dir: &Path, shim_dir: &Path) -> Vec<Link> {
    NAMES
        .iter()
        .map(|name| {
            let path = dir.join(name);
            let source = shim_dir.join(name);
            let state = link_state(&path, &source, name);
            Link { path, source, state }
        })
        .collect()
}

pub fn foreign(links: &[Link]) -> Vec<String> {
    links.iter().filter_map(|link| match &link.state {
        LinkState::Foreign(what) => Some(what.clone()),
        _ => None,
    }).collect()
}

/// Every link already points exactly at this bundle's shim.
pub fn up_to_date(links: &[Link]) -> bool {
    links.iter().all(|link| std::fs::read_link(&link.path).is_ok_and(|target| target == link.source))
}

fn quote(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', r"'\''"))
}

/// `mkdir -p dir && ln -sf source link …`. Foreign entries are replaced only when `replace`
/// (the user said yes); otherwise they are left out.
pub fn install_script(dir: &Path, links: &[Link], replace: bool) -> String {
    let mut steps = vec![format!("mkdir -p {}", quote(dir))];
    for link in links {
        if matches!(link.state, LinkState::Foreign(_)) && !replace {
            continue;
        }
        steps.push(format!("rm -f {}", quote(&link.path)));
        steps.push(format!("ln -s {} {}", quote(&link.source), quote(&link.path)));
    }
    steps.join(" && ")
}

/// Removes only links that are ours; `None` when there is nothing to remove.
pub fn uninstall_script(links: &[Link]) -> Option<String> {
    let ours: Vec<String> = links.iter().filter(|link| link.state == LinkState::Ours).map(|link| format!("rm -f {}", quote(&link.path))).collect();
    (!ours.is_empty()).then(|| ours.join(" && "))
}

/// Can this process create files in `dir` (or in its nearest existing ancestor, which
/// `mkdir -p` would extend)?
pub fn writable(dir: &Path) -> bool {
    let mut probe = Some(dir);
    while let Some(candidate) = probe {
        if candidate.is_dir() {
            let probe_file = candidate.join(format!(".cez-write-probe-{}", std::process::id()));
            let created = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe_file).is_ok();
            let _ = std::fs::remove_file(&probe_file);
            return created;
        }
        if candidate.exists() {
            return false;
        }
        probe = candidate.parent();
    }
    false
}

/// The first `name` a shell with `path` would run.
pub fn first_on_path(path: &str, name: &str) -> Option<PathBuf> {
    path.split(':').filter(|dir| !dir.is_empty()).map(|dir| Path::new(dir).join(name)).find(|candidate| candidate.is_file())
}

pub fn on_path(path: &str, dir: &Path) -> bool {
    path.split(':').any(|entry| Path::new(entry) == dir)
}

// ---- macOS glue: dialogs and the admin prompt ---------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::process::Command;

    fn applescript_string(value: &str) -> String {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }

    /// `display dialog` → the button pressed, `None` on Cancel.
    fn ask(message: &str, buttons: &[&str], default: &str) -> Option<String> {
        let list = buttons.iter().map(|b| applescript_string(b)).collect::<Vec<_>>().join(", ");
        let script = format!(
            "button returned of (display dialog {} buttons {{{}}} default button {} cancel button \"Cancel\" with title \"Cezar\")",
            applescript_string(message),
            list,
            applescript_string(default)
        );
        let output = Command::new("osascript").args(["-e", &script]).output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn tell(message: &str) {
        let script = format!("display dialog {} buttons {{\"OK\"}} default button \"OK\" with title \"Cezar\"", applescript_string(message));
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }

    /// Runs `script` as the user, or through the macOS admin prompt when `dir` is not writable.
    fn run(script: &str, admin: bool) -> Result<(), String> {
        let output = if admin {
            let apple = format!("do shell script {} with administrator privileges", applescript_string(script));
            Command::new("osascript").args(["-e", &apple]).output()
        } else {
            Command::new("/bin/sh").args(["-c", script]).output()
        }
        .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    fn user_path() -> String {
        crate::tool_path().base.or_else(|| std::env::var("PATH").ok()).unwrap_or_default()
    }

    pub fn install(shim_dir: PathBuf) {
        if !shim_dir.join("cez").is_file() {
            tell("This build of Cezar does not include the cez command.");
            return;
        }
        let home = crate::home_dir();
        let local = user_dir(&home);
        let local_label = "~/.local/bin";
        let Some(choice) = ask(
            "Install the cez and cezar commands so a terminal can run cezar?\n\n/usr/local/bin is on every shell's PATH (may ask for your password). ~/.local/bin needs no password but must be on your PATH.",
            &["Cancel", local_label, SYSTEM_DIR],
            SYSTEM_DIR,
        ) else {
            return;
        };
        let dir = if choice == local_label { local } else { PathBuf::from(SYSTEM_DIR) };
        let links = plan(&dir, &shim_dir);
        if up_to_date(&links) {
            tell(&format!("cez and cezar are already installed in {}.", dir.display()));
            return;
        }
        let others = foreign(&links);
        let replace = !others.is_empty();
        if replace && ask(&format!("{}.\n\nReplace with Cezar's command?", others.join(".\n")), &["Cancel", "Replace"], "Cancel").is_none() {
            return;
        }
        if let Err(error) = run(&install_script(&dir, &links, replace), !writable(&dir)) {
            tell(&format!("Could not install the cez command: {error}"));
            return;
        }
        let path = user_path();
        let mut message = format!("Installed cez and cezar in {}. Open a new terminal and run: cez --help", dir.display());
        if !on_path(&path, &dir) {
            message.push_str(&format!("\n\n{} is not on your PATH yet. Add it in your shell profile:\nexport PATH=\"{}:$PATH\"", dir.display(), dir.display()));
        } else if let Some(first) = first_on_path(&path, "cez").filter(|first| first != &dir.join("cez")) {
            message.push_str(&format!("\n\nNote: {} comes first on your PATH, so `cez` runs that one.", first.display()));
        }
        tell(&message);
    }

    pub fn uninstall(shim_dir: PathBuf) {
        let home = crate::home_dir();
        let mut removed = Vec::new();
        for dir in [PathBuf::from(SYSTEM_DIR), user_dir(&home)] {
            let links = plan(&dir, &shim_dir);
            let Some(script) = uninstall_script(&links) else { continue };
            if let Err(error) = run(&script, !writable(&dir)) {
                tell(&format!("Could not remove the cez command from {}: {error}", dir.display()));
                return;
            }
            removed.push(dir.display().to_string());
        }
        tell(&if removed.is_empty() {
            "Cezar's cez command is not installed in /usr/local/bin or ~/.local/bin.".to_string()
        } else {
            format!("Removed cez and cezar from {}.", removed.join(" and "))
        });
    }
}

#[cfg(target_os = "macos")]
pub use mac::{install, uninstall};

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cez-cli-command-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn shim(root: &Path) -> PathBuf {
        let shim = root.join("Cezar.app/Contents/Resources/bin");
        std::fs::create_dir_all(&shim).unwrap();
        for name in NAMES {
            std::fs::write(shim.join(name), "#!/bin/sh\n").unwrap();
        }
        shim
    }

    fn run(script: &str) {
        let status = std::process::Command::new("/bin/sh").args(["-c", script]).status().unwrap();
        assert!(status.success(), "{script}");
    }

    #[test]
    fn installs_both_commands_into_a_missing_folder_and_uninstalls_them() {
        let root = scratch("install");
        let shim = shim(&root);
        let bin = root.join("home/.local/bin");
        let links = plan(&bin, &shim);
        assert!(links.iter().all(|link| link.state == LinkState::Missing));
        assert!(writable(&bin), "a missing folder under a writable one is writable");
        run(&install_script(&bin, &links, false));
        for name in NAMES {
            assert_eq!(std::fs::read_link(bin.join(name)).unwrap(), shim.join(name));
        }
        let links = plan(&bin, &shim);
        assert!(up_to_date(&links));
        run(&uninstall_script(&links).unwrap());
        assert!(NAMES.iter().all(|name| !bin.join(name).exists()));
        assert!(uninstall_script(&plan(&bin, &shim)).is_none());
    }

    #[test]
    fn a_foreign_cez_is_reported_and_kept_unless_the_user_agrees() {
        let root = scratch("foreign");
        let shim = shim(&root);
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let npm = root.join("lib/node_modules/@open-mercato/cezar/dist/index.js");
        symlink(&npm, bin.join("cez")).unwrap();
        let links = plan(&bin, &shim);
        assert_eq!(foreign(&links), vec![format!("{} points to {}", bin.join("cez").display(), npm.display())]);
        assert_eq!(links[1].state, LinkState::Missing);

        run(&install_script(&bin, &links, false));
        assert_eq!(std::fs::read_link(bin.join("cez")).unwrap(), npm, "kept without consent");
        assert_eq!(std::fs::read_link(bin.join("cezar")).unwrap(), shim.join("cezar"));
        assert!(uninstall_script(&plan(&bin, &shim)).unwrap().contains("cezar'"), "only ours is removed");
        assert!(!uninstall_script(&plan(&bin, &shim)).unwrap().contains("/cez'"));

        run(&install_script(&bin, &plan(&bin, &shim), true));
        assert_eq!(std::fs::read_link(bin.join("cez")).unwrap(), shim.join("cez"));
    }

    #[test]
    fn a_regular_file_is_foreign_and_another_cezar_copy_is_ours() {
        let root = scratch("kinds");
        let shim = shim(&root);
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("cez"), "#!/bin/sh\n").unwrap();
        symlink("/Applications/Cezar.app/Contents/Resources/bin/cezar", bin.join("cezar")).unwrap();
        let links = plan(&bin, &shim);
        assert!(matches!(&links[0].state, LinkState::Foreign(what) if what.ends_with("is a file, not a link")));
        assert_eq!(links[1].state, LinkState::Ours);
        assert!(!up_to_date(&links), "an old copy's link is ours but still re-pointed");
    }

    #[test]
    fn paths_with_quotes_stay_one_argument() {
        let root = scratch("it's quoted");
        let shim = shim(&root);
        let bin = root.join("my bin");
        run(&install_script(&bin, &plan(&bin, &shim), false));
        assert_eq!(std::fs::read_link(bin.join("cez")).unwrap(), shim.join("cez"));
    }

    #[test]
    fn the_first_cez_on_path_wins() {
        let root = scratch("path");
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("cez"), "").unwrap();
        let path = format!("{}::{}", a.display(), b.display());
        assert_eq!(first_on_path(&path, "cez"), Some(b.join("cez")));
        std::fs::write(a.join("cez"), "").unwrap();
        assert_eq!(first_on_path(&path, "cez"), Some(a.join("cez")));
        assert!(on_path(&path, &b));
        assert!(!on_path(&path, &root));
    }
}
