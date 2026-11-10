import Foundation

/// One rendezvous, with a real `XXpsk3` responder as cezar.
func pairingClientTests() {
    let cezarSecret = RelayCrypto.x25519Secret()
    let cezarEd = RelayCrypto.random(32)
    let keys = DeviceKeys.generate()

    func qrString(_ pinned: [UInt8]) -> String {
        "cezar-pair:1." + Bytes.base64url(RelayCrypto.random(32)) + "." + Bytes.base64url(pinned) + ".https://relay.example.test"
    }

    func qrSecret(_ pinned: [UInt8]) throws -> PairSecret { try PairSecret.fromQr(qrString(pinned), debugBuild: false) }

    struct World {
        let fake = FakeTransport()
        let states = BlockingQueue<PairingClient.State>()
        var client: PairingClient?
        var socket: FakeSocket { fake.last! }
    }

    func started(_ world: inout World, _ secret: PairSecret, outcomeMs: Int64 = 300_000) {
        let states = world.states
        let client = PairingClient(transport: world.fake, secret: secret, keys: keys, phoneName: "Pixel\n9", updates: { states.add($0) },
                                   outcomeDeadlineMs: outcomeMs)
        world.client = client
        client.start()
        expect(states.poll(timeoutMs: 2000)?.phase == .connecting, "connecting first")
        _ = eventually { world.fake.count > 0 }
    }

    func nextMessage(_ socket: FakeSocket) throws -> [UInt8] {
        guard let frame = socket.binary.poll(timeoutMs: 3000), frame.first == 1 else { throw RelayIOError("no frame") }
        return Array(frame.dropFirst())
    }

    /// Runs cezar's half up to the third message.
    func handshake(_ socket: FakeSocket, _ secret: PairSecret, psk: [UInt8]? = nil) throws -> (NoiseHandshake.Keys, NoiseHandshake, [String: Any]) {
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"limits\":{\"frameBytes\":16384}}")
        expect(socket.binary.poll(timeoutMs: 50) == nil, "nothing before peer-joined")
        socket.events.text("{\"t\":\"peer-joined\"}")
        let responder = vectorHandshake("XXpsk3", initiator: false, prologue: Bytes.ascii("cezar-pair-v1") + secret.locatorBytes, staticSecret: cezarSecret,
                                        remoteStatic: nil, psk: psk ?? secret.psk, ephemeral: RelayCrypto.x25519Secret())
        let first = try nextMessage(socket)
        expect(first.count == 48, "first message is 48 bytes")
        expect(try responder.readMessage(first).isEmpty, "empty payload")
        let second = try responder.writeMessage([])
        expect(second.count == 96, "second message is 96 bytes")
        socket.events.binary([1] + second)
        let third = try nextMessage(socket)
        let phone = RelayJson.object(try TunnelRecord.unpad(responder.readMessage(third))) ?? [:]
        return (try responder.split(), responder, phone)
    }

    func deliver(_ socket: FakeSocket, _ cezar: NoiseHandshake.Keys, _ json: String) throws {
        socket.events.binary([1] + (try cezar.send.encrypt(TunnelRecord.pad(Bytes.utf8(json)))))
    }

    func pending(_ label: String = "Test Mac") -> String {
        "{\"t\":\"pending\",\"relayKey\":\"\(Bytes.base64url(RelayCrypto.ed25519Public(cezarEd)))\",\"tunnel\":{\"min\":1,\"max\":1},\"label\":\"\(label)\"}"
    }

    test("a full pairing") {
        var world = World()
        let secret = try qrSecret(RelayCrypto.x25519Public(cezarSecret))
        started(&world, secret)
        expect(world.socket.url.hasSuffix("/v1/pair/" + secret.locator + "?role=phone"), "rendezvous url")
        expect(world.socket.headers.isEmpty, "role=phone carries no proof")
        let (cezar, responder, phone) = try handshake(world.socket, secret)
        expect(phone["name"] as? String == "Pixel9" && phone["platform"] as? String == "ios", "phone payload")
        expect(phone["relayKey"] as? String == Bytes.base64url(keys.relayKey()), "relay key")
        expect(responder.remoteStatic == RelayCrypto.x25519Public(keys.x25519Secret), "phone static")
        try deliver(world.socket, cezar, pending())
        let confirm = world.states.poll(timeoutMs: 2000)
        expect(confirm?.phase == .confirm && confirm?.digits == PairSecret.sasDigits(responder.handshakeHash) && confirm?.label == "Test Mac", "confirm")
        expect(world.socket.binary.poll(timeoutMs: 50) == nil, "the phone sends nothing after the third message")
        try deliver(world.socket, cezar, "{\"t\":\"approved\"}")
        let done = world.states.poll(timeoutMs: 2000)
        expect(done?.phase == .approved && done?.cezarId == RelayIds.id(RelayCrypto.ed25519Public(cezarEd)), "approved")
        expect(done?.cezarStatic == RelayCrypto.x25519Public(cezarSecret), "cezar static")
        expect(world.socket.closes.poll(timeoutMs: 1000) == 1000, "closed 1000")
    }

    test("a wrong pin stops before the third message") {
        var world = World()
        let secret = try qrSecret(RelayCrypto.x25519Public(RelayCrypto.x25519Secret()))
        started(&world, secret)
        let socket = world.socket
        socket.events.text("{\"t\":\"hello\",\"protocol\":1}")
        socket.events.text("{\"t\":\"peer-joined\"}")
        let responder = vectorHandshake("XXpsk3", initiator: false, prologue: Bytes.ascii("cezar-pair-v1") + secret.locatorBytes, staticSecret: cezarSecret,
                                        remoteStatic: nil, psk: secret.psk, ephemeral: RelayCrypto.x25519Secret())
        _ = try responder.readMessage(nextMessage(socket))
        socket.events.binary([1] + (try responder.writeMessage([])))
        let failed = world.states.poll(timeoutMs: 2000)
        expect(failed?.phase == .failed && failed?.reason == "pin-mismatch", "pin-mismatch")
        expect(socket.closes.poll(timeoutMs: 1000) == 1000, "closed")
        expect(socket.binary.poll(timeoutMs: 100) == nil, "the third message is never sent")
    }

    test("a damaged second message is not called a pin mismatch") {
        var world = World()
        let secret = try qrSecret(RelayCrypto.x25519Public(cezarSecret))
        started(&world, secret)
        let socket = world.socket
        socket.events.text("{\"t\":\"hello\",\"protocol\":1}")
        socket.events.text("{\"t\":\"peer-joined\"}")
        let responder = vectorHandshake("XXpsk3", initiator: false, prologue: Bytes.ascii("cezar-pair-v1") + secret.locatorBytes, staticSecret: cezarSecret,
                                        remoteStatic: nil, psk: secret.psk, ephemeral: RelayCrypto.x25519Secret())
        _ = try responder.readMessage(nextMessage(socket))
        var second = try responder.writeMessage([])
        second[second.count - 1] ^= 1
        socket.events.binary([1] + second)
        expect(world.states.poll(timeoutMs: 2000)?.reason == "internal", "internal")
    }

    test("a wrong psk surfaces as a lost connection") {
        var world = World()
        let secret = try PairSecret.fromCode("QRFX-7KMD-2NVB", relay: RelayOrigin.parse("https://relay.example.test", debugBuild: false))
        started(&world, secret)
        let socket = world.socket
        socket.events.text("{\"t\":\"hello\",\"protocol\":1}")
        socket.events.text("{\"t\":\"peer-joined\"}")
        let responder = vectorHandshake("XXpsk3", initiator: false, prologue: Bytes.ascii("cezar-pair-v1") + secret.locatorBytes, staticSecret: cezarSecret,
                                        remoteStatic: nil, psk: RelayCrypto.random(32), ephemeral: RelayCrypto.x25519Secret())
        _ = try responder.readMessage(nextMessage(socket))
        socket.events.binary([1] + (try responder.writeMessage([])))
        let third = try nextMessage(socket)
        expect(throwsError { _ = try responder.readMessage(third) }, "cezar cannot read the third message")
        socket.events.text("{\"t\":\"peer-left\"}")
        expect(world.states.poll(timeoutMs: 2000)?.reason == "lost", "lost")
    }

    test("a peer that never decides ends the pairing") {
        var world = World()
        let secret = try qrSecret(RelayCrypto.x25519Public(cezarSecret))
        started(&world, secret, outcomeMs: 300)
        try deliver(world.socket, handshake(world.socket, secret).0, pending())
        expect(world.states.poll(timeoutMs: 2000)?.phase == .confirm, "confirm")
        let failed = world.states.poll(timeoutMs: 2000)
        expect(failed?.phase == .failed && failed?.reason == "timeout", "timeout")
        expect(world.socket.closes.poll(timeoutMs: 1000) == 1000, "closed")
    }

    test("a typed code has no pin and still pairs") {
        var world = World()
        let secret = try PairSecret.fromCode("QRFX-7KMD-2NVB", relay: RelayOrigin.parse("https://relay.example.test", debugBuild: false))
        started(&world, secret)
        try deliver(world.socket, handshake(world.socket, secret).0, pending())
        expect(world.states.poll(timeoutMs: 2000)?.phase == .confirm, "confirm")
    }

    test("outcomes") {
        let table = [
            ("{\"t\":\"denied\"}", "denied"),
            ("{\"t\":\"failure\",\"reason\":\"device-limit\"}", "device-limit"),
            ("{\"t\":\"failure\",\"reason\":\"something-new\"}", "internal"),
            ("{\"t\":\"failure\",\"reason\":\"tunnel-unsupported\",\"tunnel\":{\"min\":2,\"max\":2}}", "update-app"),
        ]
        for (message, reason) in table {
            var world = World()
            let secret = try qrSecret(RelayCrypto.x25519Public(cezarSecret))
            started(&world, secret)
            try deliver(world.socket, handshake(world.socket, secret).0, message)
            expect(world.states.poll(timeoutMs: 2000)?.reason == reason, "\(message) -> \(reason)")
        }
    }

    test("close codes and refusals end the code") {
        for (code, reason) in [(4404, "not-found"), (4408, "expired"), (4410, "taken"), (4429, "rate-limited"), (1006, "lost")] {
            var world = World()
            started(&world, try qrSecret(RelayCrypto.x25519Public(cezarSecret)))
            world.socket.events.closed(code)
            expect(world.states.poll(timeoutMs: 2000)?.reason == reason, "\(code) -> \(reason)")
        }
        for (status, reason) in [(404, "not-found"), (409, "taken"), (0, "relay-unreachable"), (426, "update-app")] {
            var world = World()
            started(&world, try qrSecret(RelayCrypto.x25519Public(cezarSecret)))
            world.socket.events.failed(status: status, code: nil, retryAfterSeconds: -1, dateMillis: -1)
            expect(world.states.poll(timeoutMs: 2000)?.reason == reason, "\(status) -> \(reason)")
        }
    }

    test("a phone name is cut on a character boundary") {
        let safe = PairingClient.safeName(String(repeating: "ż", count: 40))
        expect(Bytes.utf8(safe).count == 64, "64 bytes")
        expect(PairingClient.safeName("\n\t") == "iPhone", "default name")
        expect(PairingClient.safeName("a\u{85}b\u{7f}c") == "abc", "C1 controls dropped")
    }

    test("a save that fails ends the pairing") {
        // cezar already holds this phone, so the page must end rather than wait on Confirm for ever.
        let fake = FakeTransport()
        let qr = qrString(RelayCrypto.x25519Public(cezarSecret))
        let flow = PairingFlow(transport: fake, phoneName: "Pixel", debugBuild: false) { _, _, _ in throw RelayIOError("disk full") }
        var seen = flow.startQr(qr)
        _ = eventually { fake.count > 0 }
        let socket = fake.last!
        let cezar = try handshake(socket, PairSecret.fromQr(qr, debugBuild: false)).0
        try deliver(socket, cezar, pending())
        try deliver(socket, cezar, "{\"t\":\"approved\"}")
        for _ in 0..<50 where seen.phase != .failed { seen = flow.next(seen: seen.seq, timeoutMs: 100) }
        expect(seen.phase == .failed && seen.reason == "internal", "internal")
    }

    test("a replaced pairing cannot report over the new one") {
        let fake = FakeTransport()
        let flow = PairingFlow(transport: fake, phoneName: "Pixel", debugBuild: false) { _, _, _ in }
        _ = flow.startQr(qrString(RelayCrypto.x25519Public(cezarSecret)))
        _ = eventually { fake.count > 0 }
        var after = flow.startQr(qrString(RelayCrypto.x25519Public(cezarSecret)))
        for _ in 0..<4 { after = flow.next(seen: after.seq, timeoutMs: 100) }
        expect(after.phase == .connecting, "still connecting")
    }

    test("a second pending cannot rename the computer") {
        var world = World()
        let secret = try qrSecret(RelayCrypto.x25519Public(cezarSecret))
        started(&world, secret)
        let cezar = try handshake(world.socket, secret).0
        try deliver(world.socket, cezar, pending())
        expect(world.states.poll(timeoutMs: 2000)?.phase == .confirm, "confirm")
        try deliver(world.socket, cezar, pending("Other"))
        try deliver(world.socket, cezar, "{\"t\":\"approved\"}")
        expect(world.states.poll(timeoutMs: 2000)?.label == "Test Mac", "label kept")
    }

    test("a refused QR says what to do") {
        let fake = FakeTransport()
        let flow = PairingFlow(transport: fake, phoneName: "Pixel", debugBuild: false) { _, _, _ in }
        let old = "https://relay.example.test/p#1." + Bytes.base64url(RelayCrypto.random(32)) + "." + Bytes.base64url(RelayCrypto.x25519Public(cezarSecret))
        expect(flow.startQr(old).reason == "update-cezar", "old link")
        expect(flow.startQr("https://relay.example.test/").reason == "qr-invalid", "not a pairing code")
        expect(flow.startQr("cezar-pair:2.anything").reason == "update-app", "newer version")
        expect(flow.startQr("cezar-pair:1.\(Bytes.base64url(RelayCrypto.random(32))).\(Bytes.base64url(RelayCrypto.random(32))).http://relay.example.test").reason
               == "qr-cleartext", "cleartext relay")
        expect(fake.count == 0, "no socket opened")
    }

    func typedCodeOpens(_ field: String?, _ socketOrigin: String) {
        let fake = FakeTransport()
        _ = PairingFlow(transport: fake, phoneName: "Pixel", debugBuild: false) { _, _, _ in }.startCode("QRFX-7KMD-2NVB", relayAddress: field)
        _ = eventually(3000) { fake.count > 0 }
        expect(fake.last?.url.hasPrefix(socketOrigin + "/v1/pair/") == true, "\(field ?? "nil") -> \(socketOrigin)")
    }

    test("a typed code still opens its rendezvous") {
        let locator = try PairSecret.fromCode("QRFX-7KMD-2NVB", relay: RelayOrigin.parse("https://relay.example.test", debugBuild: false)).locator
        let fake = FakeTransport()
        _ = PairingFlow(transport: fake, phoneName: "Pixel", debugBuild: false) { _, _, _ in }.startCode("QRFX-7KMD-2NVB", relayAddress: "relay.example.test")
        _ = eventually(3000) { fake.count > 0 }
        expect(fake.last?.url == "wss://relay.example.test/v1/pair/" + locator + "?role=phone", "rendezvous url")
    }

    test("a typed code with no address uses the default relay") {
        let socket = try RelayOrigin.parse(RelayOrigin.defaultOrigin, debugBuild: false).socketOrigin
        for field in ["", "   ", nil, RelayOrigin.defaultOrigin] { typedCodeOpens(field, socket) }
    }

    test("a custom address keeps the typed rules") {
        typedCodeOpens("https://relay.example.test/", "wss://relay.example.test")
        let flow = PairingFlow(transport: FakeTransport(), phoneName: "Pixel", debugBuild: false) { _, _, _ in }
        expect(flow.startCode("QRFX-7KMD-2NVB", relayAddress: "http://relay.example.test").reason == "relay-cleartext", "cleartext")
        expect(flow.startCode("QRFX-7KMD-2NVB", relayAddress: "https://relay.example.test/path").reason == "relay-invalid", "path")
        expect(flow.startCode("QRFX-7KMD", relayAddress: nil).reason == "code-invalid", "short code")
    }

    test("relay origin grammar") {
        expect(throwsError { _ = try RelayOrigin.parse("https://relay.example.test\n", debugBuild: true) }, "trailing newline refused")
        expect(throwsError { _ = try RelayOrigin.parse("https://relay.example.test:65536", debugBuild: true) }, "port over 65535")
        expect((try? RelayOrigin.parse("http://127.0.0.1:8787", debugBuild: true))?.socketOrigin == "ws://127.0.0.1:8787", "debug loopback")
        expect(throwsError { _ = try RelayOrigin.parse("http://127.0.0.1:8787", debugBuild: false) }, "release refuses cleartext")
        expect(throwsError { _ = try RelayOrigin.parse("http://relay.example.test", debugBuild: true) }, "debug refuses remote cleartext")
    }
}
