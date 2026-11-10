import Foundation

func tunnelSessionTests() {
    func keys() -> NoiseHandshake.Keys { NoiseHandshake.Keys(send: NoiseCipher(RelayCrypto.random(32)), receive: NoiseCipher(RelayCrypto.random(32))) }

    test("a frame the socket refuses ends the session") {
        // The nonce has moved by then, so any later frame would be undecryptable.
        let refuse = Locked(false)
        let session = TunnelSession(wire: { _ in if refuse.value { throw RelayIOError("refused") } }, keys: keys(), frameBytes: 65552,
                                    listener: { _ in }, clock: relayNowMs)
        expect(session.live(), "live")
        refuse.value = true
        expect(throwsError { try session.lease() }, "lease throws")
        expect(!session.live(), "ended")
    }

    test("a burst of frames is paced") {
        // 300 frames at once used to reach the socket in one second of the relay's 500, with cezar's replies on top.
        var now: Int64 = 1000
        let pacer = FramePacer(framesPerSecond: 500, clock: { now }, sleeper: { now += $0 })
        let session = TunnelSession(wire: { _ in }, keys: keys(), frameBytes: 65552, pacer: pacer, listener: { _ in }, clock: { now })
        for _ in 0..<300 { try session.lease() }
        expect(now == 1000 + 299 * 5, "5 ms apart: \(now)")
    }

    test("an idle session does not wait") {
        var now: Int64 = 1000
        var sleeps = 0
        let pacer = FramePacer(framesPerSecond: 500, clock: { now }, sleeper: { _ in sleeps += 1 })
        let session = TunnelSession(wire: { _ in }, keys: keys(), frameBytes: 65552, pacer: pacer, listener: { _ in }, clock: { now })
        for _ in 0..<3 {
            try session.lease()
            now += 20000
        }
        expect(sleeps == 0, "no sleep")
    }

    test("an hour sends REKEY first, then the new key") {
        var now: Int64 = 0
        let toCezar = RelayCrypto.random(32)
        var wire: [[UInt8]] = []
        let session = TunnelSession(wire: { wire.append($0) }, keys: NoiseHandshake.Keys(send: NoiseCipher(toCezar), receive: NoiseCipher(RelayCrypto.random(32))),
                                    frameBytes: 65552, pacer: FramePacer(framesPerSecond: 500, clock: { now }, sleeper: { _ in }), listener: { _ in },
                                    clock: { now })
        try session.lease()
        now += 3_600_000
        try session.lease()
        expect(wire.count == 3, "three frames on the wire")
        guard wire.count == 3 else { return }
        let peer = NoiseCipher(toCezar)
        let frames = try wire[0..<2].map { try TunnelFrame.parse(TunnelRecord.unpad(peer.decrypt($0))).type }
        expect(frames == [TunnelFrame.LEASE, TunnelFrame.REKEY], "REKEY precedes the rekeyed frame, under the old key")
        expect(throwsError { _ = try peer.copy().decrypt(wire[2]) }, "the next frame is not under the old key")
        peer.rekey()
        expect(try TunnelFrame.parse(TunnelRecord.unpad(peer.decrypt(wire[2]))).type == TunnelFrame.LEASE, "the lease after REKEY is under the new key")
    }

    test("a nonce at its limit refuses rather than reuses") {
        let cipher = NoiseCipher(RelayCrypto.random(32), nonce: UInt64.max - 1)
        expect((try? cipher.encrypt([1])) != nil, "the last nonce works")
        expect(throwsError { _ = try cipher.encrypt([1]) }, "2^64-1 is never used to encrypt")
        expect(throwsError { _ = try NoiseCipher(RelayCrypto.random(32), nonce: UInt64.max).decrypt([UInt8](repeating: 0, count: 17)) }, "nor to decrypt")
    }

    test("a frame for a stream never opened ends the session") {
        let toPhone = RelayCrypto.random(32)
        var ended = -1
        let session = TunnelSession(wire: { _ in }, keys: NoiseHandshake.Keys(send: NoiseCipher(RelayCrypto.random(32)), receive: NoiseCipher(toPhone)),
                                    frameBytes: 65552, listener: { ended = $0 }, clock: relayNowMs)
        session.receive(try NoiseCipher(toPhone).encrypt(TunnelRecord.pad(TunnelFrame.window(stream: 1, increment: 1))))
        expect(!session.live() && ended == TunnelFrame.CLOSE_PROTOCOL_ERROR, "protocol error")
    }

    test("frame and record limits") {
        expect(throwsError { _ = try TunnelFrame.open(stream: 1, method: "GET", target: "/", headers: [TunnelFrame.Header(name: String(repeating: "x", count: 256), value: "1")]) },
               "a 256-byte header name cannot be encoded")
        let session = TunnelSession(wire: { _ in }, keys: keys(), frameBytes: 65552, listener: { _ in }, clock: relayNowMs)
        let big = [TunnelFrame.Header(name: "x-big", value: String(repeating: "v", count: 16000))]
        expect(throwsError { _ = try session.open(method: "GET", target: "/", headers: big) }, "an OPEN over 16000 bytes is refused locally")
        for _ in 0..<TunnelSession.MAX_STREAMS { _ = try session.open(method: "GET", target: "/", headers: []) }
        do {
            _ = try session.open(method: "GET", target: "/", headers: [])
            expect(false, "the 33rd stream is refused")
        } catch {
            expect(error is TunnelSession.TooManyStreams, "TooManyStreams")
        }
        expect(throwsError { _ = try TunnelFrame.parse(TunnelFrame.window(stream: 1, increment: TunnelFrame.MAX_WINDOW + 1)) }, "window over 256 KiB")
        expect(throwsError { _ = try TunnelRecord.unpad([0, 5] + [UInt8](repeating: 0, count: 253) + [1]) }, "non-zero padding")
    }
}
