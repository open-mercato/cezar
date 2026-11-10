// Runs the lock logic and the banner table on macOS, ported from LockPolicyTest, LockSettingTest.
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

let start: Int64 = 1_000_000
let timeout = LockPolicy.timeoutMs

func unlocked() -> LockPolicy {
    let policy = LockPolicy()
    policy.passed()
    return policy
}

// aNewProcessPromptsOnLaunch
do {
    let policy = LockPolicy()
    expect(policy.promptNeeded(enabled: true), "new process needs prompt")
    expect(policy.autoPrompt(enabled: true), "new process auto prompts")
}
// disabledNeverPrompts
do {
    let policy = LockPolicy()
    expect(!policy.promptNeeded(enabled: false), "disabled: no prompt")
    expect(!policy.autoPrompt(enabled: false), "disabled: no auto prompt")
    policy.left(now: start)
    policy.returned(now: start + timeout * 10)
    expect(!policy.promptNeeded(enabled: false), "disabled after trip")
}
// justUnderTheTimeoutStaysUnlocked
do {
    let policy = unlocked()
    policy.left(now: start)
    policy.returned(now: start + timeout - 1)
    expect(!policy.promptNeeded(enabled: true), "under timeout stays unlocked")
}
// exactlyTheTimeoutLocks
do {
    let policy = unlocked()
    policy.left(now: start)
    policy.returned(now: start + timeout)
    expect(policy.promptNeeded(enabled: true), "timeout locks")
}
// awayTimeIsPerTripNotCumulative
do {
    let policy = unlocked()
    policy.left(now: start)
    policy.returned(now: start + timeout - 1)
    policy.left(now: start + timeout)
    policy.returned(now: start + timeout * 2 - 1)
    expect(!policy.promptNeeded(enabled: true), "per trip")
}
// aRotationIsNotLeaving
do {
    let policy = unlocked()
    policy.left(now: start, changingConfigurations: true)
    policy.returned(now: start + timeout * 10)
    expect(!policy.promptNeeded(enabled: true), "rotation is not leaving")
}
// aRotationWhileLockedStaysLockedWithoutASecondPrompt
do {
    let policy = LockPolicy()
    policy.promptStarted()
    policy.left(now: start, changingConfigurations: true)
    policy.returned(now: start + 1)
    expect(policy.promptNeeded(enabled: true), "rotation while locked stays locked")
    expect(!policy.autoPrompt(enabled: true), "no second prompt")
}
// aClockThatRunsBackwardsLocks
do {
    let policy = unlocked()
    policy.left(now: start)
    policy.returned(now: start - 1)
    expect(policy.promptNeeded(enabled: true), "backwards clock locks")
}
// aCancelledPromptStaysLockedWithNoAutomaticLoop
do {
    let policy = LockPolicy()
    policy.promptStarted()
    policy.left(now: start)
    policy.promptEnded()
    policy.returned(now: start + 1)
    expect(policy.promptNeeded(enabled: true), "cancelled stays locked")
    expect(!policy.autoPrompt(enabled: true), "no loop")
}
// aRealTripAwayOffersThePromptAgain
do {
    let policy = LockPolicy()
    policy.promptStarted()
    policy.promptEnded()
    policy.left(now: start)
    policy.returned(now: start + 1)
    expect(policy.autoPrompt(enabled: true), "real trip re-offers")
}
// leavingDuringAToggleCountsTowardsTheTimeout
do {
    let policy = unlocked()
    policy.promptStarted()
    policy.left(now: start)
    policy.promptEnded()
    policy.returned(now: start + timeout)
    expect(policy.promptNeeded(enabled: true), "leaving during toggle counts")
}
// passingClearsAnEarlierDeparture
do {
    let policy = LockPolicy()
    policy.left(now: start)
    policy.passed()
    policy.returned(now: start + timeout * 10)
    expect(!policy.promptNeeded(enabled: true), "passing clears departure")
}

// LockSettingTest
func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lock-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
do {
    let dir = tempDir()
    expect(!LockSetting(directory: dir).enabled(), "off by default")
    try LockSetting(directory: dir).set(true)
    expect(LockSetting(directory: dir).enabled(), "survives restart")
    try LockSetting(directory: dir).set(false)
    expect(!LockSetting(directory: dir).enabled(), "off again")
    try LockSetting(directory: dir).set(false)
    expect(!LockSetting(directory: dir).enabled(), "off twice is fine")
} catch {
    expect(false, "setting round trip threw \(error)")
}
do {
    let dir = tempDir()
    try LockSetting(directory: dir).set(true)
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
    expect(files.count == 1, "one file")
    let size = (try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(files[0]).path)[.size] as? Int) ?? -1
    expect(size == 0, "holds no bytes")
} catch {
    expect(false, "holds-no-bytes threw \(error)")
}
do {
    let notADirectory = FileManager.default.temporaryDirectory.appendingPathComponent("lockfile-\(UUID().uuidString)")
    FileManager.default.createFile(atPath: notADirectory.path, contents: Data())
    var threw = false
    do { try LockSetting(directory: notADirectory).set(true) } catch { threw = true }
    expect(threw, "failed write is reported")
}

// Banner table (ConnectionBanner.of)
typealias B = ConnectionBannerText
expect(B.of(kind: .updateApp, notReadyForMs: 0) == B(text: "Update the app.", retry: false), "update app immediate")
expect(B.of(kind: .updateCezar, notReadyForMs: 0)?.text == "Update cezar on your computer.", "update cezar immediate")
expect(B.of(kind: .broken, notReadyForMs: 0)?.retry == true, "broken immediate with retry")
expect(B.of(kind: .relayDown, notReadyForMs: B.graceMs - 1) == nil, "grace hides relay down")
expect(B.of(kind: .relayDown, notReadyForMs: B.graceMs)?.text == "Can't reach the Cezar relay. Your computer is fine. Retrying…", "relay down text")
expect(B.of(kind: .cezarOffline, notReadyForMs: B.graceMs)?.text == "Your computer is asleep or cezar isn't running.", "offline text")
expect(B.of(kind: .notAnswering, notReadyForMs: B.graceMs)?.text == "cezar is not answering.", "not answering text")
expect(B.of(kind: .quota, retryAfterSeconds: 0, notReadyForMs: B.graceMs)?.text == "Too much traffic today. Back in 1 minutes.", "quota min 1")
expect(B.of(kind: .quota, retryAfterSeconds: 3600, notReadyForMs: B.graceMs)?.text == "Too much traffic today. Back in 60 minutes.", "quota 60")
expect(B.of(kind: .quota, retryAfterSeconds: 61, notReadyForMs: B.graceMs)?.text == "Too much traffic today. Back in 2 minutes.", "quota rounds up")
expect(B.of(kind: .quota, retryAfterSeconds: 61, notReadyForMs: B.graceMs)?.retry == false, "quota no retry")
expect(B.of(kind: .deviceRemoved, notReadyForMs: 99999) == nil, "device removed is no banner")
expect(B.of(kind: .ready, notReadyForMs: 99999) == nil, "ready no banner")
expect(B.of(kind: .connecting, notReadyForMs: 99999) == nil, "connecting no banner")

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
