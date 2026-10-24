//! Remote mode: the window shows a cezar running on ANOTHER machine (a VPS) instead of a local
//! sidecar. The "sidecar" is then `ssh -N -L` to that server's loopback cockpit, so the window
//! still loads `http://127.0.0.1:<port>` — the capability, `is_own_origin` and every IPC guard
//! stay exactly as they are — and the user's own SSH keys and `~/.ssh/config` are the login.
//!
//! Off unless chosen: `CEZ_DESKTOP_REMOTE=<ssh destination>` or the app menu's "Connect to a
//! server…", which writes `~/.cezar/desktop-remote.json`. Deleting that file is local mode again.

use std::path::{Path, PathBuf};

/// The port `server-install` binds cezar to on the server.
pub const DEFAULT_REMOTE_PORT: u16 = 4321;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remote {
    /// An ssh destination: a `~/.ssh/config` alias, `host` or `user@host`.
    pub ssh: String,
    /// The cezar port on the server's loopback.
    pub port: u16,
}

impl Remote {
    pub fn new(ssh: &str, port: Option<u16>) -> Result<Remote, String> {
        let ssh = ssh.trim();
        validate_destination(ssh)?;
        let port = port.unwrap_or(DEFAULT_REMOTE_PORT);
        if port == 0 {
            return Err("The cezar port must be between 1 and 65535.".into());
        }
        Ok(Remote { ssh: ssh.to_string(), port })
    }

    /// `ssh` arguments for a tunnel from `127.0.0.1:<local_port>` here to the server's cockpit.
    /// BatchMode: a GUI app has no terminal to type a password or a passphrase into, so ssh must
    /// fail fast instead of waiting on one. `accept-new` trusts a host seen for the first time
    /// and still refuses a CHANGED key. The destination comes last, after `--`.
    pub fn tunnel_args(&self, local_port: u16) -> Vec<String> {
        let mut args: Vec<String> = ["-N", "-T"].iter().map(|s| s.to_string()).collect();
        for option in [
            "BatchMode=yes",
            "ExitOnForwardFailure=yes",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ConnectTimeout=15",
            "StrictHostKeyChecking=accept-new",
        ] {
            args.push("-o".into());
            args.push(option.into());
        }
        args.push("-L".into());
        args.push(format!("127.0.0.1:{local_port}:127.0.0.1:{}", self.port));
        args.push("--".into());
        args.push(self.ssh.clone());
        args
    }

    /// How the splash and the menu name the server.
    pub fn label(&self) -> String {
        if self.port == DEFAULT_REMOTE_PORT {
            self.ssh.clone()
        } else {
            format!("{} (port {})", self.ssh, self.port)
        }
    }
}

/// A destination ssh reads as a host and never as an option: no leading `-` (`-oProxyCommand=…`
/// would run a command), no spaces, only what hostnames, aliases and user names use.
fn validate_destination(ssh: &str) -> Result<(), String> {
    if ssh.is_empty() {
        return Err("Enter the server's SSH address, e.g. user@my-vps.example.com.".into());
    }
    if ssh.len() > 255 {
        return Err("That SSH address is too long.".into());
    }
    if ssh.starts_with('-') {
        return Err("An SSH address cannot start with \"-\".".into());
    }
    if ssh.matches('@').count() > 1 || ssh.ends_with('@') || ssh.starts_with('@') {
        return Err("Use host or user@host.".into());
    }
    if let Some(bad) = ssh.chars().find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@'))) {
        return Err(format!("\"{bad}\" is not allowed in an SSH address. Use a host, user@host or a ~/.ssh/config alias (set a custom SSH port there)."));
    }
    Ok(())
}

pub fn config_path(cezar_home: &Path) -> PathBuf {
    cezar_home.join("desktop-remote.json")
}

/// Where the window points: `CEZ_DESKTOP_REMOTE` wins, else the saved choice, else local.
/// An invalid value is reported, never silently dropped — the user asked for a server.
pub fn resolve(env: Option<String>, cezar_home: &Path) -> Option<Result<Remote, String>> {
    if let Some(raw) = env.filter(|value| !value.trim().is_empty()) {
        return Some(Remote::new(&raw, None).map_err(|error| format!("CEZ_DESKTOP_REMOTE: {error}")));
    }
    let raw = std::fs::read_to_string(config_path(cezar_home)).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let ssh = json.get("ssh").and_then(|value| value.as_str())?;
    let port = json.get("port").and_then(|value| value.as_u64()).and_then(|port| u16::try_from(port).ok());
    Some(Remote::new(ssh, port))
}

/// Save the choice (`None` = this computer again). Atomic, like the window geometry.
pub fn save(cezar_home: &Path, remote: Option<&Remote>) -> Result<(), String> {
    let path = config_path(cezar_home);
    let Some(remote) = remote else {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    };
    std::fs::create_dir_all(cezar_home).map_err(|error| error.to_string())?;
    let json = serde_json::json!({ "ssh": remote.ssh, "port": remote.port });
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(&json).unwrap_or_default())).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cez-desktop-remote-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn accepts_hosts_users_and_aliases() {
        assert_eq!(Remote::new("my-vps", None).unwrap(), Remote { ssh: "my-vps".into(), port: 4321 });
        assert_eq!(Remote::new(" deploy@cezar.example.com ", Some(4400)).unwrap().ssh, "deploy@cezar.example.com");
        assert!(Remote::new("ubuntu@10.0.0.5", None).is_ok());
    }

    /// A destination is the one user-typed word that reaches ssh's argv.
    #[test]
    fn refuses_anything_ssh_could_read_as_an_option() {
        for bad in ["", "-oProxyCommand=touch /tmp/x", "a b", "user@host;rm", "a@b@c", "@host", "user@", "host:22", "ssh://host", "h$(id)"] {
            assert!(Remote::new(bad, None).is_err(), "{bad:?} must be refused");
        }
        assert!(Remote::new("host", Some(0)).is_err());
    }

    #[test]
    fn the_tunnel_forwards_loopback_to_loopback_and_ends_with_the_destination() {
        let args = Remote::new("me@vps", Some(4400)).unwrap().tunnel_args(4341);
        assert!(args.windows(2).any(|pair| pair == ["-L", "127.0.0.1:4341:127.0.0.1:4400"]));
        assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        assert_eq!(&args[args.len() - 2..], ["--", "me@vps"]);
    }

    #[test]
    fn the_environment_wins_over_the_saved_choice() {
        let home = temp_home("env");
        save(&home, Some(&Remote::new("saved", Some(4400)).unwrap())).unwrap();
        assert_eq!(resolve(Some("from-env".into()), &home).unwrap().unwrap().ssh, "from-env");
        assert!(resolve(Some("-bad".into()), &home).unwrap().unwrap_err().starts_with("CEZ_DESKTOP_REMOTE"));
        // An empty variable is not a choice.
        assert_eq!(resolve(Some("  ".into()), &home).unwrap().unwrap(), Remote { ssh: "saved".into(), port: 4400 });
        let _ = std::fs::remove_dir_all(&home);
    }

    /// No file, no variable: local mode — the zero-config default.
    #[test]
    fn nothing_saved_is_local_mode_and_saving_none_returns_to_it() {
        let home = temp_home("roundtrip");
        assert!(resolve(None, &home).is_none());
        save(&home, Some(&Remote::new("vps", None).unwrap())).unwrap();
        assert_eq!(resolve(None, &home).unwrap().unwrap(), Remote { ssh: "vps".into(), port: 4321 });
        save(&home, None).unwrap();
        assert!(resolve(None, &home).is_none());
        // Removing what is not there is fine.
        save(&home, None).unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_hand_edited_bad_file_is_an_error_not_local_mode() {
        let home = temp_home("bad");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(config_path(&home), r#"{"ssh":"-oProxyCommand=x"}"#).unwrap();
        assert!(resolve(None, &home).unwrap().is_err());
        std::fs::write(config_path(&home), "not json").unwrap();
        assert!(resolve(None, &home).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn labels_name_a_non_default_port() {
        assert_eq!(Remote::new("vps", None).unwrap().label(), "vps");
        assert_eq!(Remote::new("vps", Some(5000)).unwrap().label(), "vps (port 5000)");
    }
}
