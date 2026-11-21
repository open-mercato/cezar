import Foundation

/// Keeps the icon badge true outside Your cezars (spec 2026-11-20-phone-notifications-inbox, B1): one probe round
/// over every saved cezar as the app comes to the front, and one a minute while a cezar's page is on screen. Each
/// round ends in `apply`, which sets the badge and clears what reached 0. Android has the same.
final class BadgeRefresh {
    /// One probe round; `currentId` is the page on screen, read over its own link. `done` runs once, on any thread.
    typealias Round = (_ currentId: String?, _ done: @escaping () -> Void) -> Void

    static let pageEveryMs = 60_000
    /// Becoming active again within this reuses the last round: a pulled-down shade is not a new visit.
    static let minGapMs: Int64 = 10_000

    private let round: Round
    private let schedule: DeviceProbes.Scheduler
    private let clock: () -> Int64
    private let apply: () -> Void
    private let lock = NSLock()
    private var running = false
    private var lastAt: Int64?
    private var pages: [String] = []
    private var generation = 0
    private var holds = 0

    init(round: @escaping Round, schedule: @escaping DeviceProbes.Scheduler = DeviceProbes.background,
         clock: @escaping () -> Int64, apply: @escaping () -> Void) {
        self.round = round
        self.schedule = schedule
        self.clock = clock
        self.apply = apply
    }

    /// The app came to the front.
    func resumed() {
        refresh(force: false)
    }

    /// A cezar's page is on screen: read now, then every minute until the last page leaves.
    func pageStarted(_ serverId: String?) {
        guard let serverId else { return }
        lock.lock()
        pages.append(serverId)
        let first = pages.count == 1
        if first { generation += 1 }
        let ticking = generation
        lock.unlock()
        if first { tick(ticking) }
        refresh(force: false)
    }

    func pageStopped(_ serverId: String?) {
        guard let serverId else { return }
        lock.lock()
        if let index = pages.lastIndex(of: serverId) { pages.remove(at: index) }
        if pages.isEmpty { generation += 1 }
        lock.unlock()
    }

    /// The device sheet probes and warms its own links: no round may let them go under it.
    func hold(_ on: Bool) {
        lock.lock()
        holds = max(0, holds + (on ? 1 : -1))
        lock.unlock()
    }

    private func tick(_ ticking: Int) {
        schedule(Self.pageEveryMs) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let live = ticking == self.generation
            self.lock.unlock()
            guard live else { return }
            self.refresh(force: true)
            self.tick(ticking)
        }
    }

    private func refresh(force: Bool) {
        let now = clock()
        lock.lock()
        guard !running, holds == 0, force || lastAt.map({ now - $0 >= Self.minGapMs }) ?? true else {
            lock.unlock()
            return
        }
        running = true
        lastAt = now
        let current = pages.last
        lock.unlock()
        round(current) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.running = false
            self.lock.unlock()
            self.apply()
        }
    }
}
