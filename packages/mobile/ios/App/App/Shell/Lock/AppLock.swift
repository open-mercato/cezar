import LocalAuthentication
import UIKit

/// The optional lock (spec QR3). A UI gate over the app's window, never a key-release gate: it
/// holds no key and no key depends on it. Main thread, except `enabled`.
///
/// Wiring: call `AppLock.shared.install(on: window)` once the window exists. It listens to the
/// application's own lifecycle notifications, so SceneDelegate needs nothing else.
final class AppLock {
    static let shared = AppLock()

    private let policy = LockPolicy()
    private let setting: LockSetting
    private var shield: LockShield?
    private weak var window: UIWindow?
    private var afterUnlock: (() -> Void)?
    private(set) var enabled: Bool

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        setting = LockSetting(directory: support)
        enabled = setting.enabled()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// Whether the phone has a passcode (Face ID and Touch ID cannot exist without one).
    func available() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// Dormant with no passcode: removing one takes that credential, so this adds no exposure (spec QR3).
    private func active() -> Bool {
        enabled && available()
    }

    private func locked() -> Bool {
        policy.promptNeeded(enabled: active())
    }

    /// Call from the scene setup. A cold start is locked until the first unlock, so the shield goes up now.
    func install(on window: UIWindow) {
        self.window = window
        apply()
        if locked() { unlockIfOffered() }
    }

    /// Runs now, or after the unlock. Only the newest waits: a reloaded page's launch replaces the old one.
    func whenUnlocked(run work: @escaping () -> Void) {
        if !locked() {
            work()
            return
        }
        afterUnlock = work
    }

    /// Both directions need the credential. `done` gets nil, or why nothing changed.
    func change(on: Bool, done: @escaping (String?) -> Void) {
        if !available() {
            done("Set a passcode on this phone first.")
            return
        }
        authenticate(reason: on ? "Turn on app lock" : "Turn off app lock") { [self] error in
            if let error {
                done(error)
                return
            }
            do {
                try setting.set(on)
            } catch {
                done(error.localizedDescription)
                return
            }
            enabled = on
            policy.passed()
            apply()
            done(nil)
        }
    }

    private func authenticate(reason: String, done: @escaping (String?) -> Void) {
        policy.promptStarted()
        // .deviceOwnerAuthentication: Face ID / Touch ID, falling back to the passcode.
        LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [self] success, error in
            DispatchQueue.main.async {
                self.policy.promptEnded()
                done(success ? nil : (error?.localizedDescription ?? "Could not unlock."))
            }
        }
    }

    private func unlock() {
        authenticate(reason: "Unlock Cezar") { [self] error in
            if let error {
                shield?.show(error)
                return
            }
            policy.passed()
            apply()
            flush()
        }
    }

    private func unlockIfOffered() {
        if policy.autoPrompt(enabled: active()) { unlock() }
    }

    private func flush() {
        let work = afterUnlock
        afterUnlock = nil
        work?()
    }

    /// Hidden, not only covered: an invisible page has no focus, so a screen reader cannot reach it.
    private func apply() {
        guard let window else { return }
        let lockedNow = locked()
        if lockedNow {
            raise(on: window).show("")
        } else {
            removeShield()
        }
        // The server view is presented over the root: hide it too, never dismiss it, or its page is lost.
        var controller = window.rootViewController
        while let current = controller {
            current.view.isHidden = lockedNow
            controller = current.presentedViewController
        }
    }

    private func raise(on window: UIWindow) -> LockShield {
        let view = shield ?? LockShield { [weak self] in self?.unlock() }
        if shield == nil {
            view.frame = window.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            shield = view
        }
        if view.superview !== window { window.addSubview(view) }
        window.bringSubviewToFront(view)
        return view
    }

    private func removeShield() {
        shield?.removeFromSuperview()
        shield = nil
    }

    /// The snapshot is taken on the way out: cover now, whether or not the timeout will lock.
    @objc private func willResignActive() {
        if active(), let window { _ = raise(on: window) }
    }

    @objc private func didEnterBackground() {
        policy.left(now: Self.now())
    }

    @objc private func willEnterForeground() {
        policy.returned(now: Self.now())
        apply()
    }

    @objc private func didBecomeActive() {
        // The credential sheet itself deactivates the app: keep the shield up for it.
        apply()
        if locked() { unlockIfOffered() } else { flush() }
    }

    /// Monotonic and counting sleep, like Android's elapsedRealtime.
    private static func now() -> Int64 {
        Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000)
    }
}
