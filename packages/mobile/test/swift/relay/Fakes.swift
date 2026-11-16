import Foundation

/// One fake socket: what the code under test sent, and the events it was given to call.
final class FakeSocket: SocketConnection {
    let url: String
    let headers: [(String, String)]
    let events: SocketEvents
    let binary = BlockingQueue<[UInt8]>()
    let closes = BlockingQueue<Int>()
    let texts = BlockingQueue<String>()

    init(url: String, headers: [(String, String)], events: SocketEvents) {
        self.url = url
        self.headers = headers
        self.events = events
    }

    func header(_ name: String) -> String? { headers.first { $0.0 == name }?.1 }

    func sendText(_ text: String) -> Bool {
        texts.add(text)
        return true
    }

    func sendBinary(_ bytes: [UInt8]) -> Bool {
        binary.add(bytes)
        return true
    }

    func close(_ code: Int) { closes.add(code) }
}

final class FakeTransport: SocketTransport {
    let sockets = BlockingQueue<FakeSocket>()
    private let lock = NSLock()
    private var all: [FakeSocket] = []

    func connect(url: String, headers: [(String, String)], events: SocketEvents) -> SocketConnection {
        let socket = FakeSocket(url: url, headers: headers, events: events)
        lock.lock()
        all.append(socket)
        lock.unlock()
        sockets.add(socket)
        return socket
    }

    var last: FakeSocket? {
        lock.lock()
        defer { lock.unlock() }
        return all.last
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return all.count
    }
}

/// Drops every frame: a socket that never answers.
final class SilentTransport: SocketTransport {
    final class Silent: SocketConnection {
        func sendText(_ text: String) -> Bool { true }
        func sendBinary(_ bytes: [UInt8]) -> Bool { true }
        func close(_ code: Int) {}
    }

    func connect(url: String, headers: [(String, String)], events: SocketEvents) -> SocketConnection { Silent() }
}
