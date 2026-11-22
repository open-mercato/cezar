import Foundation

/// The switcher's probes while its sheet is open: one per server, bounded, each warming the link a switch
/// will take and reading the computer's counts over its own connection. The server on screen is read for
/// its counts only. Every report arrives through `onChange`, from any thread.
final class DeviceProbes {
    /// Starts a probe. It may report more than once (a link's status moves on); it must not block.
    typealias Probe = (ServerRecord, @escaping (DeviceSwitch.Reading) -> Void) -> Void
    typealias Scheduler = (_ afterMs: Int, _ work: @escaping () -> Void) -> Void

    static let boundMs = 6000

    private let relay: Probe
    private let direct: Probe
    private let release: (ServerRecord) -> Void
    private let schedule: Scheduler
    private let onChange: (String, DeviceSwitch.Reading) -> Void
    private let lock = NSLock()
    private var statuses: [String: DeviceSwitch.Reading] = [:]
    private var probed: [ServerRecord] = []
    private var stopped = false

    /// `release` lets go of what a probe opened, as the sheet closes.
    init(relay: @escaping Probe, direct: @escaping Probe, release: @escaping (ServerRecord) -> Void,
         schedule: @escaping Scheduler = DeviceProbes.background, onChange: @escaping (String, DeviceSwitch.Reading) -> Void) {
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
        lock.lock()
        probed = servers.filter { $0.id != currentId }
        for server in servers { statuses[server.id] = DeviceSwitch.Reading(.checking) }
        lock.unlock()
        for server in servers {
            let report: (DeviceSwitch.Reading) -> Void = { [weak self] reading in self?.update(server.id, reading) }
            (server.relay != nil ? relay : direct)(server, report)
        }
        // Not known by the bound reads offline; a later report still turns the row.
        schedule(Self.boundMs) { [weak self] in
            guard let self else { return }
            for server in servers where self.current(server.id)?.status == .checking {
                self.update(server.id, DeviceSwitch.Reading(.offline), timedOut: true)
            }
        }
    }

    func status(_ id: String) -> DeviceSwitch.Status? {
        current(id)?.status
    }

    func snapshot() -> [String: DeviceSwitch.Reading] {
        lock.lock()
        defer { lock.unlock() }
        return statuses
    }

    /// The sheet closed. `keep` is the switch's target: its link is about to be the current one. `release: false`
    /// leaves every warm link to whoever else holds it.
    func stop(keep: String? = nil, release releasing: Bool = true) {
        lock.lock()
        guard !stopped else {
            lock.unlock()
            return
        }
        stopped = true
        let servers = probed
        lock.unlock()
        guard releasing else { return }
        for server in servers where server.id != keep { release(server) }
    }

    private func current(_ id: String) -> DeviceSwitch.Reading? {
        lock.lock()
        defer { lock.unlock() }
        return statuses[id]
    }

    private func update(_ id: String, _ reading: DeviceSwitch.Reading, timedOut: Bool = false) {
        lock.lock()
        guard let before = statuses[id] else {
            lock.unlock()
            return
        }
        var next = reading
        // Counts outlive a later status-only report from the same link.
        if next.status == before.status && next.attention == nil { next.attention = before.attention }
        // A link still connecting after the bound stays offline until it says otherwise.
        let unchanged = before == next || (next.status == .checking && before.status == .offline)
        guard !stopped, !unchanged, !timedOut || before.status == .checking else {
            lock.unlock()
            return
        }
        statuses[id] = next
        lock.unlock()
        onChange(id, next)
    }
}

extension DeviceProbes {
    /// Through the switcher's own link, which a switch then adopts: the probe is the warm-up. Once the link
    /// is ready, its health answer gives the counts. No keys reads as removed.
    static func relayProbe(_ relay: RelayConnections, userAgent: String) -> Probe {
        { server, report in
            DispatchQueue.global(qos: .utility).async {
                guard let link = relay.warm(server) else {
                    report(DeviceSwitch.Reading(DeviceSwitch.status(RelayStatus.Kind.deviceRemoved)))
                    return
                }
                let counted = Once()
                let seen: (RelayStatus) -> Void = { status in
                    let reading = relayReading(status.kind)
                    report(reading)
                    guard status.kind == .ready, counted.claim() else { return }
                    Task {
                        let health = await HealthProbe(http: TunnelHttpGet(sessions: { link.session() }), userAgent: userAgent).probePath()
                        report(healthReading(health))
                    }
                }
                // The page on screen keeps its own listener on the current link.
                if relay.warming(server.id) { link.setListener(seen) }
                link.start()
                seen(link.status())
            }
        }
    }

    /// Ready means only that the relay took the phone: the cezar's own answer makes it online (PR #2340 smoke).
    static func relayReading(_ kind: RelayStatus.Kind) -> DeviceSwitch.Reading {
        kind == .ready ? DeviceSwitch.Reading(.checking) : DeviceSwitch.Reading(DeviceSwitch.status(kind))
    }

    /// A ready link's health, through the tunnel: a cezar that stopped answering reads offline, not online.
    static func healthReading(_ health: HealthAnswer) -> DeviceSwitch.Reading {
        DeviceSwitch.Reading(DeviceSwitch.status(health.kind), attention: health.kind == .cezar ? health.attention : nil)
    }

    /// A direct server's health, with its saved password and the cookies `cookies` reads.
    static func directProbe(_ connector: ShellConnector, cookies: @escaping (ServerRecord) async -> String?) -> Probe {
        { server, report in
            Task {
                guard let health = await connector.health(server.id, cookies: await cookies(server)) else { return }
                report(DeviceSwitch.Reading(DeviceSwitch.status(health.kind), attention: health.attention))
            }
        }
    }
}

/// True to the first caller only, from any thread.
private final class Once {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
