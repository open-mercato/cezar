import Foundation

/// The phone's half of one tunnel (RELAY_PROTOCOL.md § 12) over one `KK` session. Never outlives its socket.
final class TunnelSession {
    /// One Noise transport message; the frame byte is the wire's business.
    typealias Wire = ([UInt8]) throws -> Void
    /// A `CLOSE` arrived: `code` is its code. Or a protocol error: `code` is CLOSE_PROTOCOL_ERROR.
    typealias Listener = (Int) -> Void

    struct TooManyStreams: Error {}
    struct HeadTooLarge: Error {}

    static let TUNNEL_MIN = 1
    static let TUNNEL_MAX = 1
    static let MAX_STREAMS = 32
    static let FRAMES_PER_SECOND_DEFAULT = 500
    static let LEASE_EVERY_MS: Int64 = 20000
    static let LEASE_DEADLINE_MS: Int64 = 45000
    private static let REKEY_AFTER_MS: Int64 = 3_600_000
    private static let REKEY_AFTER_MESSAGES: UInt64 = 1 << 32

    private let wire: Wire
    private let send: NoiseCipher
    private let receiveCipher: NoiseCipher
    private let maxDataBytes: Int
    private let listener: Listener
    private let clock: () -> Int64
    private let pacer: FramePacer
    /// Java's `synchronized (this)`, reentrant as it is: `open` sends while holding it.
    private let lock = NSRecursiveLock()
    private let streamsLock = NSLock()
    private var streams: [Int: TunnelStream] = [:]
    private var highest: Int64 = 0
    private var keyedAt: Int64
    private var keyedNonce: UInt64 = 0
    private let leaseAt: Locked<Int64>
    private let ended = Locked(false)

    init(wire: @escaping Wire, keys: NoiseHandshake.Keys, frameBytes: Int, pacer: FramePacer? = nil, listener: @escaping Listener,
         clock: @escaping () -> Int64) {
        self.wire = wire
        send = keys.send
        receiveCipher = keys.receive
        maxDataBytes = TunnelRecord.maxData(frameBytes)
        self.pacer = pacer ?? FramePacer(framesPerSecond: Self.FRAMES_PER_SECOND_DEFAULT, clock: clock)
        self.listener = listener
        self.clock = clock
        keyedAt = clock()
        leaseAt = Locked(keyedAt)
    }

    /// `HELLO`, then `LEASE`, the required opening (§ 12.1).
    func start() throws {
        try sendFrame(TunnelFrame.hello(min: Self.TUNNEL_MIN, max: Self.TUNNEL_MAX))
        try sendFrame(TunnelFrame.lease())
    }

    func maxData() -> Int { maxDataBytes }

    func live() -> Bool { !ended.value }

    func lease() throws {
        try sendFrame(TunnelFrame.lease())
    }

    /// True once cezar has been silent past the 45 s rule (§ 12.3).
    func leaseExpired() -> Bool { clock() - leaseAt.value >= Self.LEASE_DEADLINE_MS }

    /// Sends one frame, under the key the rekey rule says.
    func sendFrame(_ content: [UInt8]) throws {
        pacer.await()
        do {
            try encryptAndSend(content)
        } catch {
            // The nonce moved and the frame did not: nothing later could be decrypted.
            end()
            throw error
        }
    }

    /// The lock keeps nonce order equal to wire order.
    private func encryptAndSend(_ content: [UInt8]) throws {
        lock.lock()
        defer { lock.unlock() }
        if ended.value { throw RelayIOError("session ended") }
        try rekeyIfDue()
        try wire(try send.encrypt(TunnelRecord.pad(content)))
    }

    private func rekeyIfDue() throws {
        let due = clock() - keyedAt >= Self.REKEY_AFTER_MS || send.nonce - keyedNonce >= Self.REKEY_AFTER_MESSAGES
        if !due { return }
        try wire(try send.encrypt(TunnelRecord.pad(TunnelFrame.rekey())))
        send.rekey()
        keyedAt = clock()
        keyedNonce = send.nonce
    }

    /// Opens a stream. Nothing is sent when the head does not fit or the session is full.
    func open(method: String, target: String, headers: [TunnelFrame.Header]) throws -> TunnelStream {
        lock.lock()
        defer { lock.unlock() }
        if ended.value { throw RelayIOError("session ended") }
        if streamCount() >= Self.MAX_STREAMS { throw TooManyStreams() }
        if highest >= 0xffff_ffff { throw RelayIOError("stream ids exhausted") }
        let id = Int(highest + 1)
        let frame: [UInt8]
        do {
            frame = try TunnelFrame.open(stream: id, method: method, target: target, headers: headers)
        } catch {
            throw HeadTooLarge()
        }
        if frame.count > TunnelFrame.MAX_HEAD_BYTES { throw HeadTooLarge() }
        highest += 1
        let stream = TunnelStream(session: self, id: id)
        streamsLock.lock()
        streams[id] = stream
        streamsLock.unlock()
        try sendFrame(frame)
        return stream
    }

    private func streamCount() -> Int {
        streamsLock.lock()
        defer { streamsLock.unlock() }
        return streams.count
    }

    func forget(_ stream: TunnelStream) {
        streamsLock.lock()
        streams[stream.id] = nil
        streamsLock.unlock()
    }

    /// One Noise transport message from cezar. Any failure ends the session (§ 10.1).
    func receive(_ ciphertext: [UInt8]) {
        if ended.value { return }
        do {
            try handle(TunnelFrame.parse(TunnelRecord.unpad(receiveCipher.decrypt(ciphertext))))
        } catch {
            fail(TunnelFrame.CLOSE_PROTOCOL_ERROR)
        }
    }

    private func handle(_ frame: TunnelFrame) throws {
        switch frame.type {
        case TunnelFrame.LEASE:
            leaseAt.value = clock()
            return
        case TunnelFrame.REKEY:
            receiveCipher.rekey()
            return
        case TunnelFrame.CLOSE:
            let known = frame.code >= TunnelFrame.CLOSE_NORMAL && frame.code <= TunnelFrame.CLOSE_DEVICE_REMOVED
            closed(known ? frame.code : TunnelFrame.CLOSE_PROTOCOL_ERROR)
            return
        case TunnelFrame.HEAD, TunnelFrame.DATA, TunnelFrame.END, TunnelFrame.RESET, TunnelFrame.WINDOW:
            break
        default:
            throw TunnelRecord.Malformed("a frame this direction may not send")
        }
        lock.lock()
        let opened = Int64(frame.stream) <= highest
        lock.unlock()
        if !opened { throw TunnelRecord.Malformed("a stream that was never opened") }
        streamsLock.lock()
        let stream = streams[frame.stream]
        streamsLock.unlock()
        // Finished or reset already: it crossed in flight (§ 12.1).
        guard let stream else { return }
        switch frame.type {
        case TunnelFrame.HEAD: try stream.onHead(frame)
        case TunnelFrame.DATA: try stream.onData(frame)
        case TunnelFrame.END: try stream.onEnd()
        case TunnelFrame.RESET: stream.onReset(frame.code)
        default: stream.onWindow(frame.increment)
        }
    }

    private func fail(_ code: Int) {
        // "If it can."
        try? sendFrame(TunnelFrame.close(code: code))
        closed(code)
    }

    private func closed(_ code: Int) {
        end()
        listener(code)
    }

    /// Sends `CLOSE` as the last frame, best effort.
    func close(_ code: Int) {
        try? sendFrame(TunnelFrame.close(code: code))
        end()
    }

    /// Ends every stream, which is a 502 or an abort at the proxy (§ 10.1).
    func end() {
        lock.lock()
        if ended.value {
            lock.unlock()
            return
        }
        ended.value = true
        streamsLock.lock()
        let open = Array(streams.values)
        streams.removeAll()
        streamsLock.unlock()
        lock.unlock()
        for stream in open { stream.onLost() }
    }
}
