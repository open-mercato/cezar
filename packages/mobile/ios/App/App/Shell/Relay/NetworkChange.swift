import Foundation
import Network

/// What a change of network path means for the relay socket. Pure, so it is tested on its own.
enum NetworkChange {
    enum Action: Equatable { case none, probe, reconnect }

    /// A path as the decision sees it: whether it can carry traffic, and its interfaces, preferred first.
    struct Path: Equatable {
        let satisfied: Bool
        let interfaces: [String]
    }

    /// Back from no network, or the interface the socket most likely used went away: that socket is dead,
    /// so a new one now beats waiting for the pong. Only an added interface: the socket may live, ask it.
    static func decide(_ before: Path?, _ after: Path) -> Action {
        // The first update only describes where the watch started.
        guard let before, after.satisfied else { return .none }
        if !before.satisfied { return .reconnect }
        if let primary = before.interfaces.first, !after.interfaces.contains(primary) { return .reconnect }
        return before.interfaces == after.interfaces ? .none : .probe
    }

    /// The interface kinds for the startup log: never a name or an address.
    static func kinds(_ path: NWPath) -> String {
        let kinds = path.availableInterfaces.map { interface -> String in
            switch interface.type {
            case .wifi: return "wifi"
            case .cellular: return "cellular"
            case .wiredEthernet: return "wired"
            case .loopback: return "loopback"
            default: return "other"
            }
        }
        return kinds.isEmpty ? "none" : kinds.joined(separator: "+")
    }
}

/// NWPathMonitor for one server view. Changes arrive on its own queue.
final class NetworkWatch {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "cezar-network-watch")
    private var last: NetworkChange.Path?
    private let satisfied = Locked(true)

    /// Whether the phone has a usable path now; true until the first update says otherwise.
    var up: Bool { satisfied.value }

    init(onChange: @escaping (NetworkChange.Action, String) -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let next = NetworkChange.Path(satisfied: path.status == .satisfied, interfaces: path.availableInterfaces.map(\.name))
            let previous = self.last
            self.last = next
            self.satisfied.value = next.satisfied
            // A loss is told too, with nothing to do: the startup log shows when the network went.
            if let previous, previous != next {
                onChange(NetworkChange.decide(previous, next), (next.satisfied ? "up " : "down ") + NetworkChange.kinds(path))
            }
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        monitor.cancel()
    }
}
