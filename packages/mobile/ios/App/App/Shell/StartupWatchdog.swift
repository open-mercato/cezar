import Foundation

/// Decides when the cover over a server page goes, and how (Android's StartupWatchdog). Every step has a
/// deadline a timer checks, so a lost answer, a hung tunnel, a dead content process or a cockpit that
/// never draws ends in the page or in the recovery panel, never in a black screen.
final class StartupWatchdog {
    /// Relay connect and handshake, with nothing on screen yet.
    static let connectMs: Int64 = 10000
    /// From the session (or the start, with a cached shell) to the page's first byte.
    static let firstByteMs: Int64 = 10000
    /// From the first byte to the page's load event.
    static let loadMs: Int64 = 15000
    /// A page with no `#root` (a sign-in page) shows this long after its load event.
    static let paintGraceMs: Int64 = 2000
    /// A cockpit whose `#root` is still empty this long after its load event is not going to draw.
    static let blankMs: Int64 = 6000
    /// Nothing before the load event may take longer.
    static let maxMs: Int64 = 30000

    static let loading = "Loading cockpit…"
    static let blankText = "The cockpit loaded but did not start. cezar may have been updated."

    enum Kind { case wait, reveal, problem, blank }

    struct Decision: Equatable {
        let kind: Kind
        /// wait: the status line. problem and blank: the reason.
        let text: String?
    }

    private let serverLabel: String
    private let relay: Bool
    private var startedAt: Int64 = -1
    private var readyAt: Int64 = -1
    private var firstByteAt: Int64 = -1
    private var loadedAt: Int64 = -1
    private var state: PageCheck.State?
    private var error: String?
    private var terminal: String?
    private var connectProblem: String?
    private var settled: Decision?

    /// `relay`: false for a URL server, which has no relay steps to wait for.
    init(serverLabel: String?, relay: Bool) {
        self.serverLabel = (serverLabel?.isEmpty ?? true) ? "your computer" : serverLabel!
        self.relay = relay
    }

    func start(_ now: Int64) {
        startedAt = now
        readyAt = relay ? -1 : now
        firstByteAt = -1
        loadedAt = -1
        state = nil
        error = nil
        terminal = nil
        settled = nil
    }

    var started: Bool { startedAt >= 0 }

    /// The relay's state: ready, or why not. `terminal` ends the start at once when no page came;
    /// `connectProblem` is what a connect timeout says.
    func relayStatus(ready: Bool, terminal: String?, connectProblem: String?, now: Int64) {
        if ready && readyAt < 0 { readyAt = now }
        self.terminal = terminal
        self.connectProblem = connectProblem
    }

    /// The page committed: its first byte arrived, from the tunnel or from the phone's cache.
    func firstByte(_ now: Int64) {
        if firstByteAt < 0 { firstByteAt = now }
    }

    func loaded(_ now: Int64) {
        firstByte(now)
        if loadedAt < 0 { loadedAt = now }
    }

    /// The last `PageCheck` answer; nil when the script could not run.
    func page(_ answer: PageCheck.State?) {
        state = answer
    }

    /// The main frame failed to load, or was answered with the proxy's own error.
    func failed(_ reason: String) {
        if error == nil { error = reason }
    }

    /// Once anything but wait, it stays so until the next start.
    func decide(_ now: Int64) -> Decision {
        if let settled { return settled }
        let next = evaluate(now)
        if next.kind != .wait { settled = next }
        return next
    }

    private func evaluate(_ now: Int64) -> Decision {
        if startedAt < 0 { return Decision(kind: .wait, text: connecting) }
        if let error { return Decision(kind: .problem, text: error) }
        if state == .painted { return Decision(kind: .reveal, text: nil) }
        let elapsed = now - startedAt
        // A page from the phone's cache can stand without a session; the banner then says why.
        if let terminal, firstByteAt < 0 { return Decision(kind: .problem, text: terminal) }
        if loadedAt >= 0 {
            let since = now - loadedAt
            if PageCheck.healthy(state, expectsRoot: relay) {
                return since >= Self.paintGraceMs ? Decision(kind: .reveal, text: nil) : Decision(kind: .wait, text: Self.loading)
            }
            // An empty `#root`, an error page, or no answer at all: this is the black screen.
            return since >= Self.blankMs ? Decision(kind: .blank, text: Self.blankText) : Decision(kind: .wait, text: Self.loading)
        }
        if firstByteAt >= 0 {
            if now - firstByteAt >= Self.loadMs || elapsed >= Self.maxMs {
                return Decision(kind: .problem, text: "The cockpit started loading but did not finish.")
            }
            return Decision(kind: .wait, text: Self.loading)
        }
        if readyAt < 0 {
            if elapsed >= Self.connectMs { return Decision(kind: .problem, text: connectProblem ?? "The relay connection timed out.") }
            return Decision(kind: .wait, text: connecting)
        }
        if now - readyAt >= Self.firstByteMs || elapsed >= Self.maxMs {
            return Decision(kind: .problem, text: "Connected, but cezar did not send the cockpit.")
        }
        return Decision(kind: .wait, text: Self.loading)
    }

    private var connecting: String { "Connecting to \(serverLabel)…" }
}

/// After a resume, the page that was up must still be: WebKit can drop a suspended app's content process
/// without telling the delegate, and a cockpit can crash while away. Asked once a second until it answers.
final class ResumeCheck {
    /// Long enough for a relay to reconnect and a page to reload by itself.
    static let windowMs: Int64 = 8000

    enum Verdict { case healthy, wait, restart }

    private let expectsRoot: Bool
    private var startedAt: Int64 = -1

    init(expectsRoot: Bool) {
        self.expectsRoot = expectsRoot
    }

    func start(_ now: Int64) {
        startedAt = now
    }

    var running: Bool { startedAt >= 0 }

    func stop() {
        startedAt = -1
    }

    /// `state` is the last PageCheck answer, nil when the script could not run.
    func answer(_ state: PageCheck.State?, now: Int64) -> Verdict {
        guard startedAt >= 0 else { return .healthy }
        if PageCheck.healthy(state, expectsRoot: expectsRoot) {
            stop()
            return .healthy
        }
        if now - startedAt >= Self.windowMs {
            stop()
            return .restart
        }
        return .wait
    }
}
