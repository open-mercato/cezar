//! The managed Node.js runtime (#1403, spec 2026-09-25-desktop-distribution § "The Node.js
//! prerequisite"): the LAST fallback when the user has no Node 20+ anywhere. The official release
//! for this platform is downloaded from nodejs.org, checked against the release's
//! `SHASUMS256.txt`, unpacked into a staging folder and renamed into `~/.cezar/node/<version>/`
//! only once it runs — so an interrupted or failed install never leaves a usable-looking runtime.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::{parse_node_version, NODE_EXE};

const DIST: &str = "https://nodejs.org/dist";
/// Written last; a version folder without it is an incomplete install and is never used.
const MANIFEST: &str = ".cezar-node.json";
const STAGING_PREFIX: &str = ".staging-";

/// The official release file for one platform: its key in `index.json`'s `files`, and its name.
#[derive(Debug, PartialEq)]
pub struct Asset {
    key: &'static str,
    platform: &'static str,
    ext: &'static str,
}

impl Asset {
    pub fn file_name(&self, version: &str) -> String {
        format!("node-v{version}-{}.{}", self.platform, self.ext)
    }
}

/// `std::env::consts::{OS, ARCH}` → the release asset, or None where nodejs.org ships none.
pub fn platform_asset(os: &str, arch: &str) -> Option<Asset> {
    let (key, platform, ext) = match (os, arch) {
        ("macos", "aarch64") => ("osx-arm64-tar", "darwin-arm64", "tar.gz"),
        ("macos", "x86_64") => ("osx-x64-tar", "darwin-x64", "tar.gz"),
        ("linux", "x86_64") => ("linux-x64", "linux-x64", "tar.gz"),
        ("linux", "aarch64") => ("linux-arm64", "linux-arm64", "tar.gz"),
        ("windows", "x86_64") => ("win-x64-zip", "win-x64", "zip"),
        ("windows", "aarch64") => ("win-arm64-zip", "win-arm64", "zip"),
        _ => return None,
    };
    Some(Asset { key, platform, ext })
}

pub fn current_asset() -> Option<Asset> {
    platform_asset(std::env::consts::OS, std::env::consts::ARCH)
}

/// From nodejs.org's `index.json`: the newest release of `major` (an update stays in its line),
/// or, for a first install, the newest LTS. Only releases that ship `asset` and are 20+ count.
pub fn pick_release(index: &str, asset: &Asset, major: Option<u32>) -> Option<String> {
    let releases = serde_json::from_str::<serde_json::Value>(index).ok()?;
    releases
        .as_array()?
        .iter()
        .filter_map(|release| {
            let version = release.get("version")?.as_str()?.trim_start_matches('v');
            let parsed = parse_node_version(version)?;
            let lts = release.get("lts").is_some_and(|lts| lts.is_string());
            let ships = release.get("files")?.as_array()?.iter().any(|file| file.as_str() == Some(asset.key));
            let wanted = match major {
                Some(major) => parsed.0 == major,
                None => lts,
            };
            (ships && wanted && parsed.0 >= 20).then(|| (parsed, version.to_string()))
        })
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, version)| version)
}

/// The SHA-256 `SHASUMS256.txt` lists for `file_name` (lowercase hex).
pub fn expected_sha(shasums: &str, file_name: &str) -> Option<String> {
    shasums.lines().find_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        (name.trim() == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

/// The folder holding `node` inside an unpacked release.
pub fn bin_dir(install: &Path) -> PathBuf {
    if cfg!(windows) {
        install.to_path_buf()
    } else {
        install.join("bin")
    }
}

/// Complete installs under `root`, newest first: `(version, folder)`.
pub fn installed(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut found: Vec<((u32, u32, u32), String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let parsed = parse_node_version(&name).filter(|_| !name.starts_with("node@"))?;
            let dir = entry.path();
            (dir.join(MANIFEST).is_file() && bin_dir(&dir).join(NODE_EXE).is_file()).then_some((parsed, name, dir))
        })
        .collect();
    found.sort_by_key(|(parsed, _, _)| std::cmp::Reverse(*parsed));
    found.into_iter().map(|(_, version, dir)| (version, dir)).collect()
}

/// Put `version` in place under `root`. `download` writes the release archive into the file it
/// is given; the archive must hash to `sha256`; `check` must accept the unpacked `bin` folder
/// (the binary has to RUN here — a wrong architecture or libc fails now, not at boot). Anything
/// that fails removes the staging folder, so nothing half-installed is left behind.
pub fn install(
    root: &Path,
    version: &str,
    asset: &Asset,
    sha256: &str,
    download: impl FnOnce(&mut File) -> Result<(), String>,
    check: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    if parse_node_version(version).is_none() {
        return Err(format!("refusing Node.js version id: {version}"));
    }
    std::fs::create_dir_all(root).map_err(|error| format!("{}: {error}", root.display()))?;
    remove_stale_staging(root, Duration::from_secs(3600));
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let staging = root.join(format!("{STAGING_PREFIX}{}-{nanos}", std::process::id()));
    let result = (|| {
        std::fs::create_dir_all(&staging).map_err(|error| format!("{}: {error}", staging.display()))?;
        let archive = staging.join(asset.file_name(version));
        let mut file = File::create(&archive).map_err(|error| format!("{}: {error}", archive.display()))?;
        download(&mut file)?;
        file.flush().and_then(|_| file.sync_all()).map_err(|error| format!("could not write the download: {error}"))?;
        drop(file);
        let actual = sha256_of(&archive)?;
        if !actual.eq_ignore_ascii_case(sha256) {
            return Err(format!("{} failed its checksum (expected {sha256}, got {actual}).", asset.file_name(version)));
        }
        let unpacked = staging.join("node");
        if asset.ext == "zip" {
            unpack_zip(&archive, &unpacked)?;
        } else {
            unpack_tar_gz(&archive, &unpacked)?;
        }
        check(&bin_dir(&unpacked))?;
        let record = serde_json::json!({ "version": version, "source": DIST, "sha256": sha256, "installedAt": crate::iso_now() });
        std::fs::write(unpacked.join(MANIFEST), format!("{record}\n")).map_err(|error| error.to_string())?;
        let target = root.join(version);
        if !(target.join(MANIFEST).is_file() && bin_dir(&target).join(NODE_EXE).is_file()) {
            if target.exists() {
                std::fs::remove_dir_all(&target).map_err(|error| format!("{}: {error}", target.display()))?;
            }
            std::fs::rename(&unpacked, &target).map_err(|error| format!("{}: {error}", target.display()))?;
        }
        Ok(target)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Remove every install but the newest and `keep` (the one running — Windows cannot delete it,
/// and npm would lose its Node mid-command elsewhere). The manifest goes first, so a removal cut
/// short leaves a folder `installed` ignores rather than a broken runtime it would pick.
pub fn prune(root: &Path, keep: &Path) {
    let newest = installed(root).into_iter().next().map(|(_, dir)| dir);
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(STAGING_PREFIX) || Some(&dir) == newest.as_ref() || keep.starts_with(&dir) || !dir.is_dir() {
            continue;
        }
        let _ = std::fs::remove_file(dir.join(MANIFEST));
        let _ = std::fs::remove_dir_all(&dir);
    }
    remove_stale_staging(root, Duration::from_secs(3600));
}

/// A staging folder an interrupted install left behind — older than `age`, so a download still
/// running in another window is not pulled out from under it.
fn remove_stale_staging(root: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
            continue;
        }
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_none_or(|elapsed| elapsed >= age);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `node-v22.11.0-darwin-arm64/bin/node` → `bin/node`; None for the top folder itself and for
/// anything that would land outside it.
fn inside(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    components.next()?;
    let rest: PathBuf = components.collect();
    let safe = rest.components().all(|component| matches!(component, Component::Normal(_)));
    (safe && !rest.as_os_str().is_empty()).then_some(rest)
}

fn unpack_tar_gz(archive: &Path, out: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    std::fs::create_dir_all(out).map_err(|error| error.to_string())?;
    let broken = |error: std::io::Error| format!("could not unpack the Node.js archive: {error}");
    for entry in tar.entries().map_err(broken)? {
        let mut entry = entry.map_err(broken)?;
        let path = entry.path().map_err(broken)?.into_owned();
        let Some(rel) = inside(&path) else { continue };
        // Each link checked alone is not enough: `a -> ..` then `a/b -> ../..` escapes.
        if through_link(out, &rel) {
            return Err(format!("the Node.js archive writes {} through a link", rel.display()));
        }
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(broken)?;
        }
        if entry.header().entry_type().is_hard_link() {
            // Named from the archive's top folder; `Entry::unpack` would resolve it from the cwd.
            let target = entry.link_name().map_err(broken)?.and_then(|target| inside(&target));
            // A regular file only: a hard link to a symlink would move it to another depth.
            let regular = |target: &PathBuf| std::fs::symlink_metadata(out.join(target)).is_ok_and(|meta| meta.file_type().is_file());
            let target = target.filter(|target| !through_link(out, target) && regular(target)).ok_or_else(|| format!("the Node.js archive links {} outside itself", rel.display()))?;
            std::fs::hard_link(out.join(target), &dest).map_err(broken)?;
            continue;
        }
        // A link may only point inside the release (npm's `bin/npm -> ../lib/…`).
        if let Some(target) = entry.link_name().map_err(broken)? {
            if !link_stays_inside(&rel, &target) {
                return Err(format!("the Node.js archive links {} outside itself", rel.display()));
            }
        }
        entry.unpack(&dest).map_err(broken)?;
    }
    Ok(())
}

/// Whether a folder on the way to `rel` under `out` is a link.
fn through_link(out: &Path, rel: &Path) -> bool {
    let mut at = out.to_path_buf();
    rel.parent().into_iter().flat_map(Path::components).any(|component| {
        at.push(component);
        std::fs::symlink_metadata(&at).is_ok_and(|meta| meta.file_type().is_symlink())
    })
}

fn link_stays_inside(link: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    // `..` only as a leading prefix: after a Normal step the kernel may have followed a link,
    // so a later `..` no longer means what the text says (`x -> ..`, then `x/d/../..`).
    let mut depth: i32 = link.components().count() as i32 - 1;
    let mut climbing = true;
    for component in target.components() {
        match component {
            Component::Normal(_) => {
                climbing = false;
                depth += 1
            }
            Component::CurDir => {}
            Component::ParentDir if climbing => depth -= 1,
            _ => return false,
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

fn unpack_zip(archive: &Path, out: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let broken = |error: &dyn std::fmt::Display| format!("could not unpack the Node.js archive: {error}");
    let mut zip = zip::ZipArchive::new(file).map_err(|error| broken(&error))?;
    std::fs::create_dir_all(out).map_err(|error| broken(&error))?;
    for index in 0..zip.len() {
        let mut item = zip.by_index(index).map_err(|error| broken(&error))?;
        let Some(rel) = item.enclosed_name().as_deref().and_then(inside) else { continue };
        let dest = out.join(rel);
        if item.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|error| broken(&error))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|error| broken(&error))?;
        }
        let mut target = File::create(&dest).map_err(|error| broken(&error))?;
        std::io::copy(&mut item, &mut target).map_err(|error| broken(&error))?;
    }
    Ok(())
}

// ---- nodejs.org ----------------------------------------------------------------------------

pub(crate) fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("cezar-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())
}

fn offline(error: reqwest::Error) -> String {
    format!("could not reach nodejs.org ({error}).")
}

/// A small text file from nodejs.org (`index.json`, `SHASUMS256.txt`). Call from a plain thread.
pub fn fetch_text(path: &str) -> Result<String, String> {
    let url = format!("{DIST}/{path}");
    tauri::async_runtime::block_on(async {
        let response = client()?.get(&url).timeout(Duration::from_secs(60)).send().await.map_err(offline)?;
        response.error_for_status().map_err(offline)?.text().await.map_err(offline)
    })
}

/// Stream the release archive into `out`, reporting `(bytes so far, total when known)`.
pub fn fetch_archive(version: &str, asset: &Asset, out: &mut File, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), String> {
    let url = format!("{DIST}/v{version}/{}", asset.file_name(version));
    tauri::async_runtime::block_on(async {
        let mut response = client()?.get(&url).send().await.map_err(offline)?.error_for_status().map_err(offline)?;
        let total = response.content_length();
        let mut done = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(offline)? {
            out.write_all(&chunk).map_err(|error| format!("could not write the download: {error}"))?;
            done += chunk.len() as u64;
            progress(done, total);
        }
        if total.is_some_and(|total| total != done) {
            return Err("the download ended early.".into());
        }
        Ok(())
    })
}

/// The release to install and its checksum: the newest of `major`, or the newest LTS.
pub fn resolve_release(asset: &Asset, major: Option<u32>) -> Result<(String, String), String> {
    let index = fetch_text("index.json")?;
    let version = pick_release(&index, asset, major).ok_or("nodejs.org lists no release for this platform.")?;
    let shasums = fetch_text(&format!("v{version}/SHASUMS256.txt"))?;
    let sha = expected_sha(&shasums, &asset.file_name(&version)).ok_or("the release's SHASUMS256.txt does not list this platform's archive.")?;
    Ok((version, sha))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cez-node-runtime-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn every_supported_platform_names_its_release_file() {
        let mac = platform_asset("macos", "aarch64").unwrap();
        assert_eq!(mac.file_name("22.11.0"), "node-v22.11.0-darwin-arm64.tar.gz");
        assert_eq!(platform_asset("macos", "x86_64").unwrap().file_name("22.11.0"), "node-v22.11.0-darwin-x64.tar.gz");
        assert_eq!(platform_asset("linux", "x86_64").unwrap().file_name("22.11.0"), "node-v22.11.0-linux-x64.tar.gz");
        assert_eq!(platform_asset("linux", "aarch64").unwrap().file_name("22.11.0"), "node-v22.11.0-linux-arm64.tar.gz");
        assert_eq!(platform_asset("windows", "x86_64").unwrap().file_name("22.11.0"), "node-v22.11.0-win-x64.zip");
        assert_eq!(platform_asset("freebsd", "x86_64"), None);
        assert_eq!(platform_asset("linux", "x86"), None);
        assert!(current_asset().is_some() || !cfg!(any(target_os = "macos", windows)));
    }

    const INDEX: &str = r#"[
      {"version":"v24.1.0","lts":false,"files":["osx-arm64-tar","linux-x64"]},
      {"version":"v22.12.0","lts":"Jod","files":["osx-arm64-tar","linux-x64"]},
      {"version":"v22.11.0","lts":"Jod","files":["osx-arm64-tar","linux-x64","win-x64-zip"]},
      {"version":"v20.18.1","lts":"Iron","files":["osx-arm64-tar","linux-x64","win-x64-zip"]},
      {"version":"v18.20.5","lts":"Hydrogen","files":["osx-arm64-tar"]},
      {"version":"bogus","lts":"x","files":["osx-arm64-tar"]}
    ]"#;

    #[test]
    fn a_first_install_takes_the_newest_lts_and_an_update_stays_in_its_line() {
        let mac = platform_asset("macos", "aarch64").unwrap();
        let win = platform_asset("windows", "x86_64").unwrap();
        assert_eq!(pick_release(INDEX, &mac, None).as_deref(), Some("22.12.0"));
        assert_eq!(pick_release(INDEX, &win, None).as_deref(), Some("22.11.0"), "only releases that ship the platform's file");
        assert_eq!(pick_release(INDEX, &mac, Some(20)).as_deref(), Some("20.18.1"));
        assert_eq!(pick_release(INDEX, &mac, Some(24)).as_deref(), Some("24.1.0"));
        assert_eq!(pick_release(INDEX, &mac, Some(18)), None, "never below 20");
        assert_eq!(pick_release("not json", &mac, None), None);
    }

    #[test]
    fn the_checksum_is_read_for_exactly_this_file() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let sums = format!("{a}  node-v22.11.0-darwin-arm64.tar.gz.sig\n{b}  node-v22.11.0-darwin-arm64.tar.gz\nshort  node-v22.11.0-linux-x64.tar.gz\n");
        assert_eq!(expected_sha(&sums, "node-v22.11.0-darwin-arm64.tar.gz"), Some("b".repeat(64)));
        assert_eq!(expected_sha(&sums, "node-v22.11.0-linux-x64.tar.gz"), None);
        assert_eq!(expected_sha(&sums, "node-v22.11.0-win-x64.zip"), None);
    }

    /// A tarball shaped like nodejs.org's: one top folder, `bin/node`, and npm's relative link.
    #[cfg(unix)]
    fn release_tar_gz(version: &str) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let top = format!("node-v{version}-darwin-arm64");
        let node = format!("#!/bin/sh\necho {version}\n");
        let mut header = tar::Header::new_gnu();
        header.set_size(node.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, format!("{top}/bin/node"), node.as_bytes()).unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        builder.append_link(&mut link, format!("{top}/bin/npm"), "../lib/node_modules/npm/bin/npm-cli.js").unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[cfg(unix)]
    fn sha_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[cfg(unix)]
    fn mac() -> Asset {
        platform_asset("macos", "aarch64").unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_verified_release_is_unpacked_into_its_version_folder() {
        let root = scratch("install");
        let archive = release_tar_gz("22.11.0");
        let dir = install(&root, "22.11.0", &mac(), &sha_hex(&archive), |file| file.write_all(&archive).map_err(|e| e.to_string()), |bin| {
            assert!(bin.join("node").is_file());
            Ok(())
        })
        .unwrap();
        assert_eq!(dir, root.join("22.11.0"));
        assert_eq!(std::fs::read_link(dir.join("bin/npm")).unwrap(), PathBuf::from("../lib/node_modules/npm/bin/npm-cli.js"));
        let output = std::process::Command::new(dir.join("bin/node")).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "22.11.0", "the executable bit survived");
        assert_eq!(installed(&root), vec![("22.11.0".to_string(), dir)]);
        assert_eq!(entries(&root), ["22.11.0"], "no staging left behind");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_checksum_mismatch_installs_nothing() {
        let root = scratch("mismatch");
        let archive = release_tar_gz("22.11.0");
        let error = install(&root, "22.11.0", &mac(), &"0".repeat(64), |file| file.write_all(&archive).map_err(|e| e.to_string()), |_| {
            panic!("an unverified archive was unpacked")
        })
        .unwrap_err();
        assert!(error.contains("failed its checksum"), "{error}");
        assert!(installed(&root).is_empty());
        assert!(entries(&root).is_empty(), "{:?}", entries(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Offline, a full disk, a cut connection, a binary that does not run here: each fails the
    /// install with its reason and leaves no runtime, complete or half.
    #[cfg(unix)]
    #[test]
    fn an_interrupted_install_leaves_nothing_behind() {
        let root = scratch("interrupted");
        let archive = release_tar_gz("22.11.0");
        let sha = sha_hex(&archive);
        let cut = |file: &mut File| {
            file.write_all(&archive[..archive.len() / 2]).unwrap();
            Err("the download ended early.".to_string())
        };
        assert_eq!(install(&root, "22.11.0", &mac(), &sha, cut, |_| Ok(())).unwrap_err(), "the download ended early.");
        let truncated = |file: &mut File| file.write_all(&archive[..archive.len() / 2]).map_err(|e| e.to_string());
        assert!(install(&root, "22.11.0", &mac(), &sha, truncated, |_| Ok(())).unwrap_err().contains("checksum"));
        let full = |file: &mut File| file.write_all(&archive).map_err(|e| e.to_string());
        let wont_run = |_: &Path| Err("the downloaded Node.js does not run on this machine.".to_string());
        assert!(install(&root, "22.11.0", &mac(), &sha, full, wont_run).unwrap_err().contains("does not run"));
        assert!(install(&root, "../x", &mac(), &sha, |_| Ok(()), |_| Ok(())).unwrap_err().contains("refusing"));
        assert!(installed(&root).is_empty());
        assert!(entries(&root).is_empty(), "{:?}", entries(&root));

        // A folder an earlier, killed install left (no manifest) is replaced, not trusted.
        std::fs::create_dir_all(root.join("22.11.0/bin")).unwrap();
        std::fs::write(root.join("22.11.0/bin/node"), "stale").unwrap();
        assert!(installed(&root).is_empty());
        let full = |file: &mut File| file.write_all(&archive).map_err(|e| e.to_string());
        install(&root, "22.11.0", &mac(), &sha, full, |_| Ok(())).unwrap();
        assert_ne!(std::fs::read_to_string(root.join("22.11.0/bin/node")).unwrap(), "stale");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn an_archive_that_reaches_outside_itself_is_refused() {
        let root = scratch("escape");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        builder.append_link(&mut link, "node-v22.11.0-darwin-arm64/bin", "../../../etc").unwrap();
        let archive = builder.into_inner().unwrap().finish().unwrap();
        let error = install(&root, "22.11.0", &mac(), &sha_hex(&archive), |file| file.write_all(&archive).map_err(|e| e.to_string()), |_| Ok(()))
            .unwrap_err();
        assert!(error.contains("outside itself"), "{error}");
        assert!(entries(&root).is_empty());
        assert!(link_stays_inside(Path::new("bin/npm"), Path::new("../lib/node_modules/npm/bin/npm-cli.js")));
        assert!(!link_stays_inside(Path::new("bin/npm"), Path::new("../../x")));
        assert!(!link_stays_inside(Path::new("bin/npm"), Path::new("/usr/bin/node")));
        assert!(link_stays_inside(Path::new("bin/npm"), Path::new("./../lib/npm")));
        // With `d/x -> ..` unpacked, `x/d/x/..` is not `x/d`: the text cannot be trusted.
        assert!(!link_stays_inside(Path::new("d/y"), Path::new("x/d/x/d/x/../../..")));
        assert!(!link_stays_inside(Path::new("d/y"), Path::new("x/..")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_link_to_a_link_is_refused() {
        let root = scratch("hardlink-to-link");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let top = "node-v22.11.0-darwin-arm64";
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        builder.append_link(&mut link, format!("{top}/a/b/s"), "../../x").unwrap();
        let mut hard = tar::Header::new_gnu();
        hard.set_entry_type(tar::EntryType::Link);
        hard.set_size(0);
        builder.append_link(&mut hard, format!("{top}/s2"), format!("{top}/a/b/s")).unwrap();
        let archive = builder.into_inner().unwrap().finish().unwrap();
        let error = install(&root, "22.11.0", &mac(), &sha_hex(&archive), |file| file.write_all(&archive).map_err(|e| e.to_string()), |_| Ok(()))
            .unwrap_err();
        assert!(error.contains("outside itself"), "{error}");
        assert!(entries(&root).is_empty(), "{:?}", entries(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Each link stays inside on its own, but `l1/l2` really sits at the top folder (`l1 -> ..`),
    /// so `l2 -> ../..` reaches `~/.cezar/node` — nothing may be written through a link.
    #[cfg(unix)]
    #[test]
    fn a_chain_of_links_cannot_reach_outside_either() {
        let root = scratch("chain");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let top = "node-v22.11.0-darwin-arm64";
        for (path, target) in [(format!("{top}/d1/l1"), ".."), (format!("{top}/d1/l1/l2"), "../..")] {
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            builder.append_link(&mut link, path, target).unwrap();
        }
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, format!("{top}/d1/l1/l2/escaped"), &b"x"[..]).unwrap();
        let archive = builder.into_inner().unwrap().finish().unwrap();
        let error = install(&root, "22.11.0", &mac(), &sha_hex(&archive), |file| file.write_all(&archive).map_err(|e| e.to_string()), |_| Ok(()))
            .unwrap_err();
        assert!(error.contains("through a link"), "{error}");
        assert!(entries(&root).is_empty(), "{:?}", entries(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hard link names its target from the archive's top, not from where the link sits.
    #[cfg(unix)]
    #[test]
    fn a_hard_link_points_at_its_file_inside_the_release() {
        let root = scratch("hardlink");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let top = "node-v22.11.0-darwin-arm64";
        let node = b"#!/bin/sh\necho 22.11.0\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(node.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, format!("{top}/bin/node"), &node[..]).unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Link);
        link.set_size(0);
        builder.append_link(&mut link, format!("{top}/lib/node"), format!("{top}/bin/node")).unwrap();
        let archive = builder.into_inner().unwrap().finish().unwrap();
        let dir = install(&root, "22.11.0", &mac(), &sha_hex(&archive), |file| file.write_all(&archive).map_err(|e| e.to_string()), |_| Ok(())).unwrap();
        assert_eq!(std::fs::read(dir.join("lib/node")).unwrap(), node);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_windows_zip_is_unpacked_without_its_top_folder() {
        let root = scratch("zip");
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.add_directory("node-v22.11.0-win-x64/", options).unwrap();
        writer.start_file("node-v22.11.0-win-x64/node.exe", options).unwrap();
        writer.write_all(b"MZ").unwrap();
        writer.start_file("node-v22.11.0-win-x64/node_modules/npm/package.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file("../evil.txt", options).unwrap();
        writer.write_all(b"x").unwrap();
        let archive = writer.finish().unwrap().into_inner();
        let path = root.join("node.zip");
        std::fs::write(&path, &archive).unwrap();
        unpack_zip(&path, &root.join("out")).unwrap();
        assert_eq!(std::fs::read(root.join("out/node.exe")).unwrap(), b"MZ");
        assert!(root.join("out/node_modules/npm/package.json").is_file());
        assert!(!root.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn fake_install(root: &Path, version: &str, complete: bool) {
        let bin = bin_dir(&root.join(version));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(NODE_EXE), "").unwrap();
        if complete {
            std::fs::write(root.join(version).join(MANIFEST), "{}").unwrap();
        }
    }

    #[test]
    fn pruning_keeps_the_newest_and_the_running_runtime() {
        let root = scratch("prune");
        fake_install(&root, "22.9.0", true);
        fake_install(&root, "22.10.0", true);
        fake_install(&root, "22.12.0", true);
        fake_install(&root, "22.13.0", false); // a killed install
        std::fs::create_dir_all(root.join(format!("{STAGING_PREFIX}1-2"))).unwrap(); // in progress
        assert_eq!(installed(&root).into_iter().map(|(v, _)| v).collect::<Vec<_>>(), ["22.12.0", "22.10.0", "22.9.0"]);
        prune(&root, &bin_dir(&root.join("22.10.0")));
        assert_eq!(entries(&root), [format!("{STAGING_PREFIX}1-2"), "22.10.0".into(), "22.12.0".into()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The real thing, end to end: the newest LTS for this machine, checksum and all.
    #[test]
    #[ignore = "downloads Node.js from nodejs.org"]
    fn installs_the_real_release() {
        let root = scratch("real");
        let asset = current_asset().expect("a supported platform");
        let (version, sha) = resolve_release(&asset, None).unwrap();
        let dir = install(&root, &version, &asset, &sha, |file| fetch_archive(&version, &asset, file, &mut |_, _| {}), |bin| {
            crate::find_node_in(&[bin.to_path_buf()]).map(|_| ()).ok_or_else(|| "does not run".to_string())
        })
        .unwrap();
        assert!(bin_dir(&dir).join(NODE_EXE).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }
}
