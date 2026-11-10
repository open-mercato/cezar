import Foundation

/// The WebSocket seam, so the relay state machines run on macOS against a fake.
protocol SocketTransport: AnyObject {
    func connect(url: String, headers: [(String, String)], events: SocketEvents) -> SocketConnection
}

protocol SocketEvents: AnyObject {
    func opened()
    func text(_ text: String)
    func binary(_ bytes: [UInt8])
    func closed(_ code: Int)
    /// No socket: `status` is the HTTP refusal, 0 for a network failure. Negative values mean unknown.
    func failed(status: Int, code: String?, retryAfterSeconds: Int64, dateMillis: Int64)
}

protocol SocketConnection: AnyObject {
    @discardableResult func sendText(_ text: String) -> Bool
    @discardableResult func sendBinary(_ bytes: [UInt8]) -> Bool
    func close(_ code: Int)
}
