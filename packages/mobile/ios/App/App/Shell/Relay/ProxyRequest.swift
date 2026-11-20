import Foundation

/// What `ProxyRequest` reads from: one byte at a time, or a run of them. -1 is the end of the stream.
protocol ProxyInput: AnyObject {
    func read() throws -> Int
    func read(_ buffer: inout [UInt8], max: Int) throws -> Int
}

/// One HTTP/1.1 request head and its body, read strictly: other apps can reach this port too.
final class ProxyRequest {
    /// Answer this status and close, with nothing sent into the tunnel.
    struct Refused: Error {
        let status: Int
    }

    private static let MAX_HEAD = 32768
    private static let LINE = "([A-Z]+) ([^ ]+) HTTP/1\\.([01])"
    private static let NAME = "[A-Za-z0-9!#$%&'*+.^_`|~-]+"

    let method: String
    let target: String
    let http11: Bool
    let headers: [TunnelFrame.Header]
    private let input: ProxyInput
    private var left: Int64 = 0
    private let chunked: Bool
    private var chunkDone = false

    private init(method: String, target: String, http11: Bool, headers: [TunnelFrame.Header], input: ProxyInput) throws {
        self.method = method
        self.target = target
        self.http11 = http11
        self.headers = headers
        self.input = input
        let lengths = headers.filter { $0.name == "content-length" }.map(\.value)
        let encodings = headers.filter { $0.name == "transfer-encoding" }.map(\.value)
        if lengths.count > 1 || (!lengths.isEmpty && !encodings.isEmpty) || encodings.count > 1 { throw Refused(status: 400) }
        chunked = !encodings.isEmpty
        if chunked && encodings[0].lowercased() != "chunked" { throw Refused(status: 400) }
        if let length = lengths.first {
            guard RelayRegex.matches("[0-9]{1,18}", length), let parsed = Int64(length) else { throw Refused(status: 400) }
            left = parsed
        }
    }

    /// Nil on a clean end of the connection.
    static func read(_ input: ProxyInput) throws -> ProxyRequest? {
        var budget = MAX_HEAD
        guard let first = try line(input, &budget, first: true) else { return nil }
        guard let match = RelayRegex.groups(LINE, first), let method = match[1], let target = match[2], let minor = match[3] else {
            throw Refused(status: 400)
        }
        var headers: [TunnelFrame.Header] = []
        while true {
            guard let line = try line(input, &budget, first: false) else { throw Refused(status: 400) }
            if line.isEmpty { break }
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { throw Refused(status: 400) }
            let name = String(line[..<colon])
            if !RelayRegex.matches(NAME, name) { throw Refused(status: 400) }
            let value = trim(String(line[line.index(after: colon)...]))
            if !TunnelFrame.validHeaderValue(value) { throw Refused(status: 400) }
            headers.append(TunnelFrame.Header(name: name.lowercased(), value: value))
        }
        return try ProxyRequest(method: method, target: target, http11: minor == "1", headers: headers, input: input)
    }

    private static func trim(_ value: String) -> String {
        var scalars = Substring.UnicodeScalarView(value.unicodeScalars)
        while let first = scalars.first, first == " " || first == "\t" { scalars.removeFirst() }
        while let last = scalars.last, last == " " || last == "\t" { scalars.removeLast() }
        return String(scalars)
    }

    /// CRLF only: a bare LF is the classic smuggling split.
    private static func line(_ input: ProxyInput, _ budget: inout Int, first: Bool) throws -> String? {
        var out: [UInt8] = []
        while true {
            let b = try input.read()
            if b == -1 {
                if first && out.isEmpty { return nil }
                throw Refused(status: 400)
            }
            budget -= 1
            if budget < 0 { throw Refused(status: 431) }
            if b == 0x0a { throw Refused(status: 400) }
            if b == 0x0d {
                if try input.read() != 0x0a { throw Refused(status: 400) }
                if let lead = out.first, lead == 0x20 || lead == 0x09 { throw Refused(status: 400) }
                return Latin1.decode(out)
            }
            out.append(UInt8(b))
        }
    }

    func header(_ name: String) -> String? { headers.first { $0.name == name }?.value }

    func all(_ name: String) -> [String] { headers.filter { $0.name == name }.map(\.value) }

    /// Up to `buffer.count` bytes of the body, -1 at its end. A short body throws.
    func readBody(_ buffer: inout [UInt8]) throws -> Int {
        if chunked ? chunkDone : left == 0 { return -1 }
        if chunked && left == 0 {
            left = try chunkSize()
            if left == 0 {
                while true {
                    var budget = Self.MAX_HEAD
                    guard let trailer = try Self.line(input, &budget, first: false), !trailer.isEmpty else { break }
                }
                chunkDone = true
                return -1
            }
        }
        let count = try input.read(&buffer, max: Int(min(Int64(buffer.count), left)))
        if count < 0 { throw RelayIOError("short body") }
        left -= Int64(count)
        if chunked && left == 0 {
            if try input.read() != 0x0d || input.read() != 0x0a { throw RelayIOError("bad chunk") }
        }
        return count
    }

    private func chunkSize() throws -> Int64 {
        var budget = 64
        let line = try Self.line(input, &budget, first: false) ?? ""
        let size = line.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard RelayRegex.matches("[0-9a-fA-F]{1,8}", size), let parsed = Int64(size, radix: 16) else { throw RelayIOError("bad chunk size") }
        return parsed
    }
}
