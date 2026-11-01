//! The macOS notch (spec `.ai/specs/2026-11-01-desktop-notch.md`): one panel over the camera
//! housing showing the managers that are active. `notch_model` decides what shows and
//! `notch_geometry` where; this file is the AppKit and the plumbing.
//!
//! Nothing here exists until a manager is active: the panel and its web process are created on
//! first need, and hidden panels stop the pointer thread. Hover is sampled here because WebKit
//! gives a window that can never become key no hover of its own, and the fixed-size transparent
//! panel lets clicks through with `ignoresMouseEvents` everywhere but on the shapes.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use objc2::runtime::AnyObject;
use objc2::{define_class, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSColor, NSEvent, NSPanel, NSResponder, NSScreen, NSWindow, NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::notch_geometry::{place, pointer_on_shape, screen_at, Hover, PanelSize, Placement, Rect, ScreenMetrics};
use crate::notch_model::{parse_list, shape, NotchModel, ERROR_ACTIVE_MINUTES};
use crate::Shell;

const LABEL: &str = "notch";
const LAYOUT: &str = include_str!("../../ui/notch/layout.json");
/// While someone is active the list changes with every turn.
const ACTIVE_POLL: Duration = Duration::from_secs(4);
/// One loopback GET; the workspace event stream would wake this thread for every task's frames.
const IDLE_POLL: Duration = Duration::from_secs(30);
/// Until the supervisor has a sidecar to ask.
const BOOT_POLL: Duration = Duration::from_secs(2);
/// `CEZ_MANAGERS=0`, or a managed version that predates managers.
const NO_ROUTE_POLL: Duration = Duration::from_secs(300);
/// Failed polls a shown notch survives, so a busy sidecar does not make it blink.
const TOLERATED_FAILURES: u32 = 2;
const POINTER_TICK: Duration = Duration::from_millis(70);
/// About a second of pointer ticks between display checks.
const SCREEN_CHECK_TICKS: u32 = 14;
/// Longer than the page's fold-away, so the panel leaves after the animation, not during it.
const HIDE_AFTER: Duration = Duration::from_millis(460);
const BODY_CAP: u64 = 8 * 1024 * 1024;

define_class!(
    /// `NonactivatingPanel` only means something on an `NSPanel`, and only such a window can take
    /// a click without activating the app. tao builds plain windows, so `configure` swaps the class.
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CezarNotchPanel"]
    struct NotchPanel;

    impl NotchPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            false
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            false
        }
    }
);

#[derive(Default)]
struct View {
    model: Option<NotchModel>,
    placement: Option<Placement>,
    /// The shapes in page coordinates, as the page last reported them.
    rects: Vec<Rect>,
    hover: Hover,
    /// Whether clicks currently land on the panel.
    interactive: bool,
    /// The panel is ordered in; the pointer thread runs only then.
    shown: bool,
    pointer: Option<(f64, f64)>,
}

pub struct Notch {
    enabled: AtomicBool,
    view: Mutex<View>,
    /// Pulsed by the toggle, so it applies now and not at the next poll.
    poll_gate: (Mutex<bool>, Condvar),
    pointer_wake: Condvar,
    epoch: Instant,
}

impl Notch {
    fn view(&self) -> MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wake_poller(&self) {
        *self.poll_gate.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.poll_gate.1.notify_all();
    }

    fn sleep_poller(&self, timeout: Option<Duration>) {
        let mut woken = self.poll_gate.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match timeout {
            Some(timeout) => {
                let (next, _) = self.poll_gate.1.wait_timeout_while(woken, timeout, |woken| !*woken).unwrap_or_else(|poisoned| poisoned.into_inner());
                woken = next;
            }
            None => {
                woken = self.poll_gate.1.wait_while(woken, |woken| !*woken).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        *woken = false;
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }
}

fn panel_size() -> PanelSize {
    #[derive(serde::Deserialize)]
    struct Layout {
        window: PanelSize,
    }
    serde_json::from_str::<Layout>(LAYOUT).expect("layout.json names the window size").window
}

fn settings_path() -> PathBuf {
    crate::cezar_home().join("desktop-notch.json")
}

/// On unless the user turned it off: without an active manager there is nothing on screen. A
/// missing or corrupt file is the default.
fn read_enabled() -> bool {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("enabled")?.as_bool())
        .unwrap_or(true)
}

fn write_enabled(enabled: bool) {
    let path = settings_path();
    if let Some(home) = path.parent() {
        let _ = std::fs::create_dir_all(home);
    }
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::json!({ "enabled": enabled }).to_string();
    if std::fs::write(&temporary, body).is_ok() {
        let _ = std::fs::rename(&temporary, &path);
    }
}

enum Fetched {
    Body(String),
    /// The sidecar answered, and has no managers to give.
    NoRoute,
    Failed,
}

fn fetch_managers(port: u16) -> Fetched {
    let Ok(address) = format!("127.0.0.1:{port}").parse() else { return Fetched::Failed };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else { return Fetched::Failed };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /api/v1/workspace/managers HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Fetched::Failed;
    }
    let mut buffer = Vec::new();
    if stream.take(BODY_CAP).read_to_end(&mut buffer).is_err() {
        return Fetched::Failed;
    }
    read_response(&String::from_utf8_lossy(&buffer))
}

fn read_response(raw: &str) -> Fetched {
    let status = raw.split_whitespace().nth(1).unwrap_or("");
    match status {
        "200" => raw.split_once("\r\n\r\n").map_or(Fetched::Failed, |(_, body)| Fetched::Body(body.to_string())),
        "404" | "409" => Fetched::NoRoute,
        _ => Fetched::Failed,
    }
}

fn error_since() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
    crate::iso_from_unix(now.saturating_sub(ERROR_ACTIVE_MINUTES * 60))
}

fn poll_loop(app: AppHandle, shell: Arc<Shell>, notch: Arc<Notch>) {
    let mut failures = 0;
    loop {
        if !notch.enabled.load(Ordering::SeqCst) {
            failures = 0;
            publish(&app, &notch, None);
            notch.sleep_poller(None);
            continue;
        }
        let port = shell.port.load(Ordering::SeqCst);
        if port == 0 {
            notch.sleep_poller(Some(BOOT_POLL));
            continue;
        }
        let fetched = fetch_managers(port);
        let next = match fetched {
            Fetched::Body(body) => match parse_list(&body) {
                Some(rows) => {
                    failures = 0;
                    let model = shape(&rows, &error_since());
                    let next = if model.is_some() { ACTIVE_POLL } else { IDLE_POLL };
                    publish(&app, &notch, model);
                    next
                }
                None => {
                    publish(&app, &notch, None);
                    NO_ROUTE_POLL
                }
            },
            Fetched::NoRoute => {
                failures = 0;
                publish(&app, &notch, None);
                NO_ROUTE_POLL
            }
            Fetched::Failed => {
                failures += 1;
                let shown = notch.view().model.is_some();
                if shown && failures <= TOLERATED_FAILURES {
                    ACTIVE_POLL
                } else {
                    publish(&app, &notch, None);
                    IDLE_POLL
                }
            }
        };
        notch.sleep_poller(Some(next));
    }
}

/// Called off the main thread: creating a webview waits for the event loop.
fn publish(app: &AppHandle, notch: &Arc<Notch>, model: Option<NotchModel>) {
    {
        let mut view = notch.view();
        if view.model == model {
            return;
        }
        view.model = model.clone();
        if model.is_none() {
            view.hover.close();
        }
    }
    if model.is_some() && app.get_webview_window(LABEL).is_none() && build_panel(app).is_err() {
        eprintln!("[notch] the panel could not be created");
        // Forgotten, or the next poll would see no change and never try again.
        notch.view().model = None;
        return;
    }
    let (app, notch) = (app.clone(), notch.clone());
    let main = app.clone();
    let _ = main.run_on_main_thread(move || apply(&app, &notch));
}

fn apply(app: &AppHandle, notch: &Arc<Notch>) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let Some(mtm) = MainThreadMarker::new() else { return };
    if notch.view().model.is_some() {
        let hidden = !notch.view().shown;
        reposition(&window, notch, mtm, hidden);
        push(&window, notch);
        if let Some(panel) = panel_of(&window) {
            panel.orderFrontRegardless();
        }
        notch.view().shown = true;
        notch.pointer_wake.notify_all();
        return;
    }
    push(&window, notch);
    let (app, notch) = (app.clone(), notch.clone());
    std::thread::spawn(move || {
        std::thread::sleep(HIDE_AFTER);
        let main = app.clone();
        let _ = main.run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(LABEL) else { return };
            let mut view = notch.view();
            if view.model.is_none() {
                view.shown = false;
                view.interactive = false;
                view.rects.clear();
                if let Some(panel) = panel_of(&window) {
                    panel.setIgnoresMouseEvents(true);
                    panel.orderOut(None);
                }
            }
        });
    });
}

fn push(window: &WebviewWindow, notch: &Notch) {
    let payload = {
        let view = notch.view();
        let Some(placement) = view.placement else { return };
        render_script(view.model.as_ref(), &placement)
    };
    let _ = window.eval(payload);
}

fn render_script(model: Option<&NotchModel>, placement: &Placement) -> String {
    let housing = serde_json::to_string(&placement.housing).unwrap_or_else(|_| "null".into());
    let model = serde_json::to_string(&model).unwrap_or_else(|_| "null".into());
    format!("window.__notch && window.__notch.render({{ layout: {LAYOUT}, housing: {housing}, model: {model} }})")
}

fn build_panel(app: &AppHandle) -> tauri::Result<()> {
    let size = panel_size();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notch/index.html".into()))
        .title("Cezar notch")
        .inner_size(size.width, size.height)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .focusable(false)
        .always_on_top(true)
        .shadow(false)
        // The panel is mostly nothing. A transparent background is wry's `background_color` path,
        // which needs neither `macOSPrivateApi` nor Tauri's `transparent`.
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .accept_first_mouse(true)
        .disable_drag_drop_handler()
        .on_navigation(|url| url.scheme() == "tauri")
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    let (sent, received) = std::sync::mpsc::channel();
    let configured = window.clone();
    app.run_on_main_thread(move || {
        configure(&configured);
        let _ = sent.send(());
    })?;
    let _ = received.recv_timeout(Duration::from_secs(2));
    Ok(())
}

/// The window as an `NSPanel`, once `configure` made it one.
fn panel_of(window: &WebviewWindow) -> Option<&NSPanel> {
    let pointer = window.ns_window().ok()? as *const NSPanel;
    // SAFETY: tao keeps the window alive as long as the `WebviewWindow`, and `configure` runs
    // before anything reaches here, so the object is an `NSPanel` subclass.
    unsafe { pointer.as_ref() }
}

fn configure(window: &WebviewWindow) {
    let Ok(pointer) = window.ns_window() else { return };
    // SAFETY: an NSWindow subclass swapped for an NSPanel subclass, which adds no storage; tao
    // keeps its state in the same instance and its overrides here are only for key and drag.
    unsafe {
        let object = pointer as *mut AnyObject;
        AnyObject::set_class(&*object, NotchPanel::class());
    }
    let Some(panel) = panel_of(window) else { return };
    panel.setStyleMask(NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel);
    panel.setFloatingPanel(true);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setWorksWhenModal(true);
    panel.setHidesOnDeactivate(false);
    // Over the menu bar (24) and under the menus that open from it (101).
    panel.setLevel(25);
    // Every Space, full-screen ones included, and out of Mission Control and ⌘`.
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    // The page animates itself; AppKit's own appear scale would fight it.
    panel.setAnimationBehavior(NSWindowAnimationBehavior::None);
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(false);
    panel.setExcludedFromWindowsMenu(true);
    panel.setIgnoresMouseEvents(true);
}

fn read_screens(mtm: MainThreadMarker) -> Vec<ScreenMetrics> {
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| {
            let frame = screen.frame();
            let visible = screen.visibleFrame();
            ScreenMetrics {
                frame: Rect { x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height },
                visible_top: visible.origin.y + visible.size.height,
                safe_area_top: screen.safeAreaInsets().top,
                aux_left_width: screen.auxiliaryTopLeftArea().size.width,
                aux_right_width: screen.auxiliaryTopRightArea().size.width,
            }
        })
        .collect()
}

/// The panel lives on the display the pointer is on. An open list stays put until it folds; a fresh
/// show always places.
fn reposition(window: &WebviewWindow, notch: &Notch, mtm: MainThreadMarker, force: bool) {
    let screens = read_screens(mtm);
    let at = NSEvent::mouseLocation();
    let Some(index) = screen_at(&screens, at.x, at.y) else { return };
    let size = panel_size();
    let placement = place(&screens[index], size);
    let changed = {
        let mut view = notch.view();
        if !force && view.hover.expanded {
            return;
        }
        let changed = view.placement != Some(placement);
        view.placement = Some(placement);
        changed
    };
    if changed || force {
        if let Some(panel) = panel_of(window) {
            let frame = NSRect::new(NSPoint::new(placement.origin_x, placement.origin_y), NSSize::new(size.width, size.height));
            panel.setFrame_display(frame, true);
        }
    }
    if changed && !force {
        push(window, notch);
    }
}

fn pointer_loop(app: AppHandle, notch: Arc<Notch>) {
    let size = panel_size();
    let mut ticks = 0;
    loop {
        {
            let view = notch.view();
            drop(notch.pointer_wake.wait_while(view, |view| !view.shown).unwrap_or_else(|poisoned| poisoned.into_inner()));
        }
        std::thread::sleep(POINTER_TICK);
        ticks += 1;
        if ticks >= SCREEN_CHECK_TICKS {
            ticks = 0;
            let (handle, notch) = (app.clone(), notch.clone());
            let _ = app.run_on_main_thread(move || {
                if let (Some(window), Some(mtm)) = (handle.get_webview_window(LABEL), MainThreadMarker::new()) {
                    reposition(&window, &notch, mtm, false);
                }
            });
        }
        let at = NSEvent::mouseLocation();
        let mut interactive = None;
        let expanded;
        let mut pointer = None;
        {
            let mut view = notch.view();
            let Some(placement) = view.placement else { continue };
            let on_any = pointer_on_shape(&view.rects, &placement, size, at.x, at.y);
            if on_any != view.interactive {
                view.interactive = on_any;
                interactive = Some(on_any);
            }
            // Pill 1 alone opens on hover: the list does not cover pill 2, so hovering there would
            // open it, leave it and close it again, over and over. Pill 2 takes clicks.
            let on_island = pointer_on_shape(&view.rects[..view.rects.len().min(1)], &placement, size, at.x, at.y);
            expanded = view.hover.step(on_island, notch.now_ms());
            if expanded == Some(false) {
                view.pointer = None;
            }
            if view.hover.expanded && view.pointer != Some((at.x, at.y)) {
                view.pointer = Some((at.x, at.y));
                pointer = Some((at.x - placement.origin_x, placement.origin_y + size.height - at.y));
            }
        }
        let Some(window) = app.get_webview_window(LABEL) else { continue };
        if let Some(on_shape) = interactive {
            let target = window.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(panel) = panel_of(&target) {
                    panel.setIgnoresMouseEvents(!on_shape);
                }
            });
        }
        if let Some(open) = expanded {
            let _ = window.eval(format!("window.__notch && window.__notch.setExpanded({open})"));
        }
        if let Some((x, y)) = pointer {
            let _ = window.eval(format!("window.__notch && window.__notch.pointer({x}, {y})"));
        }
    }
}

/// `setup` calls this. With the toggle off the threads wait and no panel is ever made.
pub fn start(app: &AppHandle, shell: Arc<Shell>) {
    let notch = Arc::new(Notch {
        enabled: AtomicBool::new(read_enabled()),
        view: Mutex::new(View::default()),
        poll_gate: (Mutex::new(false), Condvar::new()),
        pointer_wake: Condvar::new(),
        epoch: Instant::now(),
    });
    app.manage(notch.clone());
    let (poll_app, pointer_app, pointer_notch) = (app.clone(), app.clone(), notch.clone());
    std::thread::spawn(move || poll_loop(poll_app, shell, notch));
    std::thread::spawn(move || pointer_loop(pointer_app, pointer_notch));
}

/// The notch page's commands: that page alone, never the cockpit or anything it framed.
fn caller_is_notch(window: &WebviewWindow) -> bool {
    window.label() == LABEL && crate::caller_is_splash(window)
}

/// At most what the page draws; a longer list is not a page of ours.
const MAX_RECTS: usize = 4;

/// The page's module may run after the load event, and a render before it would be lost, so the
/// page asks once it can draw.
#[tauri::command]
pub fn notch_ready(window: WebviewWindow, notch: tauri::State<'_, Arc<Notch>>) {
    if caller_is_notch(&window) {
        push(&window, &notch);
    }
}

#[tauri::command]
pub fn notch_report_shape(window: WebviewWindow, notch: tauri::State<'_, Arc<Notch>>, rects: Vec<Rect>) {
    if caller_is_notch(&window) && rects.len() <= MAX_RECTS {
        if cfg!(debug_assertions) {
            eprintln!("[notch] shapes {rects:?}");
        }
        notch.view().rects = rects;
    }
}

#[tauri::command]
pub fn notch_expand(window: WebviewWindow, notch: tauri::State<'_, Arc<Notch>>) {
    if caller_is_notch(&window) {
        let now = notch.now_ms();
        notch.view().hover.open(now);
        let _ = window.eval("window.__notch && window.__notch.setExpanded(true)");
    }
}

/// `/manager/:id`, client-side like `OPEN_NEW_TASK_SCRIPT`, so the cockpit keeps its state.
fn open_manager_script(id: &str) -> Option<String> {
    let valid = !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    valid.then(|| {
        format!(
            "(function () {{ var to = {}; if (location.pathname === to) return; history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate', {{ state: null }})); }})();",
            crate::js_string(&format!("/manager/{id}"))
        )
    })
}

#[tauri::command]
pub fn notch_open_manager(app: AppHandle, window: WebviewWindow, shell: tauri::State<'_, Arc<Shell>>, notch: tauri::State<'_, Arc<Notch>>, id: String) {
    if !caller_is_notch(&window) {
        return;
    }
    let Some(script) = open_manager_script(&id) else { return };
    notch.view().hover.dismiss();
    let _ = window.eval("window.__notch && window.__notch.setExpanded(false)");
    let Some(main) = app.get_webview_window("main") else { return };
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    let on_cockpit = main.url().is_ok_and(|url| url.scheme() == "http" && crate::is_own_origin(&url, shell.port.load(Ordering::SeqCst)));
    if on_cockpit {
        let _ = main.eval(script);
    }
}

/// Settings → Notifications reads and writes these (`caller_is_trusted`, like every cockpit command).
#[tauri::command]
pub fn notch_enabled(window: WebviewWindow, shell: tauri::State<'_, Arc<Shell>>, notch: tauri::State<'_, Arc<Notch>>) -> bool {
    crate::caller_is_trusted(&window, &shell) && notch.enabled.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn set_notch_enabled(window: WebviewWindow, shell: tauri::State<'_, Arc<Shell>>, notch: tauri::State<'_, Arc<Notch>>, enabled: bool) {
    if crate::caller_is_trusted(&window, &shell) {
        notch.enabled.store(enabled, Ordering::SeqCst);
        write_enabled(enabled);
        notch.wake_poller();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_file_fits_a_notch_and_a_second_pill() {
        let size = panel_size();
        assert!(size.width >= 800.0 && size.height >= 320.0, "{size:?}");
    }

    #[test]
    fn a_manager_id_never_reaches_a_script_unchecked() {
        assert!(open_manager_script("watcher-1").unwrap().contains("\"/manager/watcher-1\""));
        for hostile in ["", "../settings", "a\"b", "A", "a/b", &"x".repeat(65)] {
            assert_eq!(open_manager_script(hostile), None, "{hostile}");
        }
    }

    #[test]
    fn a_response_says_whether_there_is_anything_to_read() {
        assert!(matches!(read_response("HTTP/1.1 200 OK\r\nA: b\r\n\r\n{}"), Fetched::Body(body) if body == "{}"));
        assert!(matches!(read_response("HTTP/1.1 404 Not Found\r\n\r\n"), Fetched::NoRoute));
        assert!(matches!(read_response("HTTP/1.1 409 Conflict\r\n\r\n{}"), Fetched::NoRoute));
        assert!(matches!(read_response("HTTP/1.1 500 Oops\r\n\r\n"), Fetched::Failed));
        assert!(matches!(read_response(""), Fetched::Failed));
    }

    #[test]
    fn the_render_call_carries_the_layout_and_no_raw_text() {
        let script = render_script(None, &Placement { origin_x: 0.0, origin_y: 0.0, housing: crate::notch_geometry::Housing { width: 200.0, height: 37.0, top: 0.0, centre: 500.0 } });
        assert!(script.contains("model: null"));
        assert!(script.contains("\"maxRows\""));
    }
}
