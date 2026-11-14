import Foundation

/// One tunnel frame, encoded and refused exactly as RELAY_PROTOCOL.md §§ 12, 13.1 say.
struct TunnelFrame {
    static let HELLO = 0, OPEN = 1, HEAD = 2, DATA = 3, END = 4, RESET = 5, WINDOW = 6, LEASE = 7, REKEY = 8, CLOSE = 9
    static let RESET_CANCELLED = 1, RESET_FLOW_CONTROL = 2, RESET_BAD_REQUEST = 3, RESET_TOO_MANY_STREAMS = 4, RESET_HEAD_TOO_LARGE = 5
    static let RESET_INTERNAL = 6
    static let CLOSE_NORMAL = 1, CLOSE_GOODBYE = 2, CLOSE_LEASE_EXPIRED = 3, CLOSE_PROTOCOL_ERROR = 4, CLOSE_TUNNEL_UNSUPPORTED = 5
    static let CLOSE_DEVICE_REMOVED = 6
    static let MAX_WINDOW = 262_144
    /// An `OPEN` or `HEAD` frame's content limit, § 13.1.
    static let MAX_HEAD_BYTES = 16000
    static let MAX_TARGET_BYTES = 8192
    /// A header name's length is one byte on the wire.
    static let MAX_NAME_BYTES = 255

    /// A field the wire cannot carry: Java's `IllegalArgumentException` from `str8`.
    struct TooLong: Error {}

    struct Header: Equatable {
        let name: String
        let value: String
    }

    private static let methods: Set<String> = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    private static let nameBytes = Set(Array("abcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+.^_`|~-".utf8))

    let type: Int
    var stream = 0
    var min = 0, max = 0
    var method = "", target = ""
    var status = 0
    var code = 0
    var increment = 0
    var data: [UInt8] = []
    var headers: [Header] = []

    static func validMethod(_ method: String) -> Bool { methods.contains(method) }

    /// One leading `/`, printable ASCII with no `\`, within the limit (§ 13.1).
    static func validTarget(_ target: String) -> Bool {
        let bytes = Array(target.utf8)
        if bytes.isEmpty || bytes.count > MAX_TARGET_BYTES || bytes[0] != 0x2f || (bytes.count > 1 && bytes[1] == 0x2f) { return false }
        return bytes.allSatisfy { $0 > 0x20 && $0 < 0x7f && $0 != 0x5c }
    }

    static func validHeaderValue(_ value: String) -> Bool {
        !value.unicodeScalars.contains { $0 == "\r" || $0 == "\n" || $0 == "\0" }
    }

    static func validName(_ name: String) -> Bool {
        let bytes = Array(name.utf8)
        return !bytes.isEmpty && bytes.allSatisfy { nameBytes.contains($0) }
    }

    static func hello(min: Int, max: Int) -> [UInt8] {
        var out: [UInt8] = [UInt8(HELLO)]
        int16(&out, min)
        int16(&out, max)
        return out
    }

    static func open(stream: Int, method: String, target: String, headers: [Header]) throws -> [UInt8] {
        var out: [UInt8] = [UInt8(OPEN)]
        int32(&out, stream)
        try str8(&out, Bytes.ascii(method))
        let path = Bytes.ascii(target)
        guard path.count <= 0xffff else { throw TooLong() }
        int16(&out, path.count)
        out += path
        try writeHeaders(&out, headers)
        return out
    }

    /// cezar's half: the client never sends it, but the vectors and the local test peer do.
    static func head(stream: Int, status: Int, headers: [Header]) throws -> [UInt8] {
        var out: [UInt8] = [UInt8(HEAD)]
        int32(&out, stream)
        int16(&out, status)
        try writeHeaders(&out, headers)
        return out
    }

    static func data(stream: Int, _ payload: [UInt8], offset: Int = 0, length: Int? = nil) -> [UInt8] {
        let count = length ?? payload.count - offset
        var out: [UInt8] = [UInt8(DATA)]
        out.reserveCapacity(5 + count)
        int32(&out, stream)
        out += payload[offset..<offset + count]
        return out
    }

    static func end(stream: Int) -> [UInt8] {
        var out: [UInt8] = [UInt8(END)]
        int32(&out, stream)
        return out
    }

    static func reset(stream: Int, code: Int) -> [UInt8] {
        var out: [UInt8] = [UInt8(RESET)]
        int32(&out, stream)
        int16(&out, code)
        return out
    }

    static func window(stream: Int, increment: Int) -> [UInt8] {
        var out: [UInt8] = [UInt8(WINDOW)]
        int32(&out, stream)
        int32(&out, increment)
        return out
    }

    static func lease() -> [UInt8] { [UInt8(LEASE)] }
    static func rekey() -> [UInt8] { [UInt8(REKEY)] }

    static func close(code: Int) -> [UInt8] {
        var out: [UInt8] = [UInt8(CLOSE)]
        int16(&out, code)
        return out
    }

    private static func int16(_ out: inout [UInt8], _ value: Int) {
        out.append(UInt8(truncatingIfNeeded: value >> 8))
        out.append(UInt8(truncatingIfNeeded: value))
    }

    private static func int32(_ out: inout [UInt8], _ value: Int) {
        int16(&out, value >> 16)
        int16(&out, value)
    }

    private static func str8(_ out: inout [UInt8], _ bytes: [UInt8]) throws {
        if bytes.count > MAX_NAME_BYTES { throw TooLong() }
        out.append(UInt8(bytes.count))
        out += bytes
    }

    private static func writeHeaders(_ out: inout [UInt8], _ headers: [Header]) throws {
        guard headers.count <= 0xffff else { throw TooLong() }
        int16(&out, headers.count)
        for header in headers {
            try str8(&out, Bytes.utf8(header.name))
            let value = Latin1.encode(header.value)
            guard value.count <= 0xffff else { throw TooLong() }
            int16(&out, value.count)
            out += value
        }
    }

    /// Any malformed frame is refused here, which the caller turns into a protocol error.
    static func parse(_ content: [UInt8]) throws -> TunnelFrame {
        if content.isEmpty { throw TunnelRecord.Malformed("empty frame") }
        var input = Reader(bytes: content, at: 1)
        var frame = TunnelFrame(type: Int(content[0]))
        switch frame.type {
        case HELLO:
            frame.min = try input.u16()
            frame.max = try input.u16()
        case OPEN:
            frame.stream = try input.streamId()
            frame.method = try input.str(input.u8())
            frame.target = try input.str(input.u16())
            frame.headers = try input.headers()
            if !validMethod(frame.method) || !validTarget(frame.target) { throw TunnelRecord.Malformed("bad OPEN") }
        case HEAD:
            frame.stream = try input.streamId()
            frame.status = try input.u16()
            frame.headers = try input.headers()
            if frame.status < 200 || frame.status > 599 { throw TunnelRecord.Malformed("bad status") }
        case DATA:
            frame.stream = try input.streamId()
            frame.data = input.rest()
        case END:
            frame.stream = try input.streamId()
        case RESET:
            frame.stream = try input.streamId()
            frame.code = try input.u16()
        case WINDOW:
            frame.stream = try input.streamId()
            frame.increment = try input.i32()
            if frame.increment < 1 || frame.increment > MAX_WINDOW { throw TunnelRecord.Malformed("bad increment") }
        case LEASE, REKEY:
            break
        case CLOSE:
            frame.code = try input.u16()
        default:
            throw TunnelRecord.Malformed("unknown type")
        }
        if input.hasRemaining { throw TunnelRecord.Malformed("trailing bytes") }
        return frame
    }

    /// Java's `ByteBuffer`, where an underflow is a truncated frame. Stream ids read unsigned.
    private struct Reader {
        let bytes: [UInt8]
        var at: Int

        var hasRemaining: Bool { at < bytes.count }

        mutating func take(_ count: Int) throws -> ArraySlice<UInt8> {
            guard count >= 0, bytes.count - at >= count else { throw TunnelRecord.Malformed("truncated frame") }
            defer { at += count }
            return bytes[at..<at + count]
        }

        mutating func u8() throws -> Int { Int(try take(1).first!) }

        mutating func u16() throws -> Int {
            let b = try take(2)
            return (Int(b[b.startIndex]) << 8) | Int(b[b.startIndex + 1])
        }

        mutating func u32() throws -> UInt32 {
            let b = try take(4)
            return (UInt32(b[b.startIndex]) << 24) | (UInt32(b[b.startIndex + 1]) << 16) | (UInt32(b[b.startIndex + 2]) << 8) | UInt32(b[b.startIndex + 3])
        }

        mutating func i32() throws -> Int { Int(Int32(bitPattern: try u32())) }

        /// Unsigned, 1 to 2^32 - 1 (§ 12.1).
        mutating func streamId() throws -> Int {
            let id = Int(try u32())
            if id == 0 { throw TunnelRecord.Malformed("stream id zero") }
            return id
        }

        mutating func str(_ length: Int) throws -> String { Latin1.decode(Array(try take(length))) }

        mutating func rest() -> [UInt8] {
            defer { at = bytes.count }
            return Array(bytes[at...])
        }

        mutating func headers() throws -> [Header] {
            let count = try u16()
            var out: [Header] = []
            for _ in 0..<count {
                let name = try str(u8())
                let value = try str(u16())
                if !TunnelFrame.validName(name) || !TunnelFrame.validHeaderValue(value) { throw TunnelRecord.Malformed("bad header") }
                out.append(Header(name: name, value: value))
            }
            return out
        }
    }
}

/// ISO-8859-1, which HTTP header values travel in. Like Java, a character it cannot hold becomes `?`.
enum Latin1 {
    static func encode(_ text: String) -> [UInt8] {
        text.unicodeScalars.map { $0.value <= 0xff ? UInt8($0.value) : 0x3f }
    }

    static func decode(_ bytes: [UInt8]) -> String {
        var out = ""
        out.unicodeScalars.append(contentsOf: bytes.map { Unicode.Scalar($0) })
        return out
    }
}
