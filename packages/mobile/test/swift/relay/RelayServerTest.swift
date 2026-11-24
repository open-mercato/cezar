import Foundation

/// The relay kind of server: storage, gates and the start table. The Manual path has its own tests.
func relayServerTests() {
    final class NeverHttp: HttpGet {
        func get(url: String, headers: [String: String]) async throws -> HttpAnswer {
            expect(false, "a relay server is never probed over https")
            throw URLError(.badURL)
        }
    }

    final class FakeRelayPort: ShellConnector.RelayPort {
        let calls = Locked<[String]>([])
        var nextHealth = HealthAnswer.of(.relayDown, 0)
        func probe(_ server: ServerRecord) async -> HealthAnswer {
            calls.value.append("probe")
            return nextHealth
        }
        func goodbye(_ server: ServerRecord) { calls.value.append("goodbye") }
        func forgetKeys(_ id: String) { calls.value.append("forgetKeys") }
    }

    final class FakePush: ShellConnector.PushPort {
        let calls: Locked<[String]>
        let keep: Bool
        init(_ calls: Locked<[String]>, keep: Bool) {
            self.calls = calls
            self.keep = keep
        }
        func forget(_ server: ServerRecord) -> Bool {
            calls.value.append("push")
            return keep
        }
    }

    final class NoCredentials: CredentialStore {
        func put(_ id: String, password: String) {}
        func get(_ id: String) -> String? { nil }
        func delete(_ id: String) {}
    }

    struct World {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let relay = FakeRelayPort()
        let servers: ServerListStore
        let connector: ShellConnector

        init(push: ((Locked<[String]>) -> ShellConnector.PushPort)? = nil) {
            servers = ServerListStore(directory: directory)
            connector = ShellConnector(servers: servers, credentials: NoCredentials(), probe: HealthProbe(http: NeverHttp(), userAgent: "ua"),
                                       relay: relay, push: push?(relay.calls))
        }

        func save(_ label: String, _ fields: RelayFields) -> String {
            connector.saveRelayServer(id: connector.relayServerId(cezarId: fields.cezarId, cezarKey: fields.cezarKey), label: label, fields: fields)
        }
    }

    let fields = RelayFields(origin: "https://relay.example.test", cezarId: "cezar-id", cezarKey: "key", deviceId: "device-id", port: 0)

    func blocking<T>(_ work: @escaping () async -> T) -> T {
        let result = Locked<T?>(nil)
        let done = DispatchSemaphore(value: 0)
        Task {
            result.value = await work()
            done.signal()
        }
        done.wait()
        return result.value!
    }

    test("a relay server round-trips with no url or password") {
        let world = World()
        let id = world.save("Laptop", fields)
        world.connector.saveRelayPort(id: id, port: 4242)
        let server = ServerListStore(directory: world.directory).get(id)
        expect(server?.url == nil && server?.username == nil, "no url, no username")
        expect(server?.relay?.origin == "https://relay.example.test" && server?.relay?.port == 4242, "relay fields")
        let file = (try? String(contentsOf: world.directory.appendingPathComponent("servers.json"), encoding: .utf8)) ?? ""
        expect(!file.contains("\"url\""), "no url key in the file")
    }

    test("pairing the same cezar again keeps its row and port") {
        let world = World()
        let id = world.save("Laptop", fields)
        world.connector.saveRelayPort(id: id, port: 4242)
        let again = world.save("Renamed", RelayFields(origin: "https://other.example.test", cezarId: "cezar-id", cezarKey: "key", deviceId: "device-2", port: 0))
        let server = world.servers.get(id)
        expect(again == id && server?.label == "Renamed" && server?.relay?.port == 4242 && server?.relay?.deviceId == "device-2", "same row")
        expect(world.servers.list().count == 1, "one row")
    }

    test("a cezar id with another pin cannot take over a saved server") {
        let world = World()
        let id = world.save("Laptop", fields)
        world.connector.saveRelayPort(id: id, port: 4242)
        let other = world.save("Hostile", RelayFields(origin: "https://evil.example.test", cezarId: "cezar-id", cezarKey: "attacker-key", deviceId: "device-2", port: 0))
        let saved = world.servers.get(id)
        expect(other != id, "another row")
        expect(saved?.label == "Laptop" && saved?.relay?.origin == "https://relay.example.test" && saved?.relay?.cezarKey == "key"
               && saved?.relay?.deviceId == "device-id", "saved row untouched")
        expect(world.servers.get(other)?.relay?.port == 0, "a new origin, so no storage is shared")
    }

    test("a manual server stays findable beside a relay one") {
        let world = World()
        _ = world.save("Laptop", fields)
        world.servers.put(ServerRecord(id: "m", label: "Box", url: "https://box.example.com"))
        expect(world.servers.find(url: "https://box.example.com")?.id == "m", "found by url")
        expect(world.servers.findPaired(cezarId: "nope", cezarKey: "key") == nil && world.servers.list().count == 2, "two rows")
    }

    test("the start table opens the path, not a url") {
        let world = World()
        let id = world.save("Laptop", fields)
        world.relay.nextHealth = HealthClassifier.classify(HttpAnswer(status: 200, headers: ["content-type": "application/json"],
                                                                      body: "{\"version\":\"1\",\"capabilities\":{\"managers\":true}}"))
        let outcome = blocking { await world.connector.open(id, cookies: nil) }
        expect(outcome.screen == ShellConnector.open && outcome.url == "/manager" && outcome.origin == nil, "opens /manager")
    }

    test("relay routes") {
        let world = World()
        let id = world.save("Laptop", fields)
        let table: [(HealthAnswer.Kind, String)] = [
            (.cezarOffline, ShellConnector.cezarOffline), (.notAnswering, ShellConnector.notAnswering), (.relayDown, ShellConnector.relayDown),
            (.quota, ShellConnector.quota), (.deviceRemoved, ShellConnector.deviceRemoved), (.updateApp, ShellConnector.updateApp),
            (.updateCezar, ShellConnector.updateCezar), (.basicGate, ShellConnector.connectionError), (.notCezar, ShellConnector.connectionError),
        ]
        for (kind, screen) in table {
            world.relay.nextHealth = HealthAnswer.of(kind, 0)
            let outcome = blocking { await world.connector.open(id, cookies: nil) }
            expect(outcome.screen == screen && outcome.url == nil, "\(kind) -> \(screen)")
        }
    }

    test("connecting past the wait reads as the relay, never the computer") {
        expect(HealthAnswer.fromRelay("CONNECTING", minutes: 0).kind == .relayDown && HealthAnswer.fromRelay("RELAY_DOWN", minutes: 0).kind == .relayDown, "relay down")
        expect(HealthAnswer.fromRelay("QUOTA", minutes: 10).status == 10 && HealthAnswer.fromRelay("BROKEN", minutes: 0).kind == .notCezar, "quota, broken")
        expect(StartDecision.decide(HealthAnswer.of(.relayDown, 0), passwordSaved: false) == .relayDown, "route")
    }

    test("forget says goodbye before the keys go") {
        let world = World()
        let id = world.save("Laptop", fields)
        let done = DispatchSemaphore(value: 0)
        world.connector.forget(id) { done.signal() }
        expect(world.servers.get(id) == nil, "row gone at once")
        expect(done.wait(timeout: .now() + 2) == .success, "teardown finished")
        expect(world.relay.calls.value == ["goodbye", "forgetKeys"], "order: \(world.relay.calls.value)")
    }

    test("a revoke push still owes keeps the device key") {
        let world = World { FakePush($0, keep: true) }
        let id = world.save("Laptop", fields)
        let done = DispatchSemaphore(value: 0)
        world.connector.forget(id) { done.signal() }
        _ = done.wait(timeout: .now() + 2)
        expect(world.relay.calls.value == ["goodbye", "push"], "kept: \(world.relay.calls.value)")
        let released = World { FakePush($0, keep: false) }
        let other = released.save("Laptop", fields)
        let gone = DispatchSemaphore(value: 0)
        released.connector.forget(other) { gone.signal() }
        _ = gone.wait(timeout: .now() + 2)
        expect(released.relay.calls.value == ["goodbye", "push", "forgetKeys"], "deleted: \(released.relay.calls.value)")
    }

    test("proxy origin is exact") {
        let origin = ProxyOrigin(port: 4242)
        expect(origin.origin == "http://127.0.0.1:4242" && origin.sameOrigin("http://127.0.0.1:4242/manager?x=1"), "same origin")
        for other in ["http://127.0.0.1:4243/", "https://127.0.0.1:4242/", "http://127.0.0.1/", "http://127.0.0.1.evil.com:4242/",
                      "http://127.0.0.1:4242@evil.com/", "http://x@127.0.0.1:4242/", "http://127.0.0.1:4242\\@evil.com/"] {
            expect(!origin.sameOrigin(other), "not \(other)")
        }
        expect(origin.sameHost("http://localhost:4242/x") && origin.sameHost("http://127.0.0.1:9999/x") && origin.sameHost("http://[::1]:1/"), "loopback host")
        expect(!origin.sameHost("http://example.com/"), "other host")
    }

    test("a relay page never follows an SSO redirect in-app") {
        let origin = ProxyOrigin(port: 4242)
        let page = origin.url("/manager")
        expect(NavigationPolicy.decide(origin: origin, url: "https://sso.example.com/", pageUrl: page, mainFrame: true, redirect: true) == .external, "sso")
        expect(NavigationPolicy.decide(origin: origin, url: origin.url("/x"), pageUrl: page, mainFrame: true, redirect: false) == .allow, "same")
        expect(NavigationPolicy.decide(origin: origin, url: "cezar://servers", pageUrl: page, mainFrame: true, redirect: false) == .servers, "servers")
        expect(NavigationPolicy.decideWindow(origin: origin, url: "http://127.0.0.1:9999/") == .external, "other port leaves")
    }
}
