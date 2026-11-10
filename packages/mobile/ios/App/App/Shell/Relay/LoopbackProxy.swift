import Foundation
import Network

/// The plain-HTTP face of the tunnel under the webview (spec "The proxy's rules", RELAY_PROTOCOL.md § 13).
/// Binds 127.0.0.1 only. Other apps on the phone can reach the port, so every request passes the gate
/// first, and nothing that fails it enters the tunnel.
final class LoopbackProxy {
    /// The live session, or nil.
    typealias Tunnel = () -> TunnelSession?

    static let COOKIE = "cezar_gate"
    private static let MAX_CONNECTIONS = 64
    private static let HEAD_TIMEOUT_MS: Int64 = 30000
    private static let KEEP_ALIVE_MS: Int64 = 60000
    private static let READ_CHUNK = 65536
    private static let BIND_WAIT_SECONDS = 5.0
    /// Added beside the server's own policy, which still applies: the cookie must not reach another loopback port.
    private static let CONTENT_SECURITY_POLICY = "content-security-policy: connect-src 'self'\r\n"
    private static let DROPPED_REQUEST: Set<String> = [
        "host", "origin", "cookie", "authorization", "x-cezar-runtime-handoff", "forwarded", "x-real-ip", "user-agent", "expect",
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
    ]
    private static let DROPPED_RESPONSE: Set<String> = [
        "set-cookie", "www-authenticate",
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
    ]

    struct BindFailed: Error {}

    private let tunnel: Tunnel
    private let userAgent: String
    private let cookie = Bytes.hex(RelayCrypto.random(32))
    private let listenerQueue = DispatchQueue(label: "cezar-proxy-accept")
    private let lock = NSLock()
    private var connections: [ObjectIdentifier: ProxyConnection] = [:]
    /// Oldest first. Any app can open these, so they give way before the webview does.
    private var ungated: [ProxyConnection] = []
    private var listener: NWListener?
    private var boundPort = 0
    private var authority = ""
    private var allowedOrigin = ""
    private var reboundFlag = false
    private let serving = Locked(true)
    private let closed = Locked(false)
    private let up = Locked(false)

    init(tunnel: @escaping Tunnel, userAgent: String) {
        self.tunnel = tunnel
        self.userAgent = userAgent
    }

    /// Binds the saved port, else a new one. `rebound()` then says the old port was taken, which
    /// spec "A taken port is hostile" treats as a page to tear down, never a port to wait for. Blocks briefly.
    func open(preferredPort: Int) throws -> Int {
        do {
            try bind(preferredPort)
        } catch {
            if preferredPort == 0 { throw error }
            reboundFlag = true
            try bind(0)
        }
        authority = "127.0.0.1:\(boundPort)"
        allowedOrigin = "http://" + authority
        return boundPort
    }

    private func bind(_ port: Int) throws {
        let parameters = NWParameters.tcp
        if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options { tcp.noDelay = true }
        parameters.allowLocalEndpointReuse = false
        let local: NWEndpoint.Port = port == 0 ? .any : NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? .any
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: local)
        let candidate = try NWListener(using: parameters)
        let settled = DispatchSemaphore(value: 0)
        let outcome = Locked<Bool?>(nil)
        candidate.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if outcome.value == nil { outcome.value = true; settled.signal() }
            case .failed, .waiting:
                if outcome.value == nil { outcome.value = false; settled.signal() }
            default:
                break
            }
        }
        candidate.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        candidate.start(queue: listenerQueue)
        _ = settled.wait(timeout: .now() + Self.BIND_WAIT_SECONDS)
        guard outcome.value == true, let bound = candidate.port?.rawValue, bound != 0, port == 0 || Int(bound) == port else {
            Self.cancelAndWait(candidate)
            throw BindFailed()
        }
        let up = self.up
        up.value = true
        candidate.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled: up.value = false
            default: break
            }
        }
        listener = candidate
        boundPort = Int(bound)
    }

    /// The port is free again when this returns, as Java's `ServerSocket.close` leaves it.
    private static func cancelAndWait(_ listener: NWListener) {
        let gone = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .cancelled = state { gone.signal() }
        }
        listener.cancel()
        _ = gone.wait(timeout: .now() + 2)
    }

    func rebound() -> Bool { reboundFlag }

    /// False once iOS has torn the listener down (a long suspension can): open a new proxy then.
    func listening() -> Bool { up.value && !closed.value }

    func port() -> Int { boundPort }

    /// A new random value per listener, set by native code in the webview store. Never in a URL, never logged.
    func cookieValue() -> String { cookie }

    /// The cookie for the server's own WKWebsiteDataStore, set before the first load (spec R0 question 2).
    /// Host-only on 127.0.0.1: cookies ignore ports, which is why every answer carries `connect-src 'self'`.
    func gateCookie() -> HTTPCookie? {
        HTTPCookie(properties: [
            .name: Self.COOKIE, .value: cookie, .domain: "127.0.0.1", .path: "/",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict.rawValue,
        ])
    }

    /// Off in the background: the port stays bound so nobody can take it, and live streams die (spec).
    func setServing(_ value: Bool) {
        serving.value = value
        if !value { closeConnections() }
    }

    private func closeConnections() {
        lock.lock()
        let open = Array(connections.values)
        lock.unlock()
        for connection in open { connection.cancel() }
    }

    func close() {
        closed.value = true
        if let listener { Self.cancelAndWait(listener) }
        closeConnections()
    }

    /// On the listener's queue. Java's accept loop; Network.framework backs off on its own when out of descriptors.
    private func accept(_ raw: NWConnection) {
        if closed.value {
            raw.cancel()
            return
        }
        let connection = ProxyConnection(raw)
        lock.lock()
        if connections.count >= Self.MAX_CONNECTIONS && !evictUngatedLocked() {
            lock.unlock()
            raw.cancel()
            return
        }
        connections[ObjectIdentifier(connection)] = connection
        ungated.append(connection)
        lock.unlock()
        connection.start()
        let worker = Thread { [weak self] in
            defer {
                connection.cancel()
                self?.forget(connection)
            }
            // The connection went away. The stream, if any, was cancelled on the way out.
            try? self?.serve(connection)
        }
        worker.name = "cezar-proxy"
        worker.start()
    }

    private func forget(_ connection: ProxyConnection) {
        lock.lock()
        connections[ObjectIdentifier(connection)] = nil
        ungated.removeAll { $0 === connection }
        lock.unlock()
    }

    private func evictUngatedLocked() -> Bool {
        guard !ungated.isEmpty else { return false }
        let oldest = ungated.removeFirst()
        connections[ObjectIdentifier(oldest)] = nil
        oldest.cancel()
        return true
    }

    private func serve(_ connection: ProxyConnection) throws {
        connection.readTimeoutMs = Self.HEAD_TIMEOUT_MS
        while true {
            let request: ProxyRequest
            do {
                guard let read = try ProxyRequest.read(connection) else { return }
                request = read
            } catch let refused as ProxyRequest.Refused {
                try Self.plain(connection, refused.status, nil)
                return
            } catch is ProxyConnection.Timeout {
                return
            }
            let refusal = gate(request)
            if refusal != 0 {
                try Self.plain(connection, refusal, nil)
                return
            }
            lock.lock()
            ungated.removeAll { $0 === connection }
            lock.unlock()
            if !serving.value {
                try Self.plain(connection, 503, "retry-after: 1\r\n")
                return
            }
            let again = try exchange(connection, request)
            let clientCloses = request.header("connection")?.lowercased().contains("close") ?? false
            if !again || !request.http11 || clientCloses { return }
            connection.readTimeoutMs = Self.KEEP_ALIVE_MS
        }
    }

    /// The gate of § 13.1: a status to refuse with, or 0.
    private func gate(_ request: ProxyRequest) -> Int {
        let hosts = request.all("host")
        if hosts.count != 1 || hosts[0] != authority { return 403 }
        if !hasCookie(request) { return 403 }
        let origins = request.all("origin")
        if origins.count > 1 || (origins.count == 1 && origins[0] != allowedOrigin) { return 403 }
        let sites = request.all("sec-fetch-site")
        if sites.count > 1 { return 403 }
        if sites.count == 1 && sites[0] != "same-origin" && sites[0] != "none" { return 403 }
        if !request.all("upgrade").isEmpty { return 400 }
        if !TunnelFrame.validMethod(request.method) { return 405 }
        if request.target.utf8.count > TunnelFrame.MAX_TARGET_BYTES { return 431 }
        if !TunnelFrame.validTarget(request.target) { return 400 }
        // Its length is one byte in `OPEN`, so a longer name would corrupt the frame.
        for header in request.headers where header.name.utf8.count > TunnelFrame.MAX_NAME_BYTES { return 431 }
        return 0
    }

    private func hasCookie(_ request: ProxyRequest) -> Bool {
        let expected = Bytes.ascii(cookie)
        var found = false
        for header in request.all("cookie") {
            for pair in header.split(separator: ";", omittingEmptySubsequences: false) {
                guard let equals = pair.firstIndex(of: "=") else { continue }
                if pair[..<equals].trimmingCharacters(in: .whitespaces) != Self.COOKIE { continue }
                let value = Latin1.encode(pair[pair.index(after: equals)...].trimmingCharacters(in: .whitespaces))
                found = Bytes.constantTimeEqual(expected, value) || found
            }
        }
        return found
    }

    private func forwarded(_ request: ProxyRequest) -> [TunnelFrame.Header] {
        var out = request.headers.filter { header in
            !Self.DROPPED_REQUEST.contains(header.name) && !header.name.hasPrefix("x-forwarded-") && !header.name.hasPrefix("sec-fetch-")
        }
        out.append(TunnelFrame.Header(name: "user-agent", value: userAgent))
        return out
    }

    /// One request through the tunnel. True when the connection can carry another. Never retried.
    private func exchange(_ connection: ProxyConnection, _ request: ProxyRequest) throws -> Bool {
        guard let session = tunnel(), session.live() else {
            try Self.plain(connection, 503, "retry-after: 1\r\n")
            return false
        }
        let stream: TunnelStream
        do {
            stream = try session.open(method: request.method, target: request.target, headers: forwarded(request))
        } catch is TunnelSession.HeadTooLarge {
            try Self.plain(connection, 431, nil)
            return false
        } catch {
            try Self.plain(connection, 503, "retry-after: 1\r\n")
            return false
        }
        defer { stream.cancel(TunnelFrame.RESET_CANCELLED) }
        if request.header("expect")?.lowercased() == "100-continue" {
            connection.write(Bytes.ascii("HTTP/1.1 100 Continue\r\n\r\n"))
            try connection.flush()
        }
        let bodySent = try pumpBody(request, stream)
        return try respond(connection, request, stream) && bodySent
    }

    /// False when the stream went away mid-body. What is left is drained, then the answer is read.
    private func pumpBody(_ request: ProxyRequest, _ stream: TunnelStream) throws -> Bool {
        var buffer = [UInt8](repeating: 0, count: Self.READ_CHUNK)
        var flowing = true
        while true {
            let count: Int
            do {
                count = try request.readBody(&buffer)
            } catch {
                // A body that does not match what its head said.
                stream.cancel(TunnelFrame.RESET_BAD_REQUEST)
                throw error
            }
            if count == -1 { break }
            if !flowing { continue }
            do {
                try stream.write(buffer, offset: 0, length: count)
            } catch {
                flowing = false
            }
        }
        if flowing { try stream.finishRequest() }
        return flowing
    }

    private func respond(_ connection: ProxyConnection, _ request: ProxyRequest, _ stream: TunnelStream) throws -> Bool {
        var started = false
        var chunked = false
        var bodiless = false
        var remaining: Int64 = -1
        while true {
            guard let event = stream.next(timeoutMs: 1000) else {
                if connection.clientLeft() { return false }
                continue
            }
            switch event.kind {
            case .head:
                started = true
                bodiless = request.method == "HEAD" || event.status == 204 || event.status == 304
                if let length = Self.headerOf(event.headers, "content-length"), RelayRegex.matches("[0-9]{1,18}", length) {
                    remaining = Int64(length) ?? -1
                }
                chunked = !bodiless && remaining < 0
                connection.write(Self.head(event, chunked: chunked))
                if bodiless { remaining = 0 }
                try connection.flush()
            case .data:
                // Past its content-length the rest would read as a second response on this keep-alive
                // connection (security review F5): send what was promised, then close.
                if !bodiless && !chunked && remaining >= 0 && Int64(event.data.count) > remaining {
                    connection.write(Array(event.data.prefix(Int(remaining))))
                    try connection.flush()
                    return false
                }
                if !bodiless {
                    if chunked { connection.write(Bytes.ascii(String(event.data.count, radix: 16) + "\r\n")) }
                    connection.write(event.data)
                    if chunked { connection.write(Bytes.ascii("\r\n")) }
                    if remaining > 0 { remaining -= Int64(event.data.count) }
                    // Flushed per frame: this is what keeps SSE live (§ 12.2).
                    try connection.flush()
                }
                stream.consumed(event.data.count)
            case .end:
                if chunked { connection.write(Bytes.ascii("0\r\n\r\n")) }
                try connection.flush()
                // A short body would otherwise read as complete.
                return bodiless || remaining <= 0
            case .reset, .lost:
                if started { return false }
                if event.kind == .reset && event.code == TunnelFrame.RESET_TOO_MANY_STREAMS {
                    try Self.plain(connection, 503, "retry-after: 1\r\n")
                } else {
                    try Self.plain(connection, 502, nil)
                }
                return false
            }
        }
    }

    private static func headerOf(_ headers: [TunnelFrame.Header], _ name: String) -> String? {
        headers.first { $0.name == name }?.value
    }

    private static func head(_ head: TunnelStream.Event, chunked: Bool) -> [UInt8] {
        var text = "HTTP/1.1 \(head.status) \(reason(head.status))\r\n"
        for header in head.headers where !DROPPED_RESPONSE.contains(header.name) {
            text += "\(header.name): \(header.value)\r\n"
        }
        text += CONTENT_SECURITY_POLICY
        if chunked { text += "transfer-encoding: chunked\r\n" }
        text += "\r\n"
        return Latin1.encode(text)
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 304: return "Not Modified"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 431: return "Request Header Fields Too Large"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }

    private static func plain(_ connection: ProxyConnection, _ status: Int, _ extra: String?) throws {
        let text = "HTTP/1.1 \(status) \(reason(status))\r\ncontent-length: 0\r\ncache-control: no-store\r\n" + (extra ?? "") + "connection: close\r\n\r\n"
        connection.write(Bytes.ascii(text))
        try connection.flush()
    }
}
