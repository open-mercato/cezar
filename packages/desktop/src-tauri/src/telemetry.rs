//! Error reports from the shell itself (docs/telemetry.md § "The desktop shell"). The cezar server
//! reports its own errors; this covers what fails in the shell, mostly before that server runs:
//! the managed Node download, the cezar install, a sidecar that never answers or exits.
//!
//! The same opt-in as packages/cezar/src/telemetry.ts, read from the same `~/.cezar/config.json`:
//! only an answer of `granted` for `POLICY_VERSION` sends anything, `CEZ_TELEMETRY=0` /
//! `DO_NOT_TRACK=1` block it even then, and nothing here can ask or grant. A machine that has never
//! shown the cockpit has never answered, so it sends nothing. Fire-and-forget: 3 s, no retries.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

const DEFAULT_URL: &str = "https://stats.openmercato.cloud";
/// `TELEMETRY_POLICY_VERSION` in packages/cezar/src/telemetry.ts. A bump there stops these
/// reports until this is bumped too — the shell fails closed, never open.
const POLICY_VERSION: u64 = 1;
/// Release builds get the product's service id from the `CEZ_TELEMETRY_SERVICE` secret at compile
/// time (desktop-release.yml); every other build reports under the development service.
const SERVICE: &str = match option_env!("CEZ_TELEMETRY_SERVICE") {
    Some(service) if !service.is_empty() => service,
    _ => "01a12ad9-3297-793f-b9e5-81d4df2d1216",
};
/// The shell is its own part of the product, with its own version line (0.1.x, not cezar's).
const RUNTIME: &str = "app-shell";
const TIMEOUT: Duration = Duration::from_secs(3);
const THROTTLE: Duration = Duration::from_secs(60);

static LAST_REPORTED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
/// The failure the splash is showing, kept for its "Send error report" button.
static OFFERED: Mutex<Option<(Failure, String)>> = Mutex::new(None);

/// One failure: a stable `code` (what groups it), the message as the shell shows it, and flat
/// context. Paths in any of them are scrubbed before sending.
#[derive(Clone)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub retriable: bool,
    pub context: Vec<(&'static str, Value)>,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Failure { code, message: message.into(), retriable: false, context: Vec::new() }
    }

    pub fn retriable(mut self) -> Self {
        self.retriable = true;
        self
    }

    pub fn with(mut self, key: &'static str, value: impl Into<Value>) -> Self {
        self.context.push((key, value.into()));
        self
    }
}

/// What the failure page says about its report.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Reported {
    /// The user opted in: it went out on its own.
    Sent,
    /// Not opted in: the page offers a button that sends this one report.
    Offered,
    /// The environment says no (`CEZ_TELEMETRY=0`, `DO_NOT_TRACK=1`, CI): no report, no button.
    Off,
}

impl Reported {
    pub fn as_param(self) -> &'static str {
        match self {
            Reported::Sent => "sent",
            Reported::Offered => "offer",
            Reported::Off => "off",
        }
    }
}

/// A failure the user sees: report it when they opted in, otherwise keep it — with the log the
/// page shows — for the page's "Send error report" button.
pub fn report_or_offer(failure: Failure, log: &str) -> Reported {
    if blocked_here() {
        return Reported::Off;
    }
    if consented() {
        report(failure);
        return Reported::Sent;
    }
    *OFFERED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((failure, log.to_string()));
    Reported::Offered
}

/// The page's button: the user asked to send THIS report, which is its consent. Carries the log
/// the page showed (scrubbed) and no install id. Blocks up to `TIMEOUT`; true when it arrived.
pub fn send_offered() -> bool {
    // Cloned, not taken: a send that fails keeps it for the button's "Try again".
    let Some((mut failure, log)) = OFFERED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() else { return false };
    if blocked_here() {
        return false;
    }
    let tail: String = log.chars().rev().take(1024).collect::<Vec<_>>().into_iter().rev().collect();
    failure.context.push(("report.manual", json!(true)));
    if !tail.is_empty() {
        failure.context.push(("log.tail", json!(tail)));
    }
    let config = read_config().unwrap_or(Value::Null);
    let body = error_body(&failure, None, &Scrubber::new(&config), &crate::iso_now());
    let sent = send(&endpoint(), &body);
    if sent {
        OFFERED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    }
    sent
}

/// Send in the background when the user opted in. Never blocks, never fails.
pub fn report(failure: Failure) {
    if let Some((url, body)) = prepare(&failure) {
        std::thread::spawn(move || send(&url, &body));
    }
}

/// The same, but wait (at most `TIMEOUT` and a little): the panic hook's path, where the process
/// may be about to go.
fn report_and_wait(failure: Failure) {
    if let Some((url, body)) = prepare(&failure) {
        let (done, wait) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            send(&url, &body);
            let _ = done.send(());
        });
        let _ = wait.recv_timeout(TIMEOUT + Duration::from_millis(500));
    }
}

/// Report a panic anywhere in the shell, then let the default hook print it as before.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let stack = std::backtrace::Backtrace::force_capture().to_string();
        report_and_wait(Failure::new("shell_panic", message).with("panic.location", location).with("panic.backtrace", stack));
        default(info);
    }));
}

fn blocked_here() -> bool {
    cfg!(test) || blocked(&|name| std::env::var(name).ok())
}

fn read_config() -> Option<Value> {
    let raw = std::fs::read_to_string(crate::cezar_home().join("config.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn consented() -> bool {
    read_config().is_some_and(|config| consent_granted(&config))
}

fn endpoint() -> String {
    let url = std::env::var("CEZ_TELEMETRY_URL").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| DEFAULT_URL.into());
    format!("{}/track/error", url.trim_end_matches('/'))
}

fn prepare(failure: &Failure) -> Option<(String, Value)> {
    if blocked_here() {
        return None;
    }
    let config = read_config()?;
    if !consent_granted(&config) || throttled(&format!("{}:{}", failure.code, failure.message)) {
        return None;
    }
    let user = config.get("cezarId").and_then(Value::as_str);
    Some((endpoint(), error_body(failure, user, &Scrubber::new(&config), &crate::iso_now())))
}

/// Only an explicit yes for the current policy; anything else — no answer, a no, an older
/// policy, a malformed file — sends nothing.
fn consent_granted(config: &Value) -> bool {
    let answer = config.get("telemetry");
    answer.and_then(|a| a.get("consent")).and_then(Value::as_str) == Some("granted")
        && answer.and_then(|a| a.get("policyVersion")).and_then(Value::as_u64) == Some(POLICY_VERSION)
}

/// `telemetryBlockedBy` in telemetry.ts: the env's no, and automation nobody answered for.
fn blocked(env: &dyn Fn(&str) -> Option<String>) -> bool {
    let is = |name: &str, value: &str| env(name).as_deref() == Some(value);
    if is("CEZ_TELEMETRY", "0") || is("DO_NOT_TRACK", "1") {
        return true;
    }
    if is("CEZ_TELEMETRY", "1") {
        return false;
    }
    env("CI").is_some_and(|v| !v.is_empty()) || is("CEZ_DRY_RUN", "1")
}

fn throttled(key: &str) -> bool {
    let mut guard = LAST_REPORTED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let seen = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    if seen.get(key).is_some_and(|last| now.duration_since(*last) < THROTTLE) {
        return true;
    }
    seen.insert(key.to_string(), now);
    false
}

/// Registered project roots become `<repo>`, the temp dir `<tmp>`, the home directory `~` —
/// longest first, as `scrub` in telemetry.ts.
struct Scrubber(Vec<(String, &'static str)>);

impl Scrubber {
    fn new(config: &Value) -> Self {
        let mut pairs: Vec<(String, &'static str)> = config
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|project| project.get("root").and_then(Value::as_str))
            .map(|root| (root.to_string(), "<repo>"))
            .collect();
        pairs.push((std::env::temp_dir().to_string_lossy().trim_end_matches(['/', '\\']).to_string(), "<tmp>"));
        pairs.push((crate::home_dir().to_string_lossy().into_owned(), "~"));
        Self::from_pairs(pairs)
    }

    fn from_pairs(mut pairs: Vec<(String, &'static str)>) -> Self {
        pairs.retain(|(path, _)| path.len() > 1);
        pairs.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
        Scrubber(pairs)
    }

    fn scrub(&self, text: &str) -> String {
        self.0.iter().fold(text.to_string(), |out, (path, mask)| out.replace(path.as_str(), mask))
    }
}

/// The worker's `/track/error` body. Values are cut to the worker's limits (it rejects, never
/// truncates).
fn error_body(failure: &Failure, user: Option<&str>, scrubber: &Scrubber, occurred_at: &str) -> Value {
    let cut = |text: String, max: usize| text.chars().take(max).collect::<String>();
    let mut context = Map::new();
    let base = [
        ("shell.version_full", json!(env!("CARGO_PKG_VERSION"))),
        ("runtime.arch", json!(std::env::consts::ARCH)),
    ];
    for (key, value) in failure.context.iter().cloned().chain(base).take(50) {
        let value = match value {
            Value::String(text) => Value::String(cut(scrubber.scrub(&text), 1024)),
            Value::Number(_) | Value::Bool(_) | Value::Null => value,
            other => Value::String(cut(scrubber.scrub(&other.to_string()), 1024)),
        };
        context.entry(key.to_string()).or_insert(value);
    }
    let mut body = json!({
        "service": SERVICE,
        "version": shell_version(),
        "platform": crate::platform_name(),
        "runtime": RUNTIME,
        "occurredAt": occurred_at,
        "error": {
            "type": "ShellError",
            "message": cut(scrubber.scrub(&failure.message), 2048),
            "code": failure.code,
            "retriable": failure.retriable,
        },
        "context": context,
    });
    if let Some(user) = user.filter(|id| !id.is_empty() && id.len() <= 128) {
        body["user"] = json!({ "id": user });
    }
    body
}

/// Release builds report their version; a local or CI build without the release stamp is `-dev`,
/// so it never reopens an error resolved for a release.
fn shell_version() -> String {
    let version = env!("CARGO_PKG_VERSION");
    if option_env!("CEZ_TELEMETRY_SERVICE").is_some_and(|s| !s.is_empty()) && !cfg!(debug_assertions) {
        version.to_string()
    } else {
        format!("{version}-dev")
    }
}

fn send(url: &str, body: &Value) -> bool {
    let debug = std::env::var_os("CEZ_TELEMETRY_DEBUG").is_some_and(|v| v == "1");
    let result = tauri::async_runtime::block_on(async {
        let client = crate::node_runtime::client()?;
        let response = client.post(url).timeout(TIMEOUT).json(body).send().await.map_err(|e| e.to_string())?;
        Ok::<_, String>(response.status())
    });
    if debug {
        eprintln!("[telemetry] {url} → {result:?}\n    {body}");
    }
    result.is_ok_and(|status| status.is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_yes_for_this_policy_sends() {
        assert!(consent_granted(&json!({ "telemetry": { "consent": "granted", "policyVersion": 1 } })));
        assert!(!consent_granted(&json!({ "telemetry": { "consent": "denied", "policyVersion": 1 } })));
        assert!(!consent_granted(&json!({ "telemetry": { "consent": "granted", "policyVersion": 2 } })), "a newer policy asks again");
        assert!(!consent_granted(&json!({ "telemetry": { "consent": "granted" } })));
        assert!(!consent_granted(&json!({})), "never asked");
        assert!(!consent_granted(&json!([])));
    }

    #[test]
    fn the_environment_can_block_but_never_grant() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string());
        assert!(!blocked(&env(&[])));
        assert!(blocked(&env(&[("CEZ_TELEMETRY", "0")])));
        assert!(blocked(&env(&[("DO_NOT_TRACK", "1")])));
        assert!(blocked(&env(&[("CEZ_TELEMETRY", "1"), ("DO_NOT_TRACK", "1")])), "a no wins");
        assert!(blocked(&env(&[("CI", "true")])));
        assert!(blocked(&env(&[("CEZ_DRY_RUN", "1")])));
        assert!(!blocked(&env(&[("CI", "true"), ("CEZ_TELEMETRY", "1")])), "lifts the automation block only");
    }

    #[test]
    fn a_report_names_no_path_of_the_user() {
        let scrubber = Scrubber::from_pairs(vec![
            ("/Users/ann".into(), "~"),
            ("/Users/ann/code/acme".into(), "<repo>"),
            ("/var/folders/x/T".into(), "<tmp>"),
            ("/".into(), "?"),
        ]);
        let failure = Failure::new("cezar_install_failed", "/Users/ann/.cezar/versions/.staging-shell-1: Permission denied")
            .with("sidecar.cwd", "/Users/ann/code/acme/sub")
            .with("tmp", "/var/folders/x/T/a")
            .with("exit_code", 1);
        let body = error_body(&failure, Some("0199-id"), &scrubber, "2026-10-12T10:00:00Z");
        assert_eq!(body["error"]["message"], "~/.cezar/versions/.staging-shell-1: Permission denied");
        assert_eq!(body["error"]["code"], "cezar_install_failed");
        assert_eq!(body["context"]["sidecar.cwd"], "<repo>/sub");
        assert_eq!(body["context"]["tmp"], "<tmp>/a");
        assert_eq!(body["context"]["exit_code"], 1);
        assert_eq!(body["context"]["shell.version_full"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["user"]["id"], "0199-id");
        assert_eq!(body["runtime"], "app-shell");
        assert!(body["version"].as_str().unwrap().ends_with("-dev"), "a build without the release stamp is a dev build");
        assert!(!body.to_string().contains("/Users/ann"), "{body}");
    }

    #[test]
    fn a_report_fits_the_workers_limits() {
        let long = "x".repeat(5000);
        let failure = Failure::new("c", long.clone()).retriable().with("k", long.clone());
        let body = error_body(&failure, None, &Scrubber::from_pairs(vec![]), "t");
        assert_eq!(body["error"]["message"].as_str().unwrap().len(), 2048);
        assert_eq!(body["context"]["k"].as_str().unwrap().len(), 1024);
        assert!(body.get("user").is_none(), "no id, no user");
    }

    #[test]
    fn the_same_failure_is_reported_once_a_minute() {
        assert!(!throttled("test:once"));
        assert!(throttled("test:once"));
        assert!(!throttled("test:other"));
    }

    /// The body the worker gets, checked against the worker itself: 202, not 400.
    #[test]
    #[ignore = "sends one report to the development telemetry service"]
    fn the_worker_accepts_a_report() {
        if std::env::var_os("CI").is_some() {
            return; // desktop CI runs `--ignored`; one report per CI run would be noise
        }
        let failure = Failure::new("shell_selftest", "a test report from cezar-desktop's test suite").with("exit_code", 1).with("log.tail", "line one\nline two");
        let body = error_body(&failure, None, &Scrubber::from_pairs(vec![]), &crate::iso_now());
        assert!(send(&format!("{DEFAULT_URL}/track/error"), &body), "{body}");
    }

    #[test]
    fn tests_never_send_or_offer() {
        assert!(prepare(&Failure::new("c", "m")).is_none());
        assert_eq!(report_or_offer(Failure::new("c", "m"), ""), Reported::Off);
        assert!(!send_offered());
    }
}
