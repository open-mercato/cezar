import Foundation

/// Decides whether the app must ask for the phone's credential now (spec QR3). Pure: the caller
/// passes a monotonic clock in milliseconds, which a changed wall clock cannot move.
final class LockPolicy {
    /// How long the app may stay in the background without a new prompt (spec QR3).
    static let timeoutMs: Int64 = 60_000
    private static let notAway: Int64 = -1

    private var passedFlag = false
    private var leftAt = LockPolicy.notAway
    private var prompting = false
    private var offered = false

    func promptNeeded(enabled: Bool) -> Bool {
        enabled && !passedFlag
    }

    /// At most one automatic prompt per return: a cancel falls back to the Unlock button, not a loop.
    func autoPrompt(enabled: Bool) -> Bool {
        promptNeeded(enabled: enabled) && !prompting && !offered
    }

    /// Recorded during a prompt too: pressing Home on a toggle's prompt must still start the timeout.
    func left(now: Int64, changingConfigurations: Bool = false) {
        if changingConfigurations { return }
        if leftAt == LockPolicy.notAway { leftAt = now }
        if !prompting { offered = false }
    }

    func returned(now: Int64) {
        if leftAt == LockPolicy.notAway { return }
        let away = now - leftAt
        leftAt = LockPolicy.notAway
        if away < 0 || away >= LockPolicy.timeoutMs { passedFlag = false }
    }

    func promptStarted() {
        prompting = true
        offered = true
    }

    func promptEnded() {
        prompting = false
    }

    func passed() {
        passedFlag = true
        leftAt = LockPolicy.notAway
        offered = false
    }
}
