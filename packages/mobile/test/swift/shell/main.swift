// Runs the plain iOS classes on macOS, with no Xcode and no XCTest. It proves their logic, not
// that they build for iOS. See README.md.
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

func answer(_ status: Int, type: String? = nil, auth: String? = nil, _ body: String = "") -> HttpAnswer {
    var headers: [String: String] = [:]
    if let type { headers["content-type"] = type }
    if let auth { headers["www-authenticate"] = auth }
    return HttpAnswer(status: status, headers: headers, body: body)
}

func problem(_ input: String?) -> ServerOrigin.Problem? {
    do {
        _ = try ServerOrigin.parse(input)
        return nil
    } catch {
        return error as? ServerOrigin.Problem
    }
}

// ServerOrigin
expect((try? ServerOrigin.parse(" HTTPS://Cezar.Example.com/ "))?.origin == "https://cezar.example.com", "normalizes")
expect((try? ServerOrigin.parse("cezar.example.com"))?.origin == "https://cezar.example.com", "bare host")
expect((try? ServerOrigin.parse("https://cezar.example.com:443"))?.origin == "https://cezar.example.com", "default port")
expect((try? ServerOrigin.parse("https://cezar.example.com:8443"))?.origin == "https://cezar.example.com:8443", "other port")
expect(problem("http://cezar.example.com") == .cleartext, "http refused")
expect(problem("HTTP://cezar.example.com") == .cleartext, "HTTP refused")
for bad in ["https://me:secret@cezar.example.com", "https://cezar.example.com/sub", "https://cezar.example.com/?x=1", "ftp://cezar.example.com", "", "not a url"] {
    expect(problem(bad) == .invalid, "refuses \(bad)")
}
expect(problem(nil) == .invalid, "refuses nil")

let origin = try! ServerOrigin.parse("https://cezar.example.com")
expect(origin.sameOrigin("https://cezar.example.com/manager?x=1"), "same origin")
expect(origin.sameOrigin("https://CEZAR.example.com:443/"), "case and default port")
for other in ["http://cezar.example.com/", "https://cezar.example.com:8443/", "https://cezar.example.com.evil.com/", "https://cezar.example.com@evil.com/", "https://evil.com\\@cezar.example.com/"] {
    expect(!origin.sameOrigin(other), "not same origin: \(other)")
}
expect(!origin.sameOrigin(nil), "nil is not same origin")

// HealthClassifier
let on = HealthClassifier.classify(answer(200, type: "application/json", "{\"version\":\"0.18.0\",\"capabilities\":{\"managers\":true}}"))
expect(on.kind == .cezar && on.managers == true && on.version == "0.18.0", "managers on")
expect(HealthClassifier.classify(answer(200, "{\"version\":\"1\",\"capabilities\":{\"managers\":false}}")).managers == false, "managers off")
let absent = HealthClassifier.classify(answer(200, "{\"version\":\"0.9\",\"capabilities\":{}}"))
expect(absent.kind == .cezar && absent.managers == nil, "absent stays nil")
expect(HealthClassifier.classify(answer(200, "{\"status\":\"ok\"}")).kind == .notCezar, "other JSON")
let gate = HealthClassifier.classify(answer(401, type: "text/html", auth: "Basic realm=\"cezar \\\"box\\\"\", charset=\"UTF-8\"", "<html>"))
expect(gate.kind == .basicGate && gate.realm == "cezar \"box\"", "quoted realm")
expect(HealthClassifier.classify(answer(401, auth: "basic realm=ngrok")).realm == "ngrok", "bare realm")
expect(HealthClassifier.classify(answer(401, auth: "Basic")).realm == "", "no realm")
expect(HealthClassifier.classify(answer(401, type: "application/json", auth: "Bearer", "{}")).kind == .notCezar, "bearer")
expect(HealthClassifier.classify(answer(403, "{\"error\":\"unexpected Host header\"}")).kind == .localMode, "local mode")
expect(HealthClassifier.classify(answer(403, "{\"error\":\"nope\"}")).kind == .notCezar, "other 403")
expect(HealthClassifier.classify(answer(302)).kind == .loginPage, "302")
expect(HealthClassifier.classify(answer(200, type: "text/html; charset=utf-8", "<html>")).kind == .loginPage, "html")
let other = HealthClassifier.classify(answer(500, type: "text/html", "<html>"))
expect(other.kind == .notCezar && other.status == 500, "500 keeps status")

// StartDecision
func health(_ kind: HealthAnswer.Kind, managers: Bool? = nil) -> HealthAnswer { HealthAnswer(kind: kind, status: 0, managers: managers) }
expect(StartDecision.decide(health(.cezar, managers: true), passwordSaved: true) == .manager, "manager")
expect(StartDecision.path(.manager) == "/manager", "manager path")
expect(StartDecision.decide(health(.cezar, managers: false), passwordSaved: true) == .rootManagersOff, "off")
expect(StartDecision.decide(health(.cezar), passwordSaved: true) == .rootOldServer, "absent")
expect(StartDecision.path(.rootOldServer) == "/", "root path")
expect(StartDecision.decide(health(.basicGate), passwordSaved: true) == .passwordRejected, "401 saved")
expect(StartDecision.decide(health(.basicGate), passwordSaved: false) == .askCredentials, "401 none")
expect(StartDecision.decide(health(.localMode), passwordSaved: true) == .localMode, "403")
expect(StartDecision.decide(health(.loginPage), passwordSaved: true) == .rootLogin, "302")
for kind in [HealthAnswer.Kind.unreachable, .notCezar, .tlsFailure] {
    expect(StartDecision.decide(health(kind), passwordSaved: true) == .connectionError, "error")
}

// StartDecision, relay rows (#1901)
expect(StartDecision.decide(health(.cezarOffline), passwordSaved: false) == .cezarOffline, "offline")
expect(StartDecision.decide(health(.notAnswering), passwordSaved: false) == .cezarOffline, "not answering")
expect(StartDecision.decide(health(.relayDown), passwordSaved: false) == .relayDown, "relay down")
expect(StartDecision.decide(health(.quota), passwordSaved: false) == .relayDown, "quota")
expect(StartDecision.decide(health(.deviceRemoved), passwordSaved: false) == .deviceRemoved, "removed")
expect(StartDecision.decide(health(.updateApp), passwordSaved: false) == .protocolMismatch, "update app")
expect(StartDecision.decide(health(.updateCezar), passwordSaved: false) == .protocolMismatch, "update cezar")
expect(HealthAnswer.fromRelay("CONNECTING", minutes: 0).kind == .relayDown, "connecting past the wait is the relay")
expect(HealthAnswer.fromRelay("QUOTA", minutes: 10).kind == .quota && HealthAnswer.fromRelay("QUOTA", minutes: 10).status == 10, "quota minutes")
expect(HealthAnswer.fromRelay("BROKEN", minutes: 0).kind == .notCezar, "broken")

// BasicChallengeResponder
let saved = ServerRecord(id: "id", label: "box", url: "https://cezar.example.com", username: "me", realm: "cezar", noteShown: nil)
var reads = 0
func responder(_ record: ServerRecord = saved, password: String? = "secret") -> BasicChallengeResponder {
    BasicChallengeResponder(server: record) { _ in
        reads += 1
        return password
    }
}
func basic(host: String = "cezar.example.com", port: Int = 443, scheme: String = "https", realm: String? = "cezar", failures: Int = 0, method: String = NSURLAuthenticationMethodHTTPBasic) -> Challenge {
    Challenge(method: method, scheme: scheme, host: host, port: port, realm: realm, previousFailures: failures)
}
expect(responder().onChallenge(basic()) == .answer(username: "me", password: "secret"), "answers")
reads = 0
for foreign in [basic(host: "evil.example.com"), basic(port: 8443), basic(scheme: "http"), basic(realm: "other"), basic(realm: nil), basic(method: NSURLAuthenticationMethodHTTPDigest)] {
    expect(responder().onChallenge(foreign) == .cancelForeign, "cancels foreign")
}
expect(reads == 0, "never reads the password for a foreign challenge")
expect(responder().onChallenge(basic(method: NSURLAuthenticationMethodServerTrust)) == .systemDefault, "server trust stays the system's")
expect(responder().onChallenge(basic(failures: 1)) == .cancelRejected, "no retry")
let once = responder()
_ = once.onChallenge(basic())
expect(once.onChallenge(basic()) == .answer(username: "me", password: "secret"), "one load can raise several challenges")
expect(responder(password: nil).onChallenge(basic()) == .cancelRejected, "missing password")
expect(responder(ServerRecord(id: "id", label: "x", url: saved.url, username: nil, realm: nil, noteShown: nil)).onChallenge(basic()) == .cancelForeign, "no saved realm")

// OriginGate
let shell = "capacitor://localhost"
expect(OriginGate.allows(callerUrl: "capacitor://localhost/index.html?x=1", shellUrl: shell), "connect page")
for caller in ["https://cezar.example.com/manager", "https://localhost/", "capacitor://localhost:8443/", "capacitor://localhost.evil.com/", "capacitor://localhost@evil.com/", "about:blank"] {
    expect(!OriginGate.allows(callerUrl: caller, shellUrl: shell), "refuses \(caller)")
}
expect(!OriginGate.allows(callerUrl: nil, shellUrl: shell), "refuses nil")
expect(!OriginGate.allows(callerUrl: shell, shellUrl: nil), "refuses nil shell")

// NavigationPolicy
let page = "https://cezar.example.com/manager"
func nav(_ url: String, page pageUrl: String? = page, main: Bool = true, redirect: Bool = false) -> NavigationPolicy.Action {
    NavigationPolicy.decide(origin: origin, url: url, pageUrl: pageUrl, mainFrame: main, redirect: redirect)
}
expect(nav("cezar://servers") == .servers, "servers")
expect(nav("cezar://servers/") == .servers, "servers slash")
expect(nav("cezar://servers", main: false) == .block, "servers in a frame")
expect(nav("cezar://other") == .block, "other cezar")
expect(nav("https://github.com/x") == .external, "off origin")
expect(nav("https://cezar.example.com:8443/") == .external, "other port")
expect(nav("mailto:a@b.c") == .external, "mailto")
expect(nav("https://cezar.example.com/p/x") == .allow, "on origin")
expect(nav("https://sso.example.org/login", redirect: true) == .allow, "sso redirect")
expect(nav("https://sso.example.org/next", page: "https://sso.example.org/login") == .allow, "inside sso")
expect(nav("http://sso.example.org/login", redirect: true) == .external, "cleartext redirect")
expect(nav("intent://x") == .block, "intent")
expect(nav("file:///etc/hosts") == .block, "file")
expect(NavigationPolicy.decideWindow(origin: origin, url: "https://cezar.example.com/p/x") == .allow, "window same origin")
expect(NavigationPolicy.decideWindow(origin: origin, url: "https://github.com/x") == .external, "window elsewhere")
expect(NavigationPolicy.decideWindow(origin: origin, url: "intent://x") == .block, "window intent")

// PageOrigin: a manual server allows SSO, a relay page never does (#1901)
expect(origin.allowsSso && origin.sameHost("https://cezar.example.com:8443/x") && !origin.sameHost("https://evil.com/"), "server origin host")
let proxy = ProxyOrigin(port: 4242)
expect(!proxy.allowsSso && proxy.sameOrigin("http://127.0.0.1:4242/manager") && !proxy.sameOrigin("http://localhost:4242/"), "proxy origin")
expect(NavigationPolicy.decide(origin: proxy, url: "https://sso.example.org/login", pageUrl: proxy.url("/"), mainFrame: true, redirect: true) == .external,
       "no in-app SSO on a relay page")

// Security review F1: nothing on the page reaches another loopback port, where the gate cookie would go too.
expect(NavigationPolicy.decide(origin: proxy, url: "http://127.0.0.1:8080/", pageUrl: proxy.url("/"), mainFrame: false, redirect: false) == .block,
       "frame to another loopback port")
expect(NavigationPolicy.decide(origin: proxy, url: "http://localhost:4242/", pageUrl: proxy.url("/"), mainFrame: false, redirect: false) == .block,
       "frame to another loopback spelling")
expect(NavigationPolicy.decide(origin: proxy, url: proxy.url("/frame"), pageUrl: proxy.url("/"), mainFrame: false, redirect: false) == .allow,
       "frame on its own origin")
expect(nav("https://cezar.example.com:8443/x", main: false) == .block, "frame to the same host on another port")
for url in ["http://127.0.0.1:8080/x.png", "http://127.0.0.2:4242/", "http://localhost:4242/", "ws://127.0.0.1:9/", "http://[::1]:4242/",
            "http://[0:0:0:0:0:0:0:1]:80/", "http://0.0.0.0:4242/", "http://[::ffff:7f00:1]:4242/", "HTTP://LOCALHOST/"] {
    expect(RequestGate.blocks(url, port: 4242), "gate blocks \(url)")
}
for url in ["http://127.0.0.1:4242/", "http://127.0.0.1:4242/api/v1/health", "https://github.com/x.png", "https://example.com/127.0.0.1"] {
    expect(!RequestGate.blocks(url, port: 4242), "gate lets \(url) through")
}
expect(RequestGate.blocks("http://127.0.0.1:42420/", port: 4242), "a longer port is another port")
let rulesJson = try! JSONSerialization.jsonObject(with: Data(RequestGate.rules(port: 4242).utf8)) as! [[String: [String: String]]]
expect(rulesJson.count == RequestGate.loopbackFilters.count + 1 && rulesJson.last?["action"]?["type"] == "ignore-previous-rules"
       && rulesJson.first?["trigger"]?["url-filter"] == RequestGate.loopbackFilters.first, "rule JSON round-trips")
expect(NavigationPolicy.decide(origin: proxy, url: "http://127.0.0.1:4242/p/x", pageUrl: proxy.url("/"), mainFrame: true, redirect: false) == .allow,
       "relay page on origin")
expect(NavigationPolicy.decideWindow(origin: proxy, url: "http://127.0.0.1:9999/") == .external, "other loopback port leaves")

// ShellConnector
final class Memory: CredentialStore {
    var items: [String: String] = [:]
    func put(_ id: String, password: String) { items[id] = password }
    func get(_ id: String) -> String? { items[id] }
    func delete(_ id: String) { items[id] = nil }
}

final class Script: HttpGet {
    var answers: [HttpAnswer] = []
    var sent: [[String: String]] = []
    func get(url: String, headers: [String: String]) async throws -> HttpAnswer {
        sent.append(headers)
        if answers.isEmpty { throw URLError(.notConnectedToInternet) }
        return answers.removeFirst()
    }
}

let cezar = answer(200, "{\"version\":\"1\",\"capabilities\":{\"managers\":true}}")
let noManager = answer(200, "{\"version\":\"0.9\",\"capabilities\":{}}")
let basicGate = answer(401, type: "text/html", auth: "Basic realm=\"cezar\"", "<html>")
let localMode = answer(403, "{\"error\":\"unexpected Host header\"}")

func world() -> (ShellConnector, Script, Memory, ServerListStore) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let script = Script()
    let memory = Memory()
    let store = ServerListStore(directory: directory)
    return (ShellConnector(servers: store, credentials: memory, probe: HealthProbe(http: script, userAgent: "ua")), script, memory, store)
}

// Quick start (Android's QuickStartTest): a start with the bundle on the phone opens at once; the probe stays for every other open.
final class QuickRelay: ShellConnector.RelayPort {
    var calls: [String] = []
    var quick: String?
    var health = HealthAnswer.of(.unreachable, 0)
    func probe(_ server: ServerRecord) async -> HealthAnswer {
        calls.append("probe")
        return health
    }
    func goodbye(_ server: ServerRecord) { calls.append("goodbye") }
    func forgetKeys(_ id: String) { calls.append("forgetKeys") }
    func quickPath(_ server: ServerRecord) -> String? { quick }
    func opened(_ server: ServerRecord, path: String) { calls.append("opened " + path) }
    func forgetBundle(_ id: String) { calls.append("forgetBundle") }
}

/// Only the protocol's three original methods: the bundle ones default to nothing.
final class PlainRelay: ShellConnector.RelayPort {
    var probes = 0
    func probe(_ server: ServerRecord) async -> HealthAnswer {
        probes += 1
        return HealthClassifier.classify(cezar)
    }
    func goodbye(_ server: ServerRecord) {}
    func forgetKeys(_ id: String) {}
}

func quickWorld(_ relay: ShellConnector.RelayPort) -> (ShellConnector, String) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let connector = ShellConnector(servers: ServerListStore(directory: directory), credentials: Memory(),
                                   probe: HealthProbe(http: Script(), userAgent: "ua"), relay: relay)
    let fields = RelayFields(origin: "https://relay.example.test", cezarId: "cezar-id", cezarKey: "key", deviceId: "device-id", port: 0)
    let id = connector.saveRelayServer(id: connector.relayServerId(cezarId: fields.cezarId, cezarKey: fields.cezarKey), label: "Laptop", fields: fields)
    return (connector, id)
}

func quickStart() async {
    var relay = QuickRelay()
    var (connector, id) = quickWorld(relay)
    relay.quick = "/manager"
    let cold = await connector.launch(cookiesForLast: nil)
    expect(cold.screen == "open" && cold.url == "/manager" && relay.calls.isEmpty, "a cold start with the bundle cached skips the probe")

    relay = QuickRelay()
    (connector, id) = quickWorld(relay)
    relay.health = HealthClassifier.classify(cezar)
    let probed = await connector.launch(cookiesForLast: nil)
    expect(probed.url == "/manager" && relay.calls == ["probe", "opened /manager"], "with nothing cached the start probes and remembers where it landed")

    relay = QuickRelay()
    (connector, id) = quickWorld(relay)
    relay.quick = "/manager"
    relay.health = HealthClassifier.classify(cezar)
    _ = await connector.open(id, cookies: nil)
    expect(relay.calls.first == "probe", "retry from the list still probes")
    relay.calls = []
    let back = await connector.open(id, cookies: nil, quick: true)
    expect(back.url == "/manager" && relay.calls.isEmpty, "Back from Servers opens at once")

    relay = QuickRelay()
    (connector, id) = quickWorld(relay)
    relay.health = HealthAnswer.of(.deviceRemoved, 0)
    let removed = await connector.open(id, cookies: nil)
    expect(removed.screen == "device-removed" && relay.calls.contains("forgetBundle"), "a removed phone loses the bundle")
    relay.calls = []
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in connector.forget(id) { done.resume() } }
    expect(relay.calls.first == "forgetBundle", "forget clears the bundle first, before the relay's goodbye: \(relay.calls)")
    expect(connector.server(id) == nil, "forgotten")

    let plain = PlainRelay()
    let (plainConnector, _) = quickWorld(plain)
    let opened = await plainConnector.launch(cookiesForLast: nil)
    expect(opened.url == "/manager" && plain.probes == 1, "a relay port with no bundle cache probes as before")
}

// FirstPaint: the cover goes once the page says so, or after the cap.
expect(FirstPaint.done(true, coveredMs: 0), "painted")
expect(!FirstPaint.done(false, coveredMs: 14999), "not yet")
expect(!FirstPaint.done(nil, coveredMs: 100), "no answer")
expect(FirstPaint.done(nil, coveredMs: FirstPaint.maxCoverMs), "never longer than the cap")

// LaunchHold (Android's LaunchHoldTest): held until released, never past the cap.
var holdNow: Int64 = 1000
let hold = LaunchHold { holdNow }
expect(!hold.holding(), "not held before a start")
hold.start()
expect(hold.holding(), "held")
var told = 0
hold.onRelease { told += 1 }
hold.release()
expect(!hold.holding() && told == 1, "released, and told once")
hold.release()
expect(told == 1, "told only once")
hold.start()
holdNow += LaunchHold.maxMs
expect(!hold.holding(), "a start that never resolves still shows the app")

func run() async {
    await quickStart()
    var (connector, script, memory, store) = world()
    script.answers = [cezar]
    let open = await connector.add(url: "https://cezar.example.com", username: nil, password: nil, label: "Box")
    expect(open.screen == "open" && open.url == "https://cezar.example.com/manager", "no gate opens manager")
    expect(store.lastUsedId() == open.serverId, "marks used")

    (connector, script, memory, store) = world()
    script.answers = [basicGate]
    let ask = await connector.add(url: "https://cezar.example.com", username: nil, password: nil, label: nil)
    expect(ask.screen == "ask-credentials" && store.list().isEmpty, "gate asks, saves nothing")

    script.answers = [basicGate, cezar]
    let added = await connector.add(url: "https://cezar.example.com", username: "me", password: "secret", label: nil)
    expect(added.screen == "open" && store.list().first?.realm == "cezar", "saves the realm")
    expect(memory.get(added.serverId!) == "secret", "password in the store")
    expect(script.sent[1]["Authorization"] == nil && script.sent[2]["Authorization"] == "Basic bWU6c2VjcmV0", "first probe bare, second basic")

    script.answers = [basicGate, basicGate]
    let rotated = await connector.open(added.serverId!, cookies: nil)
    expect(rotated.screen == "password-rejected", "rotated password")
    script.answers = []
    let offline = await connector.open(added.serverId!, cookies: nil)
    expect(offline.screen == "connection-error", "offline")
    script.answers = [basicGate, cezar]
    let again = await connector.launch(cookiesForLast: "sso=1")
    expect(again.screen == "open" && script.sent.last?["Cookie"] == "sso=1", "launch opens last used")

    let movedGate = answer(401, type: "text/html", auth: "Basic realm=\"moved\"", "<html>")
    script.answers = [basicGate, cezar]
    let sameRealm = await connector.open(added.serverId!, cookies: nil)
    expect(sameRealm.screen == "open", "unchanged realm opens")
    script.answers = [movedGate]
    let before = script.sent.count
    let moved = await connector.open(added.serverId!, cookies: nil)
    expect(moved.screen == "ask-credentials" && script.sent.count == before + 1, "changed realm asks again")
    expect(script.sent.last?["Authorization"] == nil, "the new realm gets no password")
    script.answers = [movedGate, cezar]
    let readded = await connector.add(url: "https://cezar.example.com", username: "me", password: "secret", label: nil)
    expect(readded.screen == "open" && store.get(added.serverId!)?.realm == "moved", "the new answer saves the realm")

    connector.forget(added.serverId!)
    expect(memory.get(added.serverId!) == nil && store.list().isEmpty && store.lastUsedId() == nil, "forget")
    let empty = await connector.launch(cookiesForLast: nil)
    expect(empty.screen == "list", "empty launch")

    script.answers = [basicGate, basicGate]
    let wrong = await connector.add(url: "https://cezar.example.com", username: "me", password: "wrong", label: nil)
    expect(wrong.screen == "password-rejected" && store.list().isEmpty, "wrong password not saved")
    script.answers = [basicGate, localMode]
    let local = await connector.add(url: "https://cezar.example.com", username: "me", password: "x", label: nil)
    expect(local.screen == "local-mode" && store.list().isEmpty, "retry goes back through the table")
    let sent = script.sent.count
    let cleartext = await connector.add(url: "http://cezar.example.com", username: nil, password: nil, label: nil)
    expect(cleartext.screen == "cleartext-refused" && script.sent.count == sent, "cleartext sends nothing")

    script.answers = [answer(302)]
    let login = await connector.add(url: "https://cezar.example.com", username: nil, password: nil, label: nil)
    expect(login.screen == "login" && login.url == "https://cezar.example.com/" && store.list().isEmpty, "login page unsaved")
    script.answers = [answer(302)]
    expect(login.pendingId != nil && login.serverId == nil, "login names the id its data store will use")
    let pending = await connector.confirmLogin(url: "https://cezar.example.com", pendingId: login.pendingId!, cookies: nil, label: nil)
    expect(pending.screen == "login" && store.list().isEmpty && pending.pendingId == login.pendingId, "still unsaved")
    script.answers = [cezar]
    let confirmed = await connector.confirmLogin(url: "https://cezar.example.com", pendingId: login.pendingId!, cookies: "sso=1", label: nil)
    expect(confirmed.screen == "open" && store.list().count == 1, "saved on cezar JSON")
    // The sign-in's cookies live in the store keyed by this id, so the saved row must keep it.
    expect(confirmed.serverId == login.pendingId, "saved under the pending id")
    script.answers = [answer(302)]
    let readd = await connector.add(url: "https://cezar.example.com", username: nil, password: nil, label: nil)
    expect(readd.pendingId == login.pendingId, "re-adding a saved server keeps its id and store")

    script.answers = [noManager]
    let old = await connector.add(url: "https://old.example.com", username: nil, password: nil, label: nil)
    expect(old.url == "https://old.example.com/" && old.note?.contains("0.9") == true && old.note?.contains("server-deploy") == true, "old server note")
    script.answers = [noManager]
    let oldAgain = await connector.open(old.serverId!, cookies: nil)
    expect(oldAgain.note == nil, "note is one-time")
}

let done = DispatchSemaphore(value: 0)
Task {
    await run()
    done.signal()
}
done.wait()

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
