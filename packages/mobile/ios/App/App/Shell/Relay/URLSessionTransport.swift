import Foundation

/// URLSessionWebSocketTask in place of Android's OkHttp. It cannot read a refused upgrade's JSON body,
/// so `code` is always nil and a 503 `relay-disabled` waits by `Retry-After` or jitter rather than the
/// kill-switch delay; and it cannot drop the `permessage-deflate` offer it adds, only blank it (§ 3).
final class URLSessionTransport: SocketTransport {
    func connect(url: String, headers: [(String, String)], events: SocketEvents) -> SocketConnection {
        let connection = Connection(events: events)
        connection.start(url: url, headers: headers)
        return connection
    }

    private final class Connection: NSObject, SocketConnection, URLSessionWebSocketDelegate {
        private static let CONNECT_TIMEOUT_SECONDS = 10.0
        /// OkHttp's own cap: past it `send` says no and the caller treats the socket as gone.
        private static let MAX_QUEUED_BYTES = 16 * 1024 * 1024

        private let events: SocketEvents
        private let lock = NSLock()
        private var session: URLSession?
        private var task: URLSessionWebSocketTask?
        private var opened = false
        private var done = false
        private var queuedBytes = 0

        init(events: SocketEvents) {
            self.events = events
        }

        func start(url: String, headers: [(String, String)]) {
            guard let target = URL(string: url), target.scheme == "wss" || target.scheme == "ws" else {
                finish { $0.failed(status: 0, code: nil, retryAfterSeconds: -1, dateMillis: -1) }
                return
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCredentialStorage = nil
            configuration.urlCache = nil
            // Over the 45 s ping and its 15 s pong wait; the connect deadline below is the real one.
            configuration.timeoutIntervalForRequest = 75
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
            var request = URLRequest(url: target)
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            // URLSession offers `permessage-deflate` unasked; an empty value replaces the offer (§ 3).
            request.setValue("", forHTTPHeaderField: "Sec-WebSocket-Extensions")
            let task = session.webSocketTask(with: request)
            lock.lock()
            self.session = session
            self.task = task
            lock.unlock()
            task.resume()
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.CONNECT_TIMEOUT_SECONDS) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let stuck = !self.opened && !self.done
                self.lock.unlock()
                if stuck { self.finish { $0.failed(status: 0, code: nil, retryAfterSeconds: -1, dateMillis: -1) } }
            }
        }

        /// Reports once, then lets the session go: a URLSession holds its delegate until invalidated.
        private func finish(_ report: ((SocketEvents) -> Void)?, closeCode: Int = 1000) {
            lock.lock()
            if done {
                lock.unlock()
                return
            }
            done = true
            let task = self.task
            let session = self.session
            lock.unlock()
            task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: closeCode) ?? .normalClosure, reason: nil)
            session?.finishTasksAndInvalidate()
            report?(events)
        }

        private func receive() {
            lock.lock()
            let task = self.task
            lock.unlock()
            task?.receive { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(.string(let text)):
                    self.events.text(text)
                    self.receive()
                case .success(.data(let data)):
                    self.events.binary([UInt8](data))
                    self.receive()
                case .success:
                    self.receive()
                case .failure:
                    // The close frame, if any, arrives through didCloseWith or didCompleteWithError.
                    break
                }
            }
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            lock.lock()
            opened = true
            let gone = done
            lock.unlock()
            if gone { return }
            // § 3: a client that cannot stop its library offering compression MUST NOT accept it.
            let accepted = (webSocketTask.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Sec-WebSocket-Extensions") ?? ""
            if !accepted.trimmingCharacters(in: .whitespaces).isEmpty {
                finish({ $0.failed(status: 0, code: nil, retryAfterSeconds: -1, dateMillis: -1) }, closeCode: 1010)
                return
            }
            events.opened()
            receive()
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                        reason: Data?) {
            // Custom codes such as 4403 keep their raw value: the enum is an open NS_ENUM.
            let code = closeCode.rawValue
            finish({ $0.closed(code) })
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let wasOpen = opened
            lock.unlock()
            if wasOpen {
                let code = (task as? URLSessionWebSocketTask)?.closeCode.rawValue ?? 0
                finish({ $0.closed(code == 0 ? 1006 : code) })
                return
            }
            // A refused upgrade: URLSession keeps its response, though not its body.
            guard let response = task.response as? HTTPURLResponse else {
                finish { $0.failed(status: 0, code: nil, retryAfterSeconds: -1, dateMillis: -1) }
                return
            }
            let retryAfter = Self.retryAfter(response.value(forHTTPHeaderField: "Retry-After"))
            let date = Self.date(response.value(forHTTPHeaderField: "Date"))
            finish { $0.failed(status: response.statusCode, code: nil, retryAfterSeconds: retryAfter, dateMillis: date) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }

        static func retryAfter(_ value: String?) -> Int64 {
            guard let value, RelayRegex.matches("[0-9]{1,9}", value) else { return -1 }
            return Int64(value) ?? -1
        }

        static func date(_ value: String?) -> Int64 {
            guard let value else { return -1 }
            let format = DateFormatter()
            format.locale = Locale(identifier: "en_US_POSIX")
            format.timeZone = TimeZone(identifier: "GMT")
            format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            guard let parsed = format.date(from: value) else { return -1 }
            return Int64(parsed.timeIntervalSince1970 * 1000)
        }

        func sendText(_ text: String) -> Bool { send(.string(text), bytes: text.utf8.count) }

        func sendBinary(_ bytes: [UInt8]) -> Bool { send(.data(Data(bytes)), bytes: bytes.count) }

        private func send(_ message: URLSessionWebSocketTask.Message, bytes: Int) -> Bool {
            lock.lock()
            guard !done, let task, queuedBytes + bytes <= Self.MAX_QUEUED_BYTES else {
                lock.unlock()
                return false
            }
            queuedBytes += bytes
            lock.unlock()
            // Sends on one task go out in call order; the session's lock is what orders the calls (§ 10).
            task.send(message) { [weak self] error in
                guard let self else { return }
                self.lock.lock()
                self.queuedBytes -= bytes
                self.lock.unlock()
                if error != nil { self.finish({ $0.closed(1006) }) }
            }
            return true
        }

        func close(_ code: Int) {
            finish(nil, closeCode: code)
        }
    }
}
