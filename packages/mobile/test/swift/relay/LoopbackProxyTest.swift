import Foundation

/// The proxy over a real loopback socket and a real session, with an in-memory cezar on the far side.
func loopbackProxyTests() {
    /// Decrypts what the session sends and hands each frame on, on one queue like the real peer.
    final class Peer {
        let receive: NoiseCipher
        let send: NoiseCipher
        let queue = DispatchQueue(label: "peer")
        let replyLock = NSLock()
        var session: TunnelSession!
        let bodies = Locked<[Int: [UInt8]]>([:])
        let opened = BlockingQueue<TunnelFrame>()
        let ended = BlockingQueue<Int>()
        let resets = BlockingQueue<TunnelFrame>()
        let dataBytes = Locked(0)
        let credit = Locked(-1)

        init(receive: NoiseCipher, send: NoiseCipher) {
            self.receive = receive
            self.send = send
        }

        func onWire(_ ciphertext: [UInt8]) {
            queue.async { [self] in
                guard let frame = try? TunnelFrame.parse(TunnelRecord.unpad(receive.decrypt(ciphertext))) else {
                    expect(false, "the peer could not read a frame")
                    return
                }
                handle(frame)
            }
        }

        func handle(_ frame: TunnelFrame) {
            switch frame.type {
            case TunnelFrame.OPEN:
                bodies.value[frame.stream] = []
                opened.add(frame)
            case TunnelFrame.DATA:
                bodies.value[frame.stream, default: []] += frame.data
                dataBytes.value += frame.data.count
                if credit.value != 0 { reply(TunnelFrame.window(stream: frame.stream, increment: frame.data.count)) }
            case TunnelFrame.END:
                ended.add(frame.stream)
            case TunnelFrame.RESET:
                resets.add(frame)
            default:
                break
            }
        }

        /// Two threads reply here, and the real link receives on one: nonce order must hold.
        func reply(_ content: [UInt8]) {
            replyLock.lock()
            defer { replyLock.unlock() }
            session.receive(try! send.encrypt(TunnelRecord.pad(content)))
        }

        func head(_ stream: Int, _ status: Int, _ pairs: String...) {
            var headers: [TunnelFrame.Header] = []
            var i = 0
            while i < pairs.count {
                headers.append(TunnelFrame.Header(name: pairs[i], value: pairs[i + 1]))
                i += 2
            }
            reply(try! TunnelFrame.head(stream: stream, status: status, headers: headers))
        }

        func data(_ stream: Int, _ bytes: [UInt8]) { reply(TunnelFrame.data(stream: stream, bytes)) }
    }

    final class World {
        let peer: Peer
        let session: TunnelSession
        let proxy: LoopbackProxy
        let sessionUp = Locked(true)
        var clients: [LoopbackClient] = []

        init() throws {
            let toCezar = RelayCrypto.random(32)
            let toPhone = RelayCrypto.random(32)
            let peer = Peer(receive: NoiseCipher(toCezar), send: NoiseCipher(toPhone))
            self.peer = peer
            session = TunnelSession(wire: { peer.onWire($0) }, keys: NoiseHandshake.Keys(send: NoiseCipher(toCezar), receive: NoiseCipher(toPhone)),
                                    frameBytes: 65552, listener: { _ in }, clock: relayNowMs)
            peer.session = session
            try session.start()
            let up = sessionUp
            let session = self.session
            proxy = LoopbackProxy(tunnel: { up.value ? session : nil }, userAgent: "CezarMobile/0.1.0 (ios)")
            _ = try proxy.open(preferredPort: 0)
        }

        func stop() {
            proxy.close()
            for client in clients { client.close() }
        }

        func connect() throws -> LoopbackClient {
            let client = try LoopbackClient(port: proxy.port())
            clients.append(client)
            return client
        }

        func gated(_ method: String, _ target: String, _ extra: String) -> String {
            "\(method) \(target) HTTP/1.1\r\nHost: 127.0.0.1:\(proxy.port())\r\nCookie: \(LoopbackProxy.COOKIE)=\(proxy.cookieValue())\r\n\(extra)\r\n"
        }

        func refused(_ request: String, _ status: String, line: Int = #line) throws {
            let client = try connect()
            client.send(request)
            let head = client.readHead()
            expect(head.hasPrefix("HTTP/1.1 \(status)"), "\(request.prefix(60)) -> \(status), got \(head.prefix(20))", line: line)
            expect(peer.opened.poll(timeoutMs: 100) == nil, "nothing enters the tunnel", line: line)
        }
    }

    func run(_ name: String, _ body: (World) throws -> Void) {
        test(name) {
            let world = try World()
            defer { world.stop() }
            try body(world)
        }
    }

    run("the gate refuses before the tunnel") { w in
        let host = "Host: 127.0.0.1:\(w.proxy.port())\r\n"
        let cookie = "Cookie: \(LoopbackProxy.COOKIE)=\(w.proxy.cookieValue())\r\n"
        try w.refused("GET / HTTP/1.1\r\n" + host + "\r\n", "403")
        try w.refused("GET / HTTP/1.1\r\n" + host + "Cookie: \(LoopbackProxy.COOKIE)=wrong\r\n\r\n", "403")
        try w.refused("GET / HTTP/1.1\r\n" + host + "Cookie: \(LoopbackProxy.COOKIE)=\(w.proxy.cookieValue())x\r\n\r\n", "403")
        try w.refused("GET / HTTP/1.1\r\nHost: localhost:\(w.proxy.port())\r\n" + cookie + "\r\n", "403")
        try w.refused("GET / HTTP/1.1\r\nHost: evil.example\r\n" + cookie + "\r\n", "403")
        try w.refused("GET / HTTP/1.1\r\n" + cookie + "\r\n", "403")
        try w.refused(w.gated("POST", "/x", "Origin: http://127.0.0.1:1\r\n"), "403")
        try w.refused(w.gated("POST", "/x", "Origin: null\r\n"), "403")
        try w.refused(w.gated("GET", "/x", "Sec-Fetch-Site: same-site\r\n"), "403")
        try w.refused(w.gated("GET", "/x", "Sec-Fetch-Site: cross-site\r\n"), "403")
        try w.refused(w.gated("GET", "/x", "Upgrade: websocket\r\nConnection: Upgrade\r\n"), "400")
        try w.refused(w.gated("CONNECT", "/x", ""), "405")
        try w.refused(w.gated("GET", "http://evil/x", ""), "400")
        try w.refused(w.gated("GET", "//evil/x", ""), "400")
        try w.refused(w.gated("GET", "/\\evil/x", ""), "400")
    }

    run("malformed requests are refused") { w in
        try w.refused("GET / HTTP/1.1\nHost: x\n\n", "400")
        try w.refused(w.gated("POST", "/x", "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n"), "400")
        try w.refused(w.gated("POST", "/x", "Content-Length: 1\r\nContent-Length: 2\r\n"), "400")
        try w.refused(w.gated("GET", "/" + String(repeating: "a", count: 9000), ""), "431")
        try w.refused(w.gated("GET", "/x", String(repeating: "a", count: 256) + ": v\r\n"), "431")
        try w.refused(w.gated("GET", "/x", "X-A: 1\r\n folded\r\n"), "400")
        try w.refused(w.gated("GET", "/x", "X-Big: " + String(repeating: "v", count: 33000) + "\r\n"), "431")
    }

    run("the longest header name the wire can carry round-trips") { w in
        let name = String(repeating: "a", count: 255)
        try w.connect().send(w.gated("GET", "/x", name + ": v\r\n"))
        let opened = w.peer.opened.poll(timeoutMs: 2000)
        expect(opened?.headers.first?.name == name && opened?.headers.first?.value == "v", "255-byte name")
    }

    run("idle sockets with no cookie cannot starve the webview") { w in
        for _ in 0..<64 { _ = try w.connect() }
        Thread.sleep(forTimeInterval: 0.2)
        let held = try w.connect()
        held.send(w.gated("GET", "/x", ""))
        guard let opened = w.peer.opened.poll(timeoutMs: 3000) else {
            expect(false, "the 65th connection reached the tunnel")
            return
        }
        w.peer.head(opened.stream, 204)
        expect(held.readHead().hasPrefix("HTTP/1.1 204"), "answered")
    }

    run("every answer keeps the page off other loopback ports") { w in
        let client = try w.connect()
        client.send(w.gated("GET", "/x", ""))
        guard let opened = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(opened.stream, 200, "content-length", "0", "content-security-policy", "default-src 'none'")
        let head = client.readHead()
        expect(head.contains("content-security-policy: connect-src 'self'\r\n"), "our policy")
        expect(head.contains("content-security-policy: default-src 'none'\r\n"), "the server's own policy still applies")
    }

    run("headers are dropped and the user agent replaced") { w in
        let client = try w.connect()
        client.send(w.gated("GET", "/api/x?y=1", "Origin: http://127.0.0.1:\(w.proxy.port())\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\n"
            + "Authorization: Basic x\r\nX-Forwarded-For: 1.2.3.4\r\nX-Real-IP: 1.2.3.4\r\nForwarded: for=1\r\nX-Cezar-Runtime-Handoff: t\r\n"
            + "User-Agent: webview\r\nAccept: */*\r\n"))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        expect(open.method == "GET" && open.target == "/api/x?y=1", "method and target")
        expect(open.headers.map { "\($0.name)=\($0.value)" } == ["accept=*/*", "user-agent=CezarMobile/0.1.0 (ios)"], "only accept and our UA")
        expect(w.peer.ended.poll(timeoutMs: 2000) == open.stream, "END")
        w.peer.head(open.stream, 200, "content-length", "2", "set-cookie", "a=1", "www-authenticate", "Basic realm=x", "connection", "keep-alive")
        w.peer.data(open.stream, Bytes.ascii("ok"))
        w.peer.reply(TunnelFrame.end(stream: open.stream))
        let head = client.readHead()
        expect(head.hasPrefix("HTTP/1.1 200") && head.contains("content-length: 2"), "200")
        expect(!head.contains("set-cookie") && !head.contains("www-authenticate"), "dropped")
        expect(try client.read() == 0x6f, "body")
    }

    // Security review F5: bytes past content-length would read as a second response on a kept-alive socket.
    run("a body longer than its content-length is cut and the connection closed") { w in
        let client = try w.connect()
        client.setTimeout(3000)
        client.send(w.gated("GET", "/x", ""))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 200, "content-length", "2")
        w.peer.data(open.stream, Bytes.ascii("okHTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\nevil"))
        w.peer.reply(TunnelFrame.end(stream: open.stream))
        expect(client.readHead().hasPrefix("HTTP/1.1 200"), "200")
        var rest: [UInt8] = []
        while let byte = try? client.read(), byte >= 0 { rest.append(UInt8(byte)) }
        expect(rest == Bytes.ascii("ok"), "only the promised two bytes, then EOF; got \(rest.count) bytes")
    }

    run("a POST larger than one frame arrives intact") { w in
        // Approvals depend on this.
        let body = RelayCrypto.random(200_000)
        let client = try w.connect()
        client.send(w.gated("POST", "/api/approve", "Content-Type: application/octet-stream\r\nContent-Length: \(body.count)\r\n"))
        client.send(body)
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        expect(w.peer.ended.poll(timeoutMs: 5000) == open.stream, "END")
        expect(w.peer.bodies.value[open.stream] == body, "intact")
        expect(open.headers.contains(TunnelFrame.Header(name: "content-length", value: "200000")), "content-length kept")
    }

    run("a chunked body is decoded before framing") { w in
        let client = try w.connect()
        client.send(w.gated("POST", "/x", "Transfer-Encoding: chunked\r\n") + "5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n")
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        expect(w.peer.ended.poll(timeoutMs: 2000) == open.stream, "END")
        expect(w.peer.bodies.value[open.stream].map(text) == "hello world", "decoded")
    }

    run("a body shorter than its length is reset and never ended") { w in
        let client = try w.connect()
        client.send(w.gated("POST", "/x", "Content-Length: 10\r\n") + "abc")
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        client.shutdownOutput()
        let reset = w.peer.resets.poll(timeoutMs: 2000)
        expect(reset?.code == TunnelFrame.RESET_BAD_REQUEST && reset?.stream == open.stream, "bad request reset")
        expect(w.peer.ended.poll(timeoutMs: 100) == nil, "never ended")
    }

    run("upload stops at the window") { w in
        w.peer.credit.value = 0
        let body = [UInt8](repeating: 0, count: 400_000)
        let client = try w.connect()
        client.send(w.gated("POST", "/x", "Content-Length: \(body.count)\r\n"))
        Thread.detachNewThread { client.send(body) }
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        Thread.sleep(forTimeInterval: 0.5)
        expect(w.peer.dataBytes.value == TunnelFrame.MAX_WINDOW, "stops at 256 KiB: \(w.peer.dataBytes.value)")
        w.peer.reply(TunnelFrame.window(stream: open.stream, increment: 1000))
        Thread.sleep(forTimeInterval: 0.2)
        expect(w.peer.dataBytes.value == TunnelFrame.MAX_WINDOW + 1000, "1000 more")
    }

    run("streaming responses are not buffered") { w in
        // SSE: bytes reach the page as they arrive, with the stream still open.
        let client = try w.connect()
        client.send(w.gated("GET", "/events", "Accept: text/event-stream\r\n"))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 200, "content-type", "text/event-stream")
        expect(client.readHead().contains("transfer-encoding: chunked"), "chunked")
        for event in ["data: 1\n\n", "data: 2\n\n"] {
            w.peer.data(open.stream, Bytes.utf8(event))
            expect(text(try client.read(max: 64)).contains(event), "event arrives at once")
        }
    }

    run("credit follows the consumer, so a stalled page stalls the sender") { w in
        let client = try w.connect()
        client.setReceiveBuffer(1024)
        client.send(w.gated("GET", "/big", ""))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 200)
        // Nothing reads the socket: past the window a sender is reset, never buffered without bound.
        var reset: TunnelFrame?
        for _ in 0..<40 {
            w.peer.data(open.stream, [UInt8](repeating: 0, count: 60000))
            reset = w.peer.resets.poll(timeoutMs: 5)
            if reset != nil { break }
        }
        if reset == nil { reset = w.peer.resets.poll(timeoutMs: 3000) }
        expect(reset?.code == TunnelFrame.RESET_FLOW_CONTROL, "flow-control reset")
    }

    run("a reset before head is 502, and too many streams is 503") { w in
        let first = try w.connect()
        first.send(w.gated("GET", "/a", ""))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.reply(TunnelFrame.reset(stream: open.stream, code: TunnelFrame.RESET_INTERNAL))
        expect(first.readHead().hasPrefix("HTTP/1.1 502"), "502")
        let second = try w.connect()
        second.send(w.gated("GET", "/b", ""))
        guard let next = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.reply(TunnelFrame.reset(stream: next.stream, code: TunnelFrame.RESET_TOO_MANY_STREAMS))
        let head = second.readHead()
        expect(head.hasPrefix("HTTP/1.1 503") && head.contains("retry-after: 1"), "503 retry-after")
    }

    run("a lost session before head is 502, and after head aborts the read") { w in
        let waiting = try w.connect()
        waiting.send(w.gated("POST", "/approve", "Content-Length: 0\r\n"))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        let streaming = try w.connect()
        streaming.send(w.gated("GET", "/events", ""))
        guard let events = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        expect(open.stream != events.stream, "two streams")
        w.peer.head(events.stream, 200, "content-type", "text/event-stream")
        _ = streaming.readHead()
        w.session.end()
        expect(waiting.readHead().hasPrefix("HTTP/1.1 502"), "502")
        expect(try streaming.read() == -1, "aborted")
        expect(w.peer.opened.poll(timeoutMs: 200) == nil, "a write is never retried")
    }

    run("a reset after END does not abort a complete response") { w in
        // A complete early answer, such as a 413, survives the RESET that follows cezar's END (§ 13.2).
        let client = try w.connect()
        client.send(w.gated("POST", "/x", "Content-Length: 5\r\n") + "abc")
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 413, "content-length", "2")
        w.peer.data(open.stream, Bytes.ascii("no"))
        w.peer.reply(TunnelFrame.end(stream: open.stream))
        w.peer.reply(TunnelFrame.reset(stream: open.stream, code: TunnelFrame.RESET_CANCELLED))
        client.send("de")
        expect(client.readHead().hasPrefix("HTTP/1.1 413"), "413")
        expect(try client.read() == 0x6e && client.read() == 0x6f, "body")
    }

    run("no session is 503") { w in
        w.sessionUp.value = false
        let client = try w.connect()
        client.send(w.gated("GET", "/", ""))
        let head = client.readHead()
        expect(head.hasPrefix("HTTP/1.1 503") && head.contains("retry-after: 1"), "503")
    }

    run("in the background the port stays bound and answers 503") { w in
        let streaming = try w.connect()
        streaming.send(w.gated("GET", "/events", ""))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 200)
        _ = streaming.readHead()
        w.proxy.setServing(false)
        expect(try streaming.read() == -1, "live streams die")
        let client = try w.connect()
        client.send(w.gated("GET", "/", ""))
        expect(client.readHead().hasPrefix("HTTP/1.1 503"), "503")
        expect(w.peer.opened.poll(timeoutMs: 100) == nil, "nothing opened")
        w.proxy.setServing(true)
        let back = try w.connect()
        back.send(w.gated("GET", "/", ""))
        expect(w.peer.opened.poll(timeoutMs: 2000)?.method == "GET", "served again")
    }

    run("a taken port gets a new port and a new cookie") { w in
        let hog = try LoopbackHog()
        defer { hog.close() }
        let second = LoopbackProxy(tunnel: { w.session }, userAgent: "ua")
        let port = try second.open(preferredPort: hog.port)
        expect(second.rebound() && port != hog.port, "rebound")
        expect(second.cookieValue() != w.proxy.cookieValue(), "new cookie")
        second.close()
    }

    run("a free saved port is kept") { w in
        let hog = try LoopbackHog()
        let port = hog.port
        hog.close()
        let second = LoopbackProxy(tunnel: { w.session }, userAgent: "ua")
        expect(try second.open(preferredPort: port) == port && !second.rebound(), "kept")
        expect(second.listening(), "listening")
        second.close()
        expect(!second.listening(), "not listening after close")
        expect(!LoopbackClient.canConnect(port: port), "closed on close()")
    }

    run("HEAD and no-content have no body") { w in
        let client = try w.connect()
        client.send(w.gated("HEAD", "/x", ""))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 200, "content-length", "100")
        w.peer.reply(TunnelFrame.end(stream: open.stream))
        expect(client.readHead().contains("content-length: 100"), "HEAD keeps the length")
        client.send(w.gated("GET", "/y", ""))
        guard let next = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("keep-alive lost") }
        w.peer.head(next.stream, 204)
        w.peer.reply(TunnelFrame.end(stream: next.stream))
        let head = client.readHead()
        expect(head.hasPrefix("HTTP/1.1 204") && !head.contains("transfer-encoding"), "204, not chunked")
    }

    run("a client that leaves gives its stream back") { w in
        let client = try w.connect()
        client.send(w.gated("GET", "/events", ""))
        guard let open = w.peer.opened.poll(timeoutMs: 2000) else { throw RelayIOError("not opened") }
        w.peer.head(open.stream, 200)
        _ = client.readHead()
        client.close()
        w.clients.removeAll { $0 === client }
        let reset = w.peer.resets.poll(timeoutMs: 4000)
        expect(reset?.stream == open.stream && reset?.code == TunnelFrame.RESET_CANCELLED, "cancelled")
    }

    run("a frame for a stream never opened ends the session") { w in
        w.peer.reply(TunnelFrame.window(stream: 1, increment: 1))
        expect(!w.session.live(), "ended")
    }

    run("thirty-three streams are refused locally") { w in
        for i in 0..<TunnelSession.MAX_STREAMS { _ = try w.session.open(method: "GET", target: "/\(i)", headers: []) }
        let client = try w.connect()
        client.send(w.gated("GET", "/x", ""))
        expect(client.readHead().hasPrefix("HTTP/1.1 503"), "503")
    }

    run("nothing answers an unfinished head") { w in
        let client = try w.connect()
        client.setTimeout(300)
        client.send("GET / HTTP/1.1\r\n")
        expect(throwsError { _ = try client.read() }, "times out")
    }

    run("a header name that cannot fit is refused") { w in
        try w.refused(w.gated("GET", "/x", String(repeating: "X", count: 256) + ": 1\r\n"), "431")
    }

    test("the gate cookie is host-only, HttpOnly and SameSite=Strict") {
        let proxy = LoopbackProxy(tunnel: { nil }, userAgent: "ua")
        let cookie = proxy.gateCookie()
        expect(cookie?.name == LoopbackProxy.COOKIE && cookie?.value == proxy.cookieValue() && cookie?.domain == "127.0.0.1", "name, value, host")
        expect(cookie?.isHTTPOnly == true && cookie?.sameSitePolicy == .sameSiteStrict && cookie?.isSecure == false && cookie?.path == "/", "flags")
        expect(proxy.cookieValue().count == 64 && Bytes.fromHex(proxy.cookieValue()) != nil, "32 random bytes, hex")
    }
}
