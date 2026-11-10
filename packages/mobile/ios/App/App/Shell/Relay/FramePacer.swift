import Foundation

/// The relay counts frames per room, both directions, and closes the sender with 4429 past
/// `framesPerSecond` (RELAY_PROTOCOL.md § 12.2). cezar paces itself to 40%; the phone takes the same share.
final class FramePacer {
    typealias Sleeper = (Int64) -> Void

    private static let shareOfFrames = 0.4

    private let spacingMs: Double
    private let clock: () -> Int64
    private let sleeper: Sleeper
    private let lock = NSLock()
    private var nextAt = 0.0

    init(framesPerSecond: Int, clock: @escaping () -> Int64, sleeper: @escaping Sleeper = { Thread.sleep(forTimeInterval: Double($0) / 1000) }) {
        spacingMs = 1000.0 / max(1.0, Double(framesPerSecond) * Self.shareOfFrames)
        self.clock = clock
        self.sleeper = sleeper
    }

    /// Takes the next slot under the lock and waits outside it, so streams do not queue on each other.
    func await() {
        lock.lock()
        let now = Double(clock())
        let at = max(now, nextAt)
        nextAt = at + spacingMs
        let waitMs = Int64((at - now).rounded(.up))
        lock.unlock()
        if waitMs > 0 { sleeper(waitMs) }
    }
}
