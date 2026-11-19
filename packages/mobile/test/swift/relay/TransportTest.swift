import CryptoKit
import Foundation

/// URLSessionTransport against a real loopback server: the upgrade it sends, close codes, a refused upgrade.
func transportTests() {
    /// Accepts one connection and runs `script` on it.
    final class Server {
        let hog: LoopbackHog
        init() throws { hog = try LoopbackHog() }

        func accept(_ script: @escaping (Int32) -> Void) {
            Thread.detachNewThread { [hog] in
                let fd = Darwin.accept(hog.fd, nil, nil)
                guard fd >= 0 else { return }
                var no = Int32(1)
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no, socklen_t(MemoryLayout<Int32>.size))
                script(fd)
                Darwin.close(fd)
            }
        }

        static func readHead(_ fd: Int32) -> String {
            var out: [UInt8] = []
            var byte: UInt8 = 0
            while !(out.count >= 4 && Array(out.suffix(4)) == [13, 10, 13, 10]), recv(fd, &byte, 1, 0) == 1 { out.append(byte) }
            return Latin1.decode(out)
        }

        static func write(_ fd: Int32, _ bytes: [UInt8]) { _ = bytes.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) } }
    }

    final class Recorder: SocketEvents {
        let log = BlockingQueue<String>()
        func opened() { log.add("opened") }
        func text(_ text: String) { log.add("text:" + text) }
        func binary(_ bytes: [UInt8]) { log.add("binary:" + Bytes.hex(bytes)) }
        func closed(_ code: Int) { log.add("closed:\(code)") }
        func failed(status: Int, code: String?, retryAfterSeconds: Int64, dateMillis: Int64) {
            log.add("failed:\(status):\(code ?? "-"):\(retryAfterSeconds):\(dateMillis > 0)")
        }
    }

    test("the upgrade carries our headers and offers no compression; close codes keep their value") {
        let server = try Server()
        let head = Locked("")
        let sent = BlockingQueue<[UInt8]>()
        server.accept { fd in
            let request = Server.readHead(fd)
            head.value = request.lowercased()
            let key = request.split(separator: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
                .split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces) ?? ""
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            Server.write(fd, Bytes.ascii("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"))
            Server.write(fd, [0x81, 0x05] + Bytes.ascii("hello"))
            Server.write(fd, [0x82, 0x02, 0x01, 0x02])
            // One masked binary frame from the client, read back.
            var header = [UInt8](repeating: 0, count: 2)
            if recv(fd, &header, 2, MSG_WAITALL) == 2 {
                let length = Int(header[1] & 0x7f)
                var rest = [UInt8](repeating: 0, count: 4 + length)
                if recv(fd, &rest, rest.count, MSG_WAITALL) == rest.count {
                    sent.add((0..<length).map { rest[4 + $0] ^ rest[$0 % 4] })
                }
            }
            Server.write(fd, [0x88, 0x02, 0x11, 0x33]) // close 4403
            Thread.sleep(forTimeInterval: 0.5)
        }
        let events = Recorder()
        let connection = URLSessionTransport().connect(url: "ws://127.0.0.1:\(server.hog.port)/v1/x", headers: [("X-Test", "1")], events: events)
        let first = events.log.poll(timeoutMs: 5000)
        if first != "opened" { print("transport: upgrade head was\n\(head.value)\nfirst event \(first ?? "none")") }
        expect(first == "opened", "opened")
        expect(head.value.contains("upgrade: websocket") && head.value.contains("x-test: 1"), "upgrade with our header")
        expect(!head.value.contains("permessage-deflate"), "no permessage-deflate offered (§ 3)")
        expect(events.log.poll(timeoutMs: 2000) == "text:hello", "text frame")
        expect(events.log.poll(timeoutMs: 2000) == "binary:0102", "binary frame")
        expect(connection.sendBinary([9, 8, 7]), "send accepted")
        expect(sent.poll(timeoutMs: 2000) == [9, 8, 7], "server got our frame")
        expect(events.log.poll(timeoutMs: 3000) == "closed:4403", "4403 keeps its code")
        server.hog.close()
    }

    test("a server that accepts compression anyway is refused") {
        let server = try Server()
        server.accept { fd in
            let request = Server.readHead(fd)
            let key = request.split(separator: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
                .split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces) ?? ""
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            Server.write(fd, Bytes.ascii("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n"
                + "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n"))
            Thread.sleep(forTimeInterval: 0.5)
        }
        let events = Recorder()
        _ = URLSessionTransport().connect(url: "ws://127.0.0.1:\(server.hog.port)/v1/x", headers: [], events: events)
        let line = events.log.poll(timeoutMs: 5000)
        expect(line?.hasPrefix("failed:0:") == true, "never opened: \(line ?? "none")")
        server.hog.close()
    }

    test("a refused upgrade reports its status, Retry-After and Date") {
        let server = try Server()
        server.accept { fd in
            _ = Server.readHead(fd)
            Server.write(fd, Bytes.ascii("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nDate: Tue, 10 Nov 2026 12:00:00 GMT\r\n"
                + "Content-Type: application/json\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{\"code\":\"rate-limited-xx\"}"))
        }
        let events = Recorder()
        _ = URLSessionTransport().connect(url: "ws://127.0.0.1:\(server.hog.port)/v1/x", headers: [], events: events)
        let line = events.log.poll(timeoutMs: 5000) ?? "none"
        print("transport: a refused upgrade reads as \(line)")
        expect(line == "failed:429:-:30:true", "status, no body code, retry-after, date: \(line)")
        server.hog.close()
    }

    test("no listener is a network failure") {
        let hog = try LoopbackHog()
        let port = hog.port
        hog.close()
        let events = Recorder()
        _ = URLSessionTransport().connect(url: "ws://127.0.0.1:\(port)/v1/x", headers: [], events: events)
        expect(events.log.poll(timeoutMs: 12000)?.hasPrefix("failed:0:") == true, "status 0")
    }
}
