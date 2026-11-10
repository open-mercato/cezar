import Foundation

/// One pairing at a time, for a connect page that polls. A snapshot sequence number stands in for events.
final class PairingFlow {
    /// What the page reads.
    struct Snapshot {
        let seq: Int
        let phase: PairingClient.Phase
        let digits: String?
        let label: String?
        let reason: String?
    }

    /// Called once with what approval gave; returns when the server is saved. Throws when it cannot save.
    typealias Saver = (RelayOrigin, PairingClient.State, DeviceKeys) throws -> Void

    private let transport: SocketTransport
    private let phoneName: String?
    private let debugBuild: Bool
    private let saver: Saver
    private let monitor = NSCondition()
    private var client: PairingClient?
    private var seq = 0
    /// Which pairing is current: a replaced client still reports its own end.
    private var generation = 0
    private var latest = Snapshot(seq: 0, phase: .failed, digits: nil, label: nil, reason: "cancelled")

    init(transport: SocketTransport, phoneName: String?, debugBuild: Bool, saver: @escaping Saver) {
        self.transport = transport
        self.phoneName = phoneName
        self.debugBuild = debugBuild
        self.saver = saver
    }

    func startQr(_ text: String?) -> Snapshot {
        do {
            return start(try PairSecret.fromQr((text ?? "").trimmingCharacters(in: .whitespacesAndNewlines), debugBuild: debugBuild))
        } catch let refused as RelayOrigin.Refused {
            return self.refused(Self.qrRefusal(refused.reason))
        } catch {
            return self.refused("qr-invalid")
        }
    }

    private static func qrRefusal(_ reason: String) -> String {
        switch reason {
        case "version": return "update-app"
        case "old-link": return "update-cezar"
        case "cleartext": return "qr-cleartext"
        default: return "qr-invalid"
        }
    }

    /// Runs PBKDF2, so never on the main thread.
    func startCode(_ code: String?, relayAddress: String?) -> Snapshot {
        let relay: RelayOrigin
        do {
            relay = try RelayOrigin.parseTypedOrDefault(relayAddress, debugBuild: debugBuild)
        } catch {
            return refused((error as? RelayOrigin.Refused)?.reason == "cleartext" ? "relay-cleartext" : "relay-invalid")
        }
        guard let secret = try? PairSecret.fromCode(code, relay: relay) else { return refused("code-invalid") }
        return start(secret)
    }

    private func refused(_ reason: String) -> Snapshot {
        monitor.lock()
        defer { monitor.unlock() }
        return publish(.failed, nil, nil, reason)
    }

    private func start(_ secret: PairSecret) -> Snapshot {
        monitor.lock()
        client?.cancel()
        let keys = DeviceKeys.generate()
        generation += 1
        let mine = generation
        let next = PairingClient(transport: transport, secret: secret, keys: keys, phoneName: phoneName) { [weak self] state in
            self?.update(mine, secret, keys, state)
        }
        client = next
        let snapshot = publish(.connecting, nil, nil, nil)
        monitor.unlock()
        next.start()
        return snapshot
    }

    private func update(_ mine: Int, _ secret: PairSecret, _ keys: DeviceKeys, _ state: PairingClient.State) {
        monitor.lock()
        let current = mine == generation
        monitor.unlock()
        if !current { return }
        var saved = true
        // Saved before the page hears of it, so a poll that reads APPROVED finds the server.
        if state.phase == .approved {
            do {
                try saver(secret.relay, state, keys)
            } catch {
                saved = false
            }
        }
        monitor.lock()
        defer { monitor.unlock() }
        if mine != generation { return }
        if saved {
            _ = publish(state.phase, state.digits, state.label, state.reason)
        } else {
            _ = publish(.failed, nil, nil, "internal")
        }
    }

    /// Under the monitor.
    private func publish(_ phase: PairingClient.Phase, _ digits: String?, _ label: String?, _ reason: String?) -> Snapshot {
        seq += 1
        latest = Snapshot(seq: seq, phase: phase, digits: digits, label: label, reason: reason)
        monitor.broadcast()
        return latest
    }

    func cancel() {
        monitor.lock()
        let current = client
        monitor.unlock()
        current?.cancel()
    }

    /// Blocks until the sequence moves past `seen`, or after `timeoutMs` with the same snapshot.
    func next(seen: Int, timeoutMs: Int64) -> Snapshot {
        let deadline = Date(timeIntervalSinceNow: Double(timeoutMs) / 1000)
        monitor.lock()
        defer { monitor.unlock() }
        while latest.seq <= seen {
            if !monitor.wait(until: deadline) { break }
        }
        return latest
    }
}
