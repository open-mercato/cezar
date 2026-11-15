import Foundation

/// The socket state machine against a fake transport, with a real `KK` responder on the far side.
func relayLinkTests() {
    final class World {
        let fake = FakeTransport()
        let keys = DeviceKeys.generate()
        let cezarSecret = RelayCrypto.x25519Secret()
        let cezarId = RelayIds.id(RelayCrypto.ed25519Public(RelayCrypto.random(32)))
        let seen = Locked<[RelayStatus.Kind]>([])
        let link: RelayLink

        init() {
            link = RelayLink(transport: fake, target: RelayLink.Target(socketOrigin: "ws://127.0.0.1:1", cezarId: cezarId, deviceId: keys.deviceId(),
                                                                       cezarStatic: RelayCrypto.x25519Public(cezarSecret), keys: keys))
            let seen = self.seen
            link.setListener { status in seen.value = seen.value + [status.kind] }
        }

        deinit { link.dispose() }

        func opened() throws -> FakeSocket {
            guard let socket = fake.sockets.poll(timeoutMs: 3000) else { throw RelayIOError("no socket opened") }
            socket.events.opened()
            return socket
        }

        func waitFor(_ kind: RelayStatus.Kind, line: Int = #line) {
            _ = eventually { self.link.status().kind == kind }
            expect(link.status().kind == kind, "status \(kind), got \(link.status().kind)", line: line)
        }

        var prologue: [UInt8] { Bytes.ascii("cezar-session-v1") + Bytes.fromBase64url(cezarId)! + Bytes.fromBase64url(keys.deviceId())! }

        func responder() -> NoiseHandshake {
            vectorHandshake("KK", initiator: false, prologue: prologue, staticSecret: cezarSecret, remoteStatic: RelayCrypto.x25519Public(keys.x25519Secret),
                            psk: nil, ephemeral: RelayCrypto.x25519Secret())
        }

        func answerHandshake(_ socket: FakeSocket, tunnel: String = "{\"tunnel\":{\"min\":1,\"max\":1}}") throws -> NoiseHandshake.Keys {
            guard let first = socket.binary.poll(timeoutMs: 3000) else { throw RelayIOError("no KK first message") }
            expect(first.count == 49 && first[0] == 1, "a KK first message")
            let responder = responder()
            expect(try responder.readMessage(Array(first.dropFirst())).isEmpty, "empty payload")
            socket.events.binary([1] + (try responder.writeMessage(TunnelRecord.pad(Bytes.utf8(tunnel)))))
            return try responder.split()
        }
    }

    func frame(_ cezar: NoiseHandshake.Keys, _ wire: [UInt8]?) throws -> TunnelFrame {
        guard let wire else { throw RelayIOError("no frame") }
        return try TunnelFrame.parse(TunnelRecord.unpad(cezar.receive.decrypt(Array(wire.dropFirst()))))
    }

    let online = "{\"t\":\"hello\",\"protocol\":1,\"limits\":{\"frameBytes\":65552},\"cezar\":\"online\"}"

    test("the first socket proves and waits for hello") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        expect(socket.url == "ws://127.0.0.1:1/v1/phone/\(world.cezarId)/\(world.keys.deviceId())", "url")
        expect(socket.headers.map(\.0) == ["X-Cezar-Relay-Key", "X-Cezar-Relay-Time", "X-Cezar-Relay-Sig"], "proof headers in order")
        let time = Int64(socket.header("X-Cezar-Relay-Time") ?? "") ?? 0
        let proof = RelayIds.socketProof(role: "phone", roomId: world.cezarId, deviceId: world.keys.deviceId(), time: time)
        expect(RelayCrypto.ed25519Verify(world.keys.relayKey(), Bytes.utf8(proof), Bytes.fromBase64url(socket.header("X-Cezar-Relay-Sig")) ?? []), "signed")
        expect(socket.binary.poll(timeoutMs: 100) == nil, "nothing before hello")
    }

    test("hello online runs KK, then HELLO, then LEASE") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text(online)
        let cezar = try world.answerHandshake(socket)
        world.waitFor(.ready)
        expect(try frame(cezar, socket.binary.poll(timeoutMs: 2000)).type == TunnelFrame.HELLO, "HELLO")
        expect(try frame(cezar, socket.binary.poll(timeoutMs: 2000)).type == TunnelFrame.LEASE, "LEASE")
        expect(world.link.session() != nil, "session")
    }

    test("a wrong cezar key never reaches READY") {
        // The pin: a responder with another static cannot finish KK, whatever it sends (§ 10).
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text(online)
        guard let first = socket.binary.poll(timeoutMs: 3000) else { throw RelayIOError("no first message") }
        let impostor = vectorHandshake("KK", initiator: false, prologue: world.prologue, staticSecret: RelayCrypto.x25519Secret(),
                                       remoteStatic: RelayCrypto.x25519Public(world.keys.x25519Secret), psk: nil, ephemeral: RelayCrypto.x25519Secret())
        expect(throwsError { _ = try impostor.readMessage(Array(first.dropFirst())) }, "the impostor cannot read message one")
        let forged = vectorHandshake("KK", initiator: true, prologue: world.prologue, staticSecret: RelayCrypto.x25519Secret(),
                                     remoteStatic: RelayCrypto.x25519Public(world.keys.x25519Secret), psk: nil, ephemeral: RelayCrypto.x25519Secret())
        socket.events.binary([1] + (try forged.writeMessage([])) + [UInt8](repeating: 0, count: 16))
        expect(socket.closes.poll(timeoutMs: 2000) == 1000, "dropped as a decryption failure")
        expect(world.link.session() == nil && world.link.status().kind != .ready, "no session")
    }

    test("hello offline says so and sends nothing") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"offline\"}")
        world.waitFor(.cezarOffline)
        expect(socket.binary.poll(timeoutMs: 100) == nil, "nothing sent")
    }

    test("offline ends the session and keeps the socket, then online handshakes again") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}")
        _ = try world.answerHandshake(socket)
        world.waitFor(.ready)
        let first = world.link.session()
        socket.events.text("{\"t\":\"cezar-offline\"}")
        world.waitFor(.cezarOffline)
        expect(first?.live() == false && world.link.session() == nil, "session ended")
        expect(socket.closes.isEmpty, "the socket stays")
        socket.binary.clear()
        socket.events.text("{\"t\":\"cezar-online\"}")
        _ = try world.answerHandshake(socket)
        world.waitFor(.ready)
        expect(world.link.session()?.live() == true, "live again")
    }

    test("cezar-offline is told before the session ends, so its 502s carry the reason") {
        let world = World()
        let sessionAtOffline = Locked<Bool?>(nil)
        let link = world.link
        world.link.setListener { status in
            if status.kind == .cezarOffline && sessionAtOffline.value == nil { sessionAtOffline.value = link.session()?.live() == true }
        }
        world.link.start()
        let socket = try world.opened()
        socket.events.text(online)
        _ = try world.answerHandshake(socket)
        world.waitFor(.ready)
        socket.events.text("{\"t\":\"cezar-offline\"}")
        world.waitFor(.cezarOffline)
        expect(sessionAtOffline.value == true, "status set while the session still ran")
    }

    test("the startup log names the 4451 reason, cezar-offline and a relay-asked reconnect") {
        let world = World()
        let lines = Locked<[String]>([])
        world.link.setDiagnostics { line in lines.value = lines.value + [line] }
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"offline\"}")
        socket.events.text("{\"t\":\"cezar-offline\"}")
        world.waitFor(.cezarOffline)
        socket.events.closed(1012, reason: "reconnect")
        guard let next = world.fake.sockets.poll(timeoutMs: 6000) else { throw RelayIOError("no redial") }
        next.events.opened()
        next.events.closed(4451, reason: "terms-required-device")
        world.waitFor(.termsRequiredDevice)
        let text = lines.value.joined(separator: "\n")
        for wanted in ["relay cezar-offline", "relay relay asked reconnect", "relay refused reason=terms-required-device"] {
            expect(text.contains(wanted), "log has '\(wanted)': \(text)")
        }
    }

    test("1012 from the relay reconnects within 5 s, with no failure shown") {
        let world = World()
        world.link.start()
        for round in 0..<2 {
            let socket = try world.opened()
            socket.events.text(online)
            _ = try world.answerHandshake(socket)
            world.waitFor(.ready)
            world.seen.value = []
            let closedAt = relayNowMs()
            socket.events.closed(1012, reason: "reconnect")
            guard let next = world.fake.sockets.poll(timeoutMs: 6000) else { throw RelayIOError("no redial after 1012") }
            let took = relayNowMs() - closedAt
            expect(took >= 900 && took <= 5500, "redialed in 1–5 s (round \(round)), took \(took)ms")
            expect(!world.seen.value.contains(.relayDown) && !world.link.status().terminal, "no failure status: \(world.seen.value)")
            world.fake.sockets.add(next)
        }
    }

    test("close and refusal table") {
        let world = World()
        for (code, kind) in [(4403, RelayStatus.Kind.deviceRemoved), (4426, .updateApp), (4400, .broken), (4413, .broken)] {
            world.link.retryNow()
            let socket = try world.opened()
            socket.events.closed(code)
            world.waitFor(kind)
            expect(world.fake.sockets.poll(timeoutMs: 50) == nil, "\(code) stops reconnecting")
        }
        world.link.retryNow()
        world.fake.sockets.poll(timeoutMs: 3000)?.events.failed(status: 403, code: "device-removed", retryAfterSeconds: -1, dateMillis: -1)
        world.waitFor(.deviceRemoved)
    }

    test("an account refusal names its reason and stops (§ 18)") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"error\",\"code\":\"email-unconfirmed\"}")
        socket.events.closed(4451)
        world.waitFor(.emailUnconfirmed)
        expect(world.link.status().terminal, "terminal")
        expect(world.fake.sockets.poll(timeoutMs: 50) == nil, "4451 stops reconnecting")
        world.link.retryNow()
        let again = try world.opened()
        again.events.text("{\"t\":\"error\",\"code\":\"account-required\"}")
        again.events.closed(4451)
        world.waitFor(.accountRequired)
        world.link.retryNow()
        let third = try world.opened()
        third.events.closed(4451)
        world.waitFor(.emailUnconfirmed)
        world.link.retryNow()
        try world.opened().events.closed(4451, reason: "account-required")
        world.waitFor(.accountRequired)
        world.link.retryNow()
        let suspended = try world.opened()
        suspended.events.text("{\"t\":\"error\",\"code\":\"suspended\"}")
        suspended.events.closed(4451)
        world.waitFor(.suspended)
        expect(world.link.status().terminal, "suspended is terminal")
        expect(world.fake.sockets.poll(timeoutMs: 50) == nil, "suspended stops reconnecting")
        world.link.retryNow()
        try world.opened().events.closed(4451, reason: "terms-required-device")
        world.waitFor(.termsRequiredDevice)
        expect(world.link.status().terminal, "terms-required-device is terminal")
        expect(world.fake.sockets.poll(timeoutMs: 50) == nil, "terms-required-device stops reconnecting")
        expect(RelayLink.refusal("something-new") == .emailUnconfirmed, "an unknown reason reads as email-unconfirmed")
    }

    test("replaced does nothing") {
        let world = World()
        world.link.start()
        try world.opened().events.closed(4409)
        world.waitFor(.idle)
        expect(world.fake.sockets.poll(timeoutMs: 50) == nil, "no reconnect")
    }

    test("quota names its wait") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"closing\",\"retryAfter\":600}")
        socket.events.closed(4430)
        world.waitFor(.quota)
        expect(world.link.status().retryAfterSeconds == 600, "600 s")
    }

    // Security review F2: a hostile relay's wait overflowed `seconds * 1000` and trapped.
    test("a huge wait is capped, not a crash") {
        for code in [4430, 4429] {
            let world = World()
            world.link.start()
            let socket = try world.opened()
            socket.events.text("{\"t\":\"closing\",\"retryAfter\":10000000000000000}")
            socket.events.closed(code)
            if code == 4430 {
                world.waitFor(.quota)
                expect(world.link.status().retryAfterSeconds == 86_400, "capped at a day")
            }
        }
        let world = World()
        world.link.start()
        world.fake.sockets.poll(timeoutMs: 3000)?.events.failed(status: 429, code: "rate-limited", retryAfterSeconds: Int64.max / 10, dateMillis: -1)
        world.waitFor(.relayDown)
        expect(relayWaitMs(Int64.max) == 86_400_000 && relayWaitMs(-5) == 0, "saturates")
    }

    test("a lost socket is a relay outage and reconnects") {
        let world = World()
        world.link.start()
        try world.opened().events.closed(1001)
        world.waitFor(.relayDown)
        expect(world.fake.sockets.poll(timeoutMs: 3000) != nil, "reconnects within the first jitter window")
    }

    test("a bad proof retries once corrected by Date, then stops") {
        let world = World()
        world.link.start()
        let relayNow = relayNowMs() + 3_600_000
        world.fake.sockets.poll(timeoutMs: 3000)?.events.failed(status: 401, code: "bad-proof", retryAfterSeconds: -1, dateMillis: relayNow)
        guard let second = world.fake.sockets.poll(timeoutMs: 3000) else { throw RelayIOError("no retry") }
        let sent = Int64(second.header("X-Cezar-Relay-Time") ?? "") ?? 0
        expect(abs(sent - relayNow / 1000) < 5, "time corrected by Date")
        second.events.failed(status: 401, code: "bad-proof", retryAfterSeconds: -1, dateMillis: relayNow)
        world.waitFor(.broken)
    }

    test("a relay under the frame floor is broken") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"limits\":{\"frameBytes\":1024},\"cezar\":\"online\"}")
        world.waitFor(.broken)
        expect(socket.closes.poll(timeoutMs: 1000) == 1000, "closed 1000")
    }

    test("a tampered frame ends the session and the socket") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}")
        _ = try world.answerHandshake(socket)
        world.waitFor(.ready)
        socket.events.binary([1, 2, 3])
        expect(socket.closes.poll(timeoutMs: 2000) == 1000, "closed 1000")
        expect(world.link.session() == nil, "no session")
    }

    test("no shared tunnel version names who is old") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}")
        let cezar = try world.answerHandshake(socket, tunnel: "{\"tunnel\":{\"min\":2,\"max\":3}}")
        world.waitFor(.updateApp)
        let close = try frame(cezar, socket.binary.poll(timeoutMs: 2000))
        expect(close.type == TunnelFrame.CLOSE && close.code == TunnelFrame.CLOSE_TUNNEL_UNSUPPORTED, "CLOSE tunnel-unsupported")
    }

    test("a stale frame during the handshake is dropped and the real reply still works") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}")
        _ = eventually { !socket.binary.isEmpty }
        socket.events.binary([1] + [UInt8](repeating: 0, count: 272))
        _ = try world.answerHandshake(socket)
        world.waitFor(.ready)
        expect(socket.closes.isEmpty, "socket kept")
    }

    test("a frame outside the transport length class is a decryption failure") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}")
        _ = eventually { !socket.binary.isEmpty }
        socket.events.binary([1] + [UInt8](repeating: 0, count: 304))
        expect(socket.closes.poll(timeoutMs: 2000) == 1000, "closed 1000")
        expect(world.fake.sockets.poll(timeoutMs: 3000) != nil, "reconnects with jitter")
    }

    test("a frame with no session is dropped") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"offline\"}")
        world.waitFor(.cezarOffline)
        socket.events.binary([1] + [UInt8](repeating: 0, count: 272))
        Thread.sleep(forTimeInterval: 0.05)
        expect(world.link.status().kind == .cezarOffline && socket.closes.isEmpty, "ignored")
    }

    test("a quota hello has no cezar key and is not offline") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1}")
        socket.events.text("{\"t\":\"closing\",\"retryAfter\":60}")
        socket.events.closed(4430)
        world.waitFor(.quota)
        expect(!world.seen.value.contains(.cezarOffline), "never offline")
    }

    test("CLOSE device-removed reconnects and the refusal decides") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}")
        let cezar = try world.answerHandshake(socket)
        world.waitFor(.ready)
        socket.events.binary([1] + (try cezar.send.encrypt(TunnelRecord.pad(TunnelFrame.close(code: TunnelFrame.CLOSE_DEVICE_REMOVED)))))
        expect(socket.closes.poll(timeoutMs: 2000) == 1000, "closed")
        expect(!world.seen.value.contains(.deviceRemoved), "not yet removed")
        guard let next = world.fake.sockets.poll(timeoutMs: 3000) else { throw RelayIOError("no reconnect") }
        next.events.failed(status: 403, code: "device-removed", retryAfterSeconds: -1, dateMillis: -1)
        world.waitFor(.deviceRemoved)
    }

    test("awaitSettled after start waits for a real answer") {
        let world = World()
        world.link.start()
        expect(world.link.awaitSettled(timeoutMs: 150).kind == .connecting, "connecting, not the old idle")
    }

    test("stop closes with 1000") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        world.link.stop()
        expect(socket.closes.poll(timeoutMs: 2000) == 1000, "1000")
        world.waitFor(.idle)
    }

    /// Ready, with a stream open through the session: the cockpit request in flight when the socket dies.
    func readyWithStream(_ world: World) throws -> (FakeSocket, TunnelStream) {
        world.link.start()
        let socket = try world.opened()
        socket.events.text(online)
        _ = try world.answerHandshake(socket)
        world.waitFor(.ready)
        guard let session = world.link.session() else { throw RelayIOError("no session") }
        return (socket, try session.open(method: "POST", target: "/api/v1/managers/x/messages", headers: []))
    }

    /// The incident: a foreground after a suspension calls start() on a link that never stopped. Its socket
    /// died silently; before the fix start() did nothing and the 45 s ping found it a minute later, while every
    /// cockpit request waited on the dead session.
    test("a foreground start on a running link probes, and a silent socket is replaced within seconds") {
        let world = World()
        let (socket, stream) = try readyWithStream(world)
        socket.texts.clear()
        let since = relayNowMs()
        world.link.start()
        expect(socket.texts.poll(timeoutMs: 1000) == "ping", "a ping at once, not in 45 s")
        expect(socket.closes.poll(timeoutMs: 8000) == 1000, "no pong: the socket is closed")
        expect(relayNowMs() - since < 7000, "within the probe wait, not the 45 s + 15 s keepalive")
        expect(stream.next(timeoutMs: 1000)?.kind == .lost, "the request in flight fails at once, never hangs")
        expect(world.fake.sockets.poll(timeoutMs: 3000) != nil, "and a new socket is dialed")
    }

    test("a foreground start on a live link keeps it") {
        let world = World()
        let (socket, _) = try readyWithStream(world)
        socket.texts.clear()
        world.link.start()
        expect(socket.texts.poll(timeoutMs: 1000) == "ping", "probed")
        socket.events.text("pong")
        expect(socket.closes.poll(timeoutMs: 6000) == nil, "the pong keeps the socket")
        expect(world.link.status().kind == .ready && world.fake.count == 1, "still the one session")
    }

    test("a foreground start skips a backoff in progress") {
        let world = World()
        world.link.start()
        try world.opened().events.closed(1006)
        world.waitFor(.relayDown)
        // The first jitter is at least 1 s; a foreground must not wait it out, or a longer one.
        world.link.start()
        expect(world.fake.sockets.poll(timeoutMs: 500) != nil, "dialed at once")
    }

    test("a foreground start never cuts a relay-sent wait short") {
        let world = World()
        world.link.start()
        let socket = try world.opened()
        socket.events.text("{\"t\":\"closing\",\"retryAfter\":600}")
        socket.events.closed(4430)
        world.waitFor(.quota)
        world.link.start()
        world.link.networkChanged(.reconnect)
        expect(world.fake.sockets.poll(timeoutMs: 500) == nil, "the quota wait holds")
    }

    test("a probe keeps the ping floor of 20 s") {
        let world = World()
        let (socket, _) = try readyWithStream(world)
        socket.texts.clear()
        world.link.start()
        expect(socket.texts.poll(timeoutMs: 1000) == "ping", "first probe pings")
        socket.events.text("pong")
        world.link.start()
        expect(socket.texts.poll(timeoutMs: 1000) == nil, "a second within 20 s waits")
    }

    test("a network path lost redials at once, and the request in flight fails") {
        let world = World()
        let (socket, stream) = try readyWithStream(world)
        world.link.networkChanged(.reconnect)
        expect(socket.closes.poll(timeoutMs: 1000) == 1000, "old socket closed")
        expect(stream.next(timeoutMs: 1000)?.kind == .lost, "in flight: lost, so the proxy answers 502")
        expect(world.fake.sockets.poll(timeoutMs: 500) != nil, "new socket at once, no jitter")
    }

    test("an added network path only probes") {
        let world = World()
        let (socket, _) = try readyWithStream(world)
        socket.texts.clear()
        world.link.networkChanged(.probe)
        expect(socket.texts.poll(timeoutMs: 1000) == "ping", "probed")
        expect(socket.closes.isEmpty, "kept until the probe says otherwise")
    }

    test("diagnostics carry reasons and timings, never ids or keys") {
        let world = World()
        let lines = Locked<[String]>([])
        world.link.setDiagnostics { line in lines.value = lines.value + [line] }
        world.link.probeWaitMs = 100
        let (socket, _) = try readyWithStream(world)
        world.link.start()
        _ = socket.closes.poll(timeoutMs: 3000)
        socket.events.closed(4409)
        _ = world.fake.sockets.poll(timeoutMs: 3000)?.events.closed(4429)
        let all = lines.value.joined(separator: "\n")
        for wanted in ["relay open in=", "relay hello cezar=online", "relay ready in=", "relay check start probe", "relay lost pong-timeout up=",
                       "relay retry in="] {
            expect(all.contains(wanted), "has \(wanted)")
        }
        _ = eventually { lines.value.joined().contains("closed code=4429") }
        expect(lines.value.joined().contains("closed code=4429"), "close codes")
        expect(!all.contains(world.cezarId) && !all.contains(world.keys.deviceId()), "no ids")
    }

    test("network change decisions") {
        let wifi = NetworkChange.Path(satisfied: true, interfaces: ["en0"])
        let both = NetworkChange.Path(satisfied: true, interfaces: ["en0", "pdp_ip0"])
        let cell = NetworkChange.Path(satisfied: true, interfaces: ["pdp_ip0"])
        let none = NetworkChange.Path(satisfied: false, interfaces: [])
        expect(NetworkChange.decide(nil, wifi) == .none, "the first update describes the start")
        expect(NetworkChange.decide(wifi, cell) == .reconnect, "wifi to cellular: the socket's interface is gone")
        expect(NetworkChange.decide(none, wifi) == .reconnect, "back from no network")
        expect(NetworkChange.decide(wifi, none) == .none, "nothing to dial on no network")
        expect(NetworkChange.decide(cell, both) == .probe, "wifi joins: ask the socket")
        expect(NetworkChange.decide(both, cell) == .reconnect, "the preferred interface left")
        expect(NetworkChange.decide(wifi, wifi) == .none, "the same path")
    }
}

func relayConnectionsTests() {
    func paired(_ keys: MemoryKeys, _ id: String, _ device: DeviceKeys) throws -> ServerRecord {
        try keys.put(id, device)
        let key = Bytes.base64url(RelayCrypto.x25519Public(RelayCrypto.x25519Secret()))
        return ServerRecord(id: id, label: "Laptop", url: nil,
                            relay: RelayFields(origin: "https://relay.example.test", cezarId: "cezar-id", cezarKey: key, deviceId: device.deviceId(), port: 0))
    }

    test("the same device keeps its link") {
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let server = try paired(keys, "a", DeviceKeys.generate())
        expect(connections.link(server) === connections.link(server), "same link")
        connections.release()
    }

    test("pairing again drops the link holding the old keys") {
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let old = connections.link(try paired(keys, "a", DeviceKeys.generate()))
        expect(old !== connections.link(try paired(keys, "a", DeviceKeys.generate())), "new link")
        connections.release()
    }

    test("a second server closes the first's listener") {
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let first = try connections.openProxy(paired(keys, "a", DeviceKeys.generate()))
        let port = first.port()
        let second = try connections.openProxy(paired(keys, "b", DeviceKeys.generate()))
        expect(first !== second, "another listener")
        expect(!LoopbackClient.canConnect(port: port), "the first listener is gone")
        expect(!second.cookieValue().isEmpty && second.cookieValue() != first.cookieValue(), "a fresh cookie")
        connections.release()
    }

    test("no keys read as a removed phone") {
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let server = try paired(keys, "a", DeviceKeys.generate())
        keys.delete("a")
        let done = DispatchSemaphore(value: 0)
        let kind = Locked<HealthAnswer.Kind?>(nil)
        Task {
            kind.value = await connections.probe(server).kind
            done.signal()
        }
        done.wait()
        expect(kind.value == .deviceRemoved, "device removed")
    }

    test("a silent relay probes as a relay outage, never the computer") {
        let keys = MemoryKeys()
        let fake = FakeTransport()
        let connections = RelayConnections(transport: fake, keys: keys, userAgent: "ua")
        let server = try paired(keys, "a", DeviceKeys.generate())
        let done = DispatchSemaphore(value: 0)
        let kind = Locked<HealthAnswer.Kind?>(nil)
        Task {
            kind.value = await connections.probe(server).kind
            done.signal()
        }
        fake.sockets.poll(timeoutMs: 3000)?.events.failed(status: 0, code: nil, retryAfterSeconds: -1, dateMillis: -1)
        done.wait()
        expect(kind.value == .relayDown, "relay down")
        connections.release()
    }

    test("a finished view leaves the newer view's connection") {
        // A finishing view's teardown can land after the next view opened.
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let server = try paired(keys, "a", DeviceKeys.generate())
        let first = try connections.openProxy(server)
        let second = try connections.openProxy(server)
        let link = connections.link(server)
        connections.release(first)
        expect(link === connections.link(server), "kept")
        expect(LoopbackClient.canConnect(port: second.port()), "second listener up")
        expect(connections.holds(second) && !connections.holds(first), "holds")
        connections.release(second)
        expect(link !== connections.link(server), "released")
        connections.release()
    }

    test("the switcher warms a second server beside the one on screen") {
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let onScreen = try paired(keys, "a", DeviceKeys.generate())
        let other = try paired(keys, "b", DeviceKeys.generate())
        let proxy = try connections.openProxy(onScreen)
        let current = connections.link(onScreen)
        let warm = connections.warm(other)
        expect(warm != nil && warm !== current, "a link of its own")
        expect(connections.warm(other) === warm && connections.warming("b"), "kept while the sheet is open")
        expect(connections.holds(proxy) && LoopbackClient.canConnect(port: proxy.port()), "the page on screen keeps its listener")
        expect(connections.link(onScreen) === current, "and its link")
        expect(connections.warm(onScreen) === current && !connections.warming("a"), "the current server's link is never the pool's")
        connections.releaseWarm("a")
        expect(connections.link(onScreen) === current, "releasing the current server's id leaves its link")
        connections.release()
    }

    test("a switch adopts the warm link") {
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let onScreen = try paired(keys, "a", DeviceKeys.generate())
        let other = try paired(keys, "b", DeviceKeys.generate())
        let first = try connections.openProxy(onScreen)
        let warm = connections.warm(other)
        connections.release(first)
        let next = try connections.openProxy(other)
        expect(connections.link(other) === warm && !connections.warming("b"), "the warmed link is the current one")
        expect(connections.holds(next), "with its listener")
        connections.releaseWarm("b")
        expect(connections.link(other) === warm, "the sheet's release leaves an adopted link alone")
        connections.release()
    }

    test("closing the sheet disposes what it warmed") {
        let keys = MemoryKeys()
        let fake = FakeTransport()
        let connections = RelayConnections(transport: fake, keys: keys, userAgent: "ua")
        let other = try paired(keys, "b", DeviceKeys.generate())
        let warm = connections.warm(other)!
        warm.start()
        let socket = fake.sockets.poll(timeoutMs: 2000)
        expect(socket != nil, "warming dials")
        connections.releaseWarm("b")
        expect(!connections.warming("b") && connections.warm(other) !== warm, "gone, a new warm-up dials anew")
        connections.releaseWarm("b")
        let stale = try paired(keys, "c", DeviceKeys.generate())
        let old = connections.warm(stale)
        expect(connections.warm(try paired(keys, "c", DeviceKeys.generate())) !== old, "pairing again drops the warm link with the old keys")
        connections.releaseWarm("c")
        keys.delete("b")
        expect(connections.warm(other) == nil, "no keys, no link")
        connections.release()
    }

    test("a disposed link ignores every call") {
        // A probe holds its link for seconds, and the view may release it meanwhile.
        let keys = MemoryKeys()
        let connections = RelayConnections(transport: SilentTransport(), keys: keys, userAgent: "ua")
        let link = connections.link(try paired(keys, "a", DeviceKeys.generate()))!
        connections.release()
        link.dispose()
        link.start()
        link.stop()
        link.retryNow()
        link.goodbye()
        expect(true, "no crash")
    }

    test("device key store semantics") {
        // DeviceKeyStoreTest: new keys replace old ones; delete reads as absent. The Keychain store needs an
        // entitlement a plain macOS binary lacks, so only its id rule runs here.
        let store = MemoryKeys()
        try store.put("a", DeviceKeys.generate())
        let next = DeviceKeys.generate()
        try store.put("a", next)
        expect(store.get("a") == next && store.count == 1, "replaced, one entry")
        store.delete("a")
        expect(store.get("a") == nil, "deleted")
        expect(DeviceKeys.fromBytes(next.toBytes()) == next && DeviceKeys.fromBytes([1, 2]) == nil, "round trip")
        expect(!KeychainDeviceKeyStore.safe("../a") && KeychainDeviceKeyStore.safe(UUID().uuidString), "ids")
        expect(throwsError { try KeychainDeviceKeyStore().put("../a", next) }, "a bad id throws, never crashes")
    }
}
