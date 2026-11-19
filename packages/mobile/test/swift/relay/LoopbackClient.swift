import Foundation

/// A plain BSD socket client, Java's `Socket` in the proxy tests: the page side of the loopback.
final class LoopbackClient {
    struct Timeout: Error {}

    let fd: Int32

    init(port: Int, timeoutMs: Int = 5000) throws {
        fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw RelayIOError("socket") }
        var no = Int32(1)
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard result == 0 else {
            Darwin.close(fd)
            throw RelayIOError("connect refused")
        }
        setTimeout(timeoutMs)
    }

    static func canConnect(port: Int) -> Bool {
        guard let client = try? LoopbackClient(port: port) else { return false }
        client.close()
        return true
    }

    func setTimeout(_ ms: Int) {
        var time = timeval(tv_sec: ms / 1000, tv_usec: Int32((ms % 1000) * 1000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
    }

    func setReceiveBuffer(_ bytes: Int32) {
        var size = bytes
        setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    }

    func send(_ text: String) { send(Latin1.encode(text)) }

    func send(_ bytes: [UInt8]) {
        var at = 0
        while at < bytes.count {
            let sent = bytes[at...].withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
            if sent <= 0 { return }
            at += sent
        }
    }

    /// One byte, -1 at the end; throws on the read timeout.
    func read() throws -> Int {
        var byte: UInt8 = 0
        let count = Darwin.recv(fd, &byte, 1, 0)
        if count == 1 { return Int(byte) }
        if count == 0 { return -1 }
        if errno == EAGAIN || errno == EWOULDBLOCK { throw Timeout() }
        return -1
    }

    func read(max: Int) throws -> [UInt8] {
        var buffer = [UInt8](repeating: 0, count: max)
        let count = Darwin.recv(fd, &buffer, max, 0)
        if count > 0 { return Array(buffer[0..<count]) }
        if count == 0 { return [] }
        if errno == EAGAIN || errno == EWOULDBLOCK { throw Timeout() }
        return []
    }

    func readHead() -> String {
        var out: [UInt8] = []
        while !(out.count >= 4 && Array(out.suffix(4)) == [13, 10, 13, 10]) {
            guard let b = try? read(), b >= 0 else { break }
            out.append(UInt8(b))
        }
        return Latin1.decode(out)
    }

    func shutdownOutput() { Darwin.shutdown(fd, SHUT_WR) }

    func close() { Darwin.close(fd) }
}

/// Binds a loopback port the way a hostile app would, to take a saved one.
final class LoopbackHog {
    let fd: Int32
    let port: Int

    init() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        self.fd = fd
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 1) == 0 else { throw RelayIOError("bind") }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        port = Int(UInt16(bigEndian: actual.sin_port))
    }

    func close() { Darwin.close(fd) }
}
