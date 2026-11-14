import Foundation

/// The relay socket outlives the screen by 30 s, so a signal in that window still shows (spec R5 as
/// built). Only a timer: no background task holds it, and a suspended app loses it. Main thread only.
final class GraceClose {
    static let graceMs: Int64 = 30_000

    /// A pending task, cancellable. Swift closures have no identity, so the handle stands in for Java's Runnable.
    protocol Scheduled: AnyObject {
        func cancel()
    }

    protocol Scheduler {
        func schedule(_ task: @escaping () -> Void, delayMs: Int64) -> Scheduled
    }

    /// The main queue, as Android's main-thread Handler.
    struct MainScheduler: Scheduler {
        init() {}

        func schedule(_ task: @escaping () -> Void, delayMs: Int64) -> Scheduled {
            let item = DispatchWorkItem(block: task)
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(delayMs)), execute: item)
            return Item(item)
        }

        private final class Item: Scheduled {
            let item: DispatchWorkItem
            init(_ item: DispatchWorkItem) { self.item = item }
            func cancel() { item.cancel() }
        }
    }

    private let scheduler: Scheduler
    private let close: () -> Void
    private var open = false
    private var scheduled: Scheduled?

    /// `close` stops the link; it runs at most once per stop.
    init(scheduler: Scheduler, close: @escaping () -> Void) {
        self.scheduler = scheduler
        self.close = close
    }

    /// The screen started: a pending close is cancelled. True when the socket had closed, or never opened.
    @discardableResult
    func started() -> Bool {
        if let pendingClose = scheduled {
            scheduled = nil
            pendingClose.cancel()
        }
        let wasOpen = open
        open = true
        return !wasOpen
    }

    /// The screen stopped: the close is due in `graceMs`.
    func stopped() {
        guard open, scheduled == nil else { return }
        var mine: Scheduled?
        mine = scheduler.schedule({ [weak self] in self?.fire(mine) }, delayMs: Self.graceMs)
        scheduled = mine
    }

    /// The screen is gone, and its link with it.
    func cancel() {
        scheduled?.cancel()
        scheduled = nil
        open = false
    }

    func pending() -> Bool { scheduled != nil }

    /// Only the close this stop scheduled: a late one from a cancelled stop does nothing.
    private func fire(_ which: Scheduled?) {
        guard let which, scheduled === which else { return }
        scheduled = nil
        open = false
        close()
    }
}
