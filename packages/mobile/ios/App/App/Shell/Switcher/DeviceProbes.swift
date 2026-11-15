import Foundation

/// The switcher's probes while its sheet is open: one per server not on screen, bounded, each warming the
/// link a switch will take. Every report arrives through `onChange`, from any thread.
final class DeviceProbes {
    /// Starts a probe. It may report more than once (a link's status moves on); it must not block.
    typealias Probe = (ServerRecord, @escaping (DeviceSwitch.Status) -> Void) -> Void
    typealias Scheduler = (_ afterMs: Int, _ work: @escaping () -> Void) -> Void

    static let boundMs = 6000

    private let relay: Probe
    private let direct: Probe
    private let release: (ServerRecord) -> Void
    private let schedule: Scheduler
    private let onChange: (String, DeviceSwitch.Status) -> Void
    private let lock = NSLock()
    private var statuses: [String: DeviceSwitch.Status] = [:]
    private var probed: [ServerRecord] = []
    private var stopped = false

    /// `release` lets go of what a probe opened, as the sheet closes.
    init(relay: @escaping Probe, direct: @escaping Probe, release: @escaping (ServerRecord) -> Void,
         schedule: @escaping Scheduler = DeviceProbes.background, onChange: @escaping (String, DeviceSwitch.Status) -> Void) {
        self.relay = relay
        self.direct = direct
        self.release = release
        self.schedule = schedule
        self.onChange = onChange
    }

    static func background(_ afterMs: Int, _ work: @escaping () -> Void) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(afterMs), execute: work)
    }

    func start(_ servers: [ServerRecord], currentId: String?) {
        let others = servers.filter { $0.id != currentId }
        lock.lock()
        probed = others
        for server in others { statuses[server.id] = .checking }
        lock.unlock()
        for server in others {
            let report: (DeviceSwitch.Status) -> Void = { [weak self] status in self?.update(server.id, status) }
            (server.relay != nil ? relay : direct)(server, report)
        }
        // Not known by the bound reads offline; a later report still turns the dot.
        schedule(Self.boundMs) { [weak self] in
            guard let self else { return }
            for server in others where self.current(server.id) == .checking { self.update(server.id, .offline, timedOut: true) }
        }
    }

    func status(_ id: String) -> DeviceSwitch.Status? {
        current(id)
    }

    func snapshot() -> [String: DeviceSwitch.Status] {
        lock.lock()
        defer { lock.unlock() }
        return statuses
    }

    /// The sheet closed. `keep` is the switch's target: its link is about to be the current one.
    func stop(keep: String? = nil) {
        lock.lock()
        guard !stopped else {
            lock.unlock()
            return
        }
        stopped = true
        let servers = probed
        lock.unlock()
        for server in servers where server.id != keep { release(server) }
    }

    private func current(_ id: String) -> DeviceSwitch.Status? {
        lock.lock()
        defer { lock.unlock() }
        return statuses[id]
    }

    private func update(_ id: String, _ status: DeviceSwitch.Status, timedOut: Bool = false) {
        lock.lock()
        // A link still connecting after the bound stays offline until it says otherwise.
        let unchanged = statuses[id] == status || (status == .checking && statuses[id] == .offline)
        guard !stopped, statuses[id] != nil, !unchanged, !timedOut || statuses[id] == .checking else {
            lock.unlock()
            return
        }
        statuses[id] = status
        lock.unlock()
        onChange(id, status)
    }
}

extension DeviceProbes {
    /// Through the switcher's own link, which a switch then adopts: the probe is the warm-up. No keys reads as removed.
    static func relayProbe(_ relay: RelayConnections) -> Probe {
        { server, report in
            DispatchQueue.global(qos: .utility).async {
                guard let link = relay.warm(server) else {
                    report(.blocked)
                    return
                }
                if relay.warming(server.id) { link.setListener { report(DeviceSwitch.status($0.kind)) } }
                link.start()
                report(DeviceSwitch.status(link.status().kind))
            }
        }
    }

    /// A direct server's health, with its saved password and the cookies `cookies` reads.
    static func directProbe(_ connector: ShellConnector, cookies: @escaping (ServerRecord) async -> String?) -> Probe {
        { server, report in
            Task {
                guard let health = await connector.health(server.id, cookies: await cookies(server)) else { return }
                report(DeviceSwitch.status(health.kind))
            }
        }
    }
}
