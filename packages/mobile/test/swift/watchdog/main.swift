// The black-screen guards: StartupWatchdog, ResumeCheck, PageCheck and AppUpdate. See README.md.
import Foundation

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ name: String, line: Int = #line) {
    checks += 1
    if !condition() {
        failures += 1
        print("FAIL line \(line): \(name)")
    }
}

// PageCheck
expect(PageCheck.state("painted") == .painted && PageCheck.state("blank") == .blank, "reads answers")
expect(PageCheck.state(nil) == nil && PageCheck.state(true) == nil && PageCheck.state("other") == nil, "no answer is nil")
expect(PageCheck.healthy(.painted, expectsRoot: true), "painted cockpit")
expect(!PageCheck.healthy(.blank, expectsRoot: false), "empty #root is the black screen")
expect(PageCheck.healthy(.page, expectsRoot: false), "a sign-in page on a URL server")
expect(!PageCheck.healthy(.page, expectsRoot: true), "a relay page without #root is the proxy's error page")
expect(!PageCheck.healthy(nil, expectsRoot: false), "a dead content process")

// StartupWatchdog: a cockpit that loads and never draws (stale shell, boot crash) ends in .blank, not black.
let url = StartupWatchdog(serverLabel: "Mac", relay: false)
expect(url.decide(0).kind == .wait, "not started waits")
url.start(1000)
url.firstByte(1200)
url.loaded(1500)
url.page(.blank)
expect(url.decide(1500 + StartupWatchdog.blankMs - 1) == .init(kind: .wait, text: StartupWatchdog.loading), "blank waits its grace")
expect(url.decide(1500 + StartupWatchdog.blankMs).kind == .blank, "blank past its grace")
expect(url.decide(999_999).kind == .blank, "settled until the next start")
url.start(2000)
expect(url.decide(2000).kind == .wait, "a new start forgets")
url.page(.painted)
expect(url.decide(2001).kind == .reveal, "painted reveals at once")

// No answer at all after the load event: a content process that died is blank too.
let dead = StartupWatchdog(serverLabel: nil, relay: false)
dead.start(0)
dead.loaded(100)
expect(dead.decide(100 + StartupWatchdog.blankMs).kind == .blank, "no answer is blank")

// A page that reloads itself under the cover (the boot guard, a stale-build reload) gets its own deadlines:
// the abandoned document's load event must not start the new one's blank clock.
let reloaded = StartupWatchdog(serverLabel: nil, relay: true)
reloaded.start(0)
reloaded.relayStatus(.ready, computer: nil, now: 10)
reloaded.committed(100)
reloaded.loaded(200)
reloaded.page(.blank)
reloaded.committed(300)
expect(reloaded.decide(200 + StartupWatchdog.blankMs).kind == .wait, "a new document is not blank on the old one's clock")
expect(reloaded.decide(300 + StartupWatchdog.loadMs).text == "The cockpit started loading but did not finish.", "the new document has a load deadline")
let reloadedTwice = StartupWatchdog(serverLabel: nil, relay: true)
reloadedTwice.start(0)
reloadedTwice.committed(100)
reloadedTwice.committed(150)
reloadedTwice.loaded(200)
expect(reloadedTwice.decide(200 + StartupWatchdog.blankMs).kind == .blank, "the new document still goes blank on its own clock")

// A sign-in page has no #root: it shows after the paint grace on a URL server only.
let signIn = StartupWatchdog(serverLabel: nil, relay: false)
signIn.start(0)
signIn.loaded(100)
signIn.page(.page)
expect(signIn.decide(100 + StartupWatchdog.paintGraceMs - 1).kind == .wait, "page waits the grace")
expect(signIn.decide(100 + StartupWatchdog.paintGraceMs).kind == .reveal, "page then shows")
let relayPage = StartupWatchdog(serverLabel: nil, relay: true)
relayPage.start(0)
relayPage.relayStatus(.ready, computer: nil, now: 10)
relayPage.loaded(100)
relayPage.page(.page)
expect(relayPage.decide(100 + StartupWatchdog.blankMs).kind == .blank, "relay error page is not the cockpit")

// Relay steps.
let relay = StartupWatchdog(serverLabel: "Studio", relay: true)
relay.start(0)
expect(relay.decide(0).text == "Connecting to Studio…", "connecting names the computer")
relay.relayStatus(.cezarOffline, computer: "Studio", now: 10)
expect(relay.decide(StartupWatchdog.connectMs - 1).kind == .wait, "connect waits")
expect(relay.decide(StartupWatchdog.connectMs) == .init(kind: .problem, text: "Studio is asleep or offline."), "connect timeout says why")
relay.start(20000)
relay.relayStatus(.updateCezar, computer: nil, now: 20001)
expect(relay.decide(20002).kind == .problem && relay.decide(20002).text?.contains("Update cezar") == true, "terminal ends at once")
relay.start(30000)
relay.relayStatus(.ready, computer: nil, now: 30010)
expect(relay.decide(30010 + StartupWatchdog.firstByteMs).text == "Connected, but cezar did not send the cockpit.", "first byte deadline")
relay.start(50000)
relay.firstByte(50001)
expect(relay.decide(50001 + StartupWatchdog.loadMs).text == "The cockpit started loading but did not finish.", "load deadline")
relay.start(80000)
relay.failed("No connection to cezar came up in time.")
expect(relay.decide(80001).kind == .problem, "a failed load is a problem")
// A page from the phone's cache stands without a session: a terminal status after it is the banner's.
relay.start(90000)
relay.firstByte(90001)
relay.relayStatus(.broken, computer: nil, now: 90002)
expect(relay.decide(90003).kind == .wait, "terminal after the first byte waits")

// ResumeCheck: a page that does not answer, or answers blank, for its whole window is reloaded.
let resume = ResumeCheck(expectsRoot: true)
expect(resume.answer(nil, now: 0) == .healthy && !resume.running, "idle is healthy")
resume.start(0)
expect(resume.answer(nil, now: 1000) == .wait, "no answer yet waits")
expect(resume.answer(.blank, now: ResumeCheck.windowMs) == .restart && !resume.running, "blank past the window restarts once")
resume.start(0)
expect(resume.answer(.painted, now: 500) == .healthy && !resume.running, "painted ends the check")
resume.start(0)
expect(resume.answer(.loading, now: ResumeCheck.windowMs - 1) == .wait, "a reload in flight waits")
expect(resume.answer(.page, now: ResumeCheck.windowMs) == .restart, "a relay error page restarts")

// AppUpdate
let defaults = UserDefaults(suiteName: "cezar-watchdog-test-\(UUID().uuidString)")!
expect(!AppUpdate.changed(build: "0.1.1 (10)", defaults: defaults), "first install is not an update")
expect(!AppUpdate.changed(build: "0.1.1 (10)", defaults: defaults), "same build")
expect(AppUpdate.changed(build: "0.1.1 (11)", defaults: defaults), "new build")
expect(!AppUpdate.changed(build: "0.1.1 (11)", defaults: defaults), "once per build")

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
