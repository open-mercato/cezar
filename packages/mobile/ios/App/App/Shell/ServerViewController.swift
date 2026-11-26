import UIKit
import WebKit

/// Hosts server pages in a plain WKWebView with no bridge, so page script has no path to native
/// code by construction (spec "No native bridge on server pages"). The framework's webview injects
/// its bridge into every main frame, so it only ever shows the bundled connect page.
///
/// A relay server's page is `http://127.0.0.1:<port>`, served by `LoopbackProxy` through the tunnel
/// (spec R4). Its gate cookie goes into the server's own data store before the first load.
final class ServerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let connector: ShellConnector
    /// A ServerOrigin for a URL server; for a relay server, the ProxyOrigin once the listener is bound.
    private var origin: PageOrigin?
    /// A whole URL for a URL server, a path for a relay server.
    private let start: String
    private let note: String?
    private let onLeave: (ShellRoute) -> Void
    /// The server's own data store: its id, or the id a pending sign-in will be saved under.
    private let storeId: String
    private var serverId: String?
    private var pendingLabel: String?
    private var pendingLogin: Bool
    private var responder: BasicChallengeResponder?
    private var webView: WKWebView!
    private var cancelButton: UIButton?
    private var provisional = false
    private var leaving = false
    /// The launch screen over the page until it has drawn, or the reason it did not: never a black web view.
    private var cover: LaunchCover?
    private var watchdog: StartupWatchdog!
    private var resume: ResumeCheck!
    /// The last PageCheck answer, nil when none came: a dead content process never answers.
    private var pageState: PageCheck.State?
    private var pageAskedAt: Int64 = -1
    /// A blank cockpit is reloaded once from cezar itself, past both caches, before the panel shows.
    private var recoveredBlank = false
    /// Bumped per start, so an answer for an earlier document never counts.
    private var generation = 0
    /// The content process ended while the page was off screen.
    private var restartWhenVisible = false
    /// The reason on the panel now: logged once, not per tick.
    private var shownProblem: String?

    // Relay servers only. The URL path never touches these.
    private let relayServer: ServerRecord?
    private var link: RelayLink?
    private var proxy: LoopbackProxy?
    private var banner: ConnectionBanner?
    private var bannerTimer: DispatchWorkItem?
    private var notReadySince: Int64 = 0
    private var reloadWhenReady = false
    /// Once per view: the first session settles this phone's push grant with cezar.
    private var pushSynced = false
    /// The § 18 reminder while the computer's email waits; nil when there is nothing to say.
    private var reminder: String?
    private var askPush: Bool
    private var started = false
    /// The socket closes 30 s after the page leaves the screen, so a Stage 1 signal in that window still shows.
    private var grace: GraceClose?
    private var signals: SignalStream?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var network: NetworkWatch?
    private let startLog = ShellServices.startupLog
    /// The last status the startup log was told, and the last 502 reason: one line per change, not per request.
    private var loggedKind: RelayStatus.Kind?
    private let logged502 = Locked<Unreachable?>(nil)

    /// Whether a server view is up: launch() then leaves it alone, as Android's `isOpen`.
    static private(set) var openCount = 0

    init(connector: ShellConnector, origin: PageOrigin?, start: String, serverId: String?, storeId: String, note: String?,
         pendingLogin: Bool, pendingLabel: String?, askPush: Bool = false, onLeave: @escaping (ShellRoute) -> Void) {
        self.connector = connector
        self.origin = origin
        self.start = start
        self.serverId = serverId
        self.storeId = storeId
        self.note = note
        self.pendingLogin = pendingLogin
        self.pendingLabel = pendingLabel
        self.askPush = askPush
        self.onLeave = onLeave
        relayServer = serverId.flatMap { connector.server($0) }.flatMap { $0.relay != nil ? $0 : nil }
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        if relayServer == nil { bindResponder() }
    }

    required init?(coder: NSCoder) {
        fatalError("not used from a storyboard")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func bindResponder() {
        guard let serverId, let server = connector.server(serverId), server.relay == nil else { return }
        responder = BasicChallengeResponder(server: server) { [connector] id in connector.password(id) }
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WebsiteData.store(for: storeId)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.applicationNameForUserAgent = "Mobile/15E148 " + ShellServices.userAgent
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // A long press on an in-app link shows the cockpit's own actions, not a loopback URL preview.
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        Self.openCount += 1
        watchdog = StartupWatchdog(serverLabel: relayServer?.label ?? pendingLabel, relay: relayServer != nil)
        resume = ResumeCheck(expectsRoot: relayServer != nil)
        watchdog.start(relayNowMs())
        addCover()
        if pendingLogin { addCancelButton() }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(appForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        center.addObserver(self, selector: #selector(appBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        if let relayServer {
            startLog.begin("open relay")
            openProxy(relayServer)
        } else if let url = URL(string: start) {
            webView.load(URLRequest(url: url))
        }
    }

    /// LaunchScreen.storyboard's look, so the launch flows into the page with no blank frame between.
    private func addCover() {
        let launch = LaunchCover(retry: { [weak self] in self?.retry() }, servers: { [weak self] in self?.leave(ShellConnector.list) })
        launch.frame = view.bounds
        launch.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if let banner { view.insertSubview(launch, belowSubview: banner) } else { view.addSubview(launch) }
        // A cover put back by a restart must not hide a pending add's way out.
        if let cancelButton { view.bringSubviewToFront(cancelButton) }
        launch.show(status: watchdog.decide(relayNowMs()).text)
        cover = launch
        startTicking()
    }

    private func startTicking() {
        generation += 1
        pageState = nil
        pageAskedAt = -1
        shownProblem = nil
        scheduleTick(generation)
    }

    /// On a timer, never inside a page answer: an evaluateJavaScript callback is lost with its document.
    private func scheduleTick(_ generation: Int, after ms: Int64 = 100) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(ms))) { [weak self] in
            guard let self, self.generation == generation, self.cover != nil, !self.leaving else { return }
            self.tick(generation)
        }
    }

    private func tick(_ generation: Int) {
        guard let cover else { return }
        let now = relayNowMs()
        askPage(now)
        let decision = watchdog.decide(now)
        switch decision.kind {
        case .reveal:
            removeCover()
        case .wait:
            cover.show(status: decision.text)
            scheduleTick(generation)
        case .blank where !recoveredBlank:
            recoveredBlank = true
            startLog.step("cockpit blank after load, reloads past the caches")
            restart(fresh: true)
        case .blank, .problem:
            if shownProblem != decision.text {
                shownProblem = decision.text
                startLog.step("problem: \(decision.text ?? "")")
                cover.show(problem: decision.text)
            }
            // A page that draws after all (a reload when the session came back, a slow sign-in page) still takes the panel's place.
            if PageCheck.healthy(pageState, expectsRoot: relayServer != nil) {
                removeCover()
                return
            }
            scheduleTick(generation, after: 1000)
        }
    }

    private func askPage(_ now: Int64) {
        if pageAskedAt >= 0 && now - pageAskedAt < 500 { return }
        pageAskedAt = now
        let asked = generation
        webView.evaluateJavaScript(PageCheck.script) { [weak self] answer, _ in
            guard let self, self.generation == asked else { return }
            self.pageAskedAt = -1
            self.pageState = PageCheck.state(answer)
            self.watchdog.page(self.pageState)
        }
    }

    private func removeCover() {
        guard let gone = cover else { return }
        cover = nil
        recoveredBlank = false
        startLog.step("shown")
        UIView.animate(withDuration: 0.15, animations: { gone.alpha = 0 }, completion: { _ in gone.removeFromSuperview() })
    }

    /// The cover's Retry: the relay asked again, the page loaded again from cezar.
    private func retry() {
        guard !leaving else { return }
        startLog.step("retry")
        if let link, link.status().kind != .ready { link.retryNow() }
        restart(fresh: true)
    }

    /// The cover back over the page and a new start. `fresh`: past the bundle cache and WebKit's HTTP
    /// cache, which is what a cockpit naming files the server no longer has needs.
    private func restart(fresh: Bool) {
        guard !leaving else { return }
        resume.stop()
        watchdog.start(relayNowMs())
        if let link { watchdog.relayStatus(link.status().kind, computer: relayServer?.label, now: relayNowMs()) }
        if let cover {
            cover.show(status: watchdog.decide(relayNowMs()).text)
            startTicking()
        } else {
            addCover()
        }
        guard fresh else {
            loadStart(fresh: false)
            return
        }
        if let id = relayServer?.id { ShellServices.relay.bundle(id)?.clear() }
        let store = webView.configuration.websiteDataStore
        Task { @MainActor in
            await store.removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache], modifiedSince: .distantPast)
            self.loadStart(fresh: true)
        }
    }

    /// The page this view shows, from the top. A relay view still binding loads when its listener is up.
    private func loadStart(fresh: Bool) {
        guard !leaving else { return }
        let current = webView.url.flatMap { origin?.sameOrigin($0.absoluteString) == true ? $0 : nil }
        let target: URL?
        if relayServer != nil {
            guard proxy != nil, let origin else { return }
            target = current ?? URL(string: origin.url(start))
        } else {
            target = current ?? URL(string: start)
        }
        guard let target else { return }
        var request = URLRequest(url: target)
        if fresh {
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        }
        webView.load(request)
    }

    /// After a resume the page must still be there (ResumeCheck); asked once a second until it is.
    private func checkResumed() {
        guard cover == nil, watchdog.started, !leaving else { return }
        resume.start(relayNowMs())
        pageState = nil
        generation += 1
        scheduleResumeCheck(generation)
    }

    private func scheduleResumeCheck(_ asked: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(1)) { [weak self] in
            guard let self, self.generation == asked, self.resume.running, self.cover == nil, self.started, !self.leaving else { return }
            switch self.resume.answer(self.pageState, now: relayNowMs()) {
            case .healthy:
                return
            case .restart:
                self.startLog.step("page did not come back after resume (\(self.pageState?.rawValue ?? "no answer")), reloads")
                self.restart(fresh: false)
            case .wait:
                self.webView.evaluateJavaScript(PageCheck.script) { [weak self] answer, _ in
                    guard let self, self.generation == asked else { return }
                    self.pageState = PageCheck.state(answer)
                }
                self.scheduleResumeCheck(asked)
            }
        }
    }

    /// Android has Back. Without this, a site that is not cezar holds an unsaved add for good.
    private func addCancelButton() {
        let button = UIButton(type: .system, primaryAction: UIAction(title: "Cancel") { [weak self] _ in
            self?.leave(ShellConnector.notCezar)
        })
        button.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(button)
        NSLayoutConstraint.activate([
            button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            button.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
        ])
        cancelButton = button
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let note { alert(note) { } }
        // The launch splash under this view may go: the cover is drawn over it now.
        LaunchHold.shared.release()
        becameVisible()
        afterVisible()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        becameHidden()
        if isBeingDismissed || presentingViewController == nil { tearDown() }
    }

    private func leave(_ screen: String) {
        leave(ShellRoute(screen: screen, serverId: serverId))
    }

    private func leave(_ route: ShellRoute) {
        guard !leaving else { return }
        leaving = true
        // From the presenter: `dismiss` here would close an open alert and leave this view up.
        presentingViewController?.dismiss(animated: true) { [onLeave] in onLeave(route) }
    }

    /// The device switcher, over this page. With no saved server yet (an add still signing in) it is the list, as before.
    private func showDevices() {
        guard !leaving else { return }
        guard let serverId, connector.server(serverId) != nil else {
            leave(ShellConnector.list)
            return
        }
        guard presentedViewController == nil else { return }
        let currentPath = DeviceLanding.pathOf(webView.url?.absoluteString)
        let sheet = DeviceSheetController(connector: connector, currentId: serverId, currentPath: currentPath) { [weak self] choice in
            guard let self, !self.leaving else { return }
            switch choice {
            case let .leave(route):
                self.leave(route)
            case let .open(outcome):
                guard let shell = self.presentingViewController as? ShellViewController else {
                    self.leave(ShellRoute(screen: ShellConnector.list, serverId: outcome.serverId))
                    return
                }
                // This view's teardown releases its link as on any leave; the target adopts the sheet's warm one.
                self.leaving = true
                shell.switchServer(to: outcome)
            }
        }
        present(sheet.wrapped(), animated: true)
    }

    private func alert(_ message: String, done: @escaping () -> Void) {
        let controller = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "OK", style: .default) { _ in done() })
        present(controller, animated: true)
    }

    // MARK: - Relay

    /// One listener, its port saved. A taken port is hostile: the store's data goes, and the page loads anew (spec).
    private func openProxy(_ server: ServerRecord) {
        let relay = ShellServices.relay
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let opened = try? relay.openProxy(server)
            let link = relay.link(server)
            DispatchQueue.main.async {
                guard let self, !self.leaving else {
                    if let opened { relay.release(opened) }
                    return
                }
                guard let opened, let link else {
                    if let opened { relay.release(opened) }
                    self.leave(ShellConnector.connectionError)
                    return
                }
                self.proxyOpened(server, opened, link)
            }
        }
    }

    private func proxyOpened(_ server: ServerRecord, _ opened: LoopbackProxy, _ link: RelayLink) {
        proxy = opened
        self.link = link
        let saved = server.relay?.port ?? 0
        let proxyOrigin = ProxyOrigin(port: opened.port())
        origin = proxyOrigin
        if opened.port() != saved { connector.saveRelayPort(id: server.id, port: opened.port()) }
        opened.setOnListenerLost { [weak self, weak opened] in
            DispatchQueue.main.async {
                // In the background `becameVisible` binds again; on screen nothing else would.
                guard let self, let opened, LoopbackProxy.shouldRebind(opened, current: self.proxy, started: self.started, leaving: self.leaving) else { return }
                self.rebindProxy("listener failed")
            }
        }
        opened.setOnShellChanged { [weak self] in
            DispatchQueue.main.async {
                // The shell painted from the phone was older than the server's: load the new one once.
                guard let self, !self.leaving else { return }
                self.webView.reload()
            }
        }
        let relay = ShellServices.relay
        grace = GraceClose(scheduler: GraceClose.MainScheduler()) { [weak self] in
            self?.startLog.step("grace over, socket closes")
            if relay.holds(opened) {
                link.setListener(nil)
                link.stop()
            }
            self?.endBackgroundTask()
        }
        signals = signalStream(server, link, opened)
        let log = startLog
        link.setDiagnostics { line in log.step(line) }
        network?.cancel()
        let watch = NetworkWatch { change, summary in
            log.step("network \(summary)")
            link.networkChanged(change)
        }
        network = watch
        let computer = server.label
        let logged = logged502
        opened.setUnreachable {
            let reason = Unreachable.of(link.status().kind, networkUp: watch.up)
            if logged.value != reason {
                logged.value = reason
                log.step("proxy 502 reason=\(reason.rawValue)")
            }
            return (reason, computer)
        }
        let store = webView.configuration.websiteDataStore
        Task { @MainActor in
            if opened.rebound() { await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) }
            // Before the cookie exists: no load may reach another loopback port with it (security review F1).
            guard let gate = try? await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: RequestGate.identifier(port: opened.port()), encodedContentRuleList: RequestGate.rules(port: opened.port())) else {
                leave(ShellConnector.connectionError)
                return
            }
            let content = webView.configuration.userContentController
            content.removeAllContentRuleLists()
            content.add(gate)
            // The callback is what guarantees the cookie reaches the first request (spec R0 question 2).
            if let cookie = opened.gateCookie() { await store.httpCookieStore.setCookie(cookie) }
            guard !leaving, let url = URL(string: proxyOrigin.url(start)) else { return }
            if started { startRelay() }
            webView.load(URLRequest(url: url))
        }
    }

    /// Wanted while this session is up, the switch is on and iOS lets the app notify.
    private func signalStream(_ server: ServerRecord, _ opened: RelayLink, _ mine: LoopbackProxy) -> SignalStream {
        let relay = ShellServices.relay
        let push = ShellServices.push
        let notifier = ShellServices.notifier
        let id = server.id
        let cezarId = server.relay?.cezarId ?? ""
        return SignalStream(source: ShellServices.signals { opened.session() }, wanted: {
            guard let session = opened.session() else { return false }
            return session.live() && relay.holds(mine) && push.enabled(id) && notifier.allowed()
        }, listener: { managerId in
            if ForegroundServers.shared.shouldNotify(id) && push.enabled(id) { notifier.post(cezarId: cezarId, managerId: managerId) }
        })
    }

    private func onRelayStatus(_ status: RelayStatus) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.leaving else { return }
            if status.kind == .ready { self.signals?.ensureRunning() }
            self.logStatus(status.kind)
            self.watchdog.relayStatus(status.kind, computer: self.relayServer?.label, now: relayNowMs())
            // In the grace window only the stream matters: the screen catches up when it starts again.
            guard self.started else { return }
            if let screen = Self.refusedScreen(status.kind) {
                // § 18: the relay refuses until the user acts. Nothing is lost, so nothing is wiped.
                self.leave(screen)
                return
            }
            if status.kind == .deviceRemoved {
                // Removed by the computer: what this server left on the phone goes, as on Forget.
                if let id = self.serverId {
                    ShellServices.relay.forgetBundle(id)
                    Task { @MainActor in await WebsiteData.wipe(serverId: id) }
                }
                self.leave(ShellConnector.deviceRemoved)
                return
            }
            if status.kind == .ready {
                self.notReadySince = 0
                self.onSessionUp()
                if self.reloadWhenReady {
                    self.reloadWhenReady = false
                    self.webView.reload()
                }
            } else if self.notReadySince == 0 && status.kind != .idle {
                self.notReadySince = relayNowMs()
            }
            self.showBanner()
        }
    }

    /// Reason codes for the startup log (the same words as the proxy's `x-cezar-unreachable`).
    private func logStatus(_ kind: RelayStatus.Kind) {
        guard kind != loggedKind else { return }
        loggedKind = kind
        switch kind {
        case .ready:
            logged502.value = nil
        case .idle, .connecting:
            break
        default:
            startLog.step("status \(kind.rawValue) reason=\(Unreachable.of(kind, networkUp: network?.up ?? true).rawValue)")
        }
    }

    private func onSessionUp() {
        if !pushSynced {
            pushSynced = true
            syncPush()
            checkAccount()
        }
        if askPush {
            askPush = false
            askAboutPush()
        }
    }

    /// Once per view: a gentle reminder while the computer's email waits for confirmation (§ 18).
    private func checkAccount() {
        guard let serverId, let server = connector.server(serverId), let relay = server.relay, let keys = ShellServices.deviceKeys.get(server.id) else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            // An older relay, or none to ask: no reminder.
            guard let status = try? ShellServices.accounts.status(origin: relay.origin, keys: keys, cezarId: relay.cezarId) else { return }
            if AccountReminder.asksTerms(status, serverId: server.id) {
                DispatchQueue.main.async { self?.leave(ShellConnector.deviceTerms) }
                return
            }
            let text = AccountReminder.text(status)
            DispatchQueue.main.async {
                self?.reminder = text
                self?.showBanner()
            }
        }
    }

    /// Off the main thread: the grant may need the relay and cezar both.
    private func syncPush() {
        guard let serverId, let server = connector.server(serverId), let link else { return }
        DispatchQueue.global(qos: .utility).async {
            ShellServices.push.sync(server, ShellServices.cezarPush { link.session() })
        }
    }

    private func askAboutPush() {
        ShellServices.push.markAsked()
        let controller = UIAlertController(title: "Get notified?",
                                           message: "Cezar can tell this phone when it needs you. The notification says only that, and you can turn it off in Your cezars.",
                                           preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "Not now", style: .cancel))
        controller.addAction(UIAlertAction(title: "Turn on", style: .default) { [weak self] _ in
            ShellServices.notifier.requestAuthorization { granted in
                DispatchQueue.main.async { if granted { self?.turnPushOn() } }
            }
        })
        present(controller, animated: true)
    }

    private func turnPushOn() {
        guard let serverId, let server = connector.server(serverId) else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = ShellServices.push.setEnabled(server, true)
            DispatchQueue.main.async { self?.signals?.ensureRunning() }
        }
        syncPush()
    }

    private func showBanner() {
        bannerTimer?.cancel()
        bannerTimer = nil
        guard let link else { return }
        let status = link.status()
        let counting = status.kind != .ready && status.kind != .idle && notReadySince != 0
        let waited = counting ? relayNowMs() - notReadySince : 0
        let computer = serverId.flatMap { connector.server($0)?.label }
        let text = counting ? ConnectionBannerText.of(kind: Self.bannerKind(status.kind), retryAfterSeconds: status.retryAfterSeconds, notReadyForMs: waited,
                                                      computer: computer) : nil
        if text == nil, let reminder, status.kind == .ready {
            installBanner()
            banner?.showReminder(reminder)
            return
        }
        guard let text else {
            banner?.hide()
            if counting && waited < ConnectionBannerText.graceMs {
                let tick = DispatchWorkItem { [weak self] in self?.showBanner() }
                bannerTimer = tick
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(ConnectionBannerText.graceMs - waited)), execute: tick)
            }
            return
        }
        installBanner()
        banner?.show(text)
    }

    private func installBanner() {
        guard banner == nil else { return }
        let view = ConnectionBanner(onRetry: { [weak self] in self?.link?.retryNow() },
                                    onServers: { [weak self] in self?.showDevices() },
                                    onConfirm: { [weak self] in self?.leave(ShellConnector.emailPending) })
        view.install(in: self.view)
        banner = view
    }

    private static func bannerKind(_ kind: RelayStatus.Kind) -> ConnectionBannerText.Kind {
        switch kind {
        case .idle: return .idle
        case .connecting: return .connecting
        case .ready: return .ready
        case .relayDown: return .relayDown
        case .cezarOffline: return .cezarOffline
        case .notAnswering: return .notAnswering
        case .quota: return .quota
        case .updateApp: return .updateApp
        case .updateCezar: return .updateCezar
        case .deviceRemoved: return .deviceRemoved
        case .broken: return .broken
        case .emailUnconfirmed, .accountRequired, .suspended, .termsRequiredDevice: return .accountRefused
        }
    }

    /// The connect-page screen a 4451 stop leaves to, nil for any other status.
    private static func refusedScreen(_ kind: RelayStatus.Kind) -> String? {
        switch kind {
        case .emailUnconfirmed: return ShellConnector.emailUnconfirmed
        case .accountRequired: return ShellConnector.accountRequired
        case .suspended: return ShellConnector.suspended
        case .termsRequiredDevice: return ShellConnector.termsRequiredDevice
        default: return nil
        }
    }

    /// The page is served only while on screen; the port stays bound and answers 503 (spec). The socket
    /// itself closes 30 s after, for Stage 1 signals, unless the screen comes back first.
    private func becameVisible() {
        guard !started else { return }
        started = true
        ForegroundServers.shared.started(serverId)
        ShellServices.badges.pageStarted(serverId)
        endBackgroundTask()
        guard let proxy, relayServer != nil else { return }
        startLog.step("foreground, link \(link?.status().kind.rawValue ?? "-")")
        if proxy.listening() {
            startRelay()
            // The listener's state arrives late or never after a suspension: ask it for real.
            checkProxy(proxy, "foreground")
            return
        }
        rebindProxy("listener gone")
    }

    /// One loopback round trip off the main thread; a listener that does not answer is bound again.
    private func checkProxy(_ checked: LoopbackProxy, _ why: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let answered = checked.answers()
            DispatchQueue.main.async {
                guard let self, LoopbackProxy.shouldRebind(checked, current: self.proxy, started: self.started, leaving: self.leaving, answered: answered) else { return }
                self.rebindProxy("listener not answering (\(why))")
            }
        }
    }

    /// A long suspension can tear the listener down: bind a new one, with a new gate cookie, and reload.
    private func rebindProxy(_ why: String) {
        guard let proxy, let relayServer else { return }
        // Blank first: until then the page would keep sending the old cookie to a port another app may
        // hold now (security review F3).
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        if let cookie = proxy.gateCookie() { webView.configuration.websiteDataStore.httpCookieStore.delete(cookie) }
        startLog.step("\(why), binds again")
        // The page is gone until the new listener serves it: the cover says so, and its deadlines run.
        resume.stop()
        watchdog.start(relayNowMs())
        if let cover {
            cover.show(status: watchdog.decide(relayNowMs()).text)
            startTicking()
        } else {
            addCover()
        }
        network?.cancel()
        network = nil
        link?.setDiagnostics(nil)
        grace?.cancel()
        signals?.stop()
        link?.setListener(nil)
        ShellServices.relay.release(proxy)
        self.proxy = nil
        openProxy(connector.server(relayServer.id) ?? relayServer)
    }

    private func startRelay() {
        guard let link, let proxy, let grace else { return }
        _ = grace.started()
        proxy.setServing(true)
        link.setListener { [weak self] status in self?.onRelayStatus(status) }
        // Already running after a short background: checked at once rather than trusted (RelayLink.start).
        link.start(reason: "foreground")
    }

    private func becameHidden() {
        guard started else { return }
        started = false
        ForegroundServers.shared.stopped(serverId)
        resume.stop()
        ShellServices.badges.pageStopped(serverId)
        guard let proxy, let grace else { return }
        startLog.step("background")
        bannerTimer?.cancel()
        proxy.setServing(false)
        notReadySince = 0
        // iOS suspends a backgrounded app within seconds; this keeps it running for the grace window.
        if backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "cezar-grace") { [weak self] in self?.endBackgroundTask() }
        }
        grace.stopped()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    @objc private func appForeground() {
        guard viewIfLoaded?.window != nil else { return }
        becameVisible()
        afterVisible()
    }

    /// Once the page is served again: a page lost while away loads now, and one that was up is checked.
    private func afterVisible() {
        if restartWhenVisible {
            restartWhenVisible = false
            restart(fresh: false)
        } else {
            checkResumed()
        }
    }

    @objc private func appBackground() {
        becameHidden()
    }

    private func tearDown() {
        Self.openCount = max(0, Self.openCount - 1)
        NotificationCenter.default.removeObserver(self)
        grace?.cancel()
        signals?.stop()
        network?.cancel()
        network = nil
        link?.setListener(nil)
        link?.setDiagnostics(nil)
        if let proxy { ShellServices.relay.release(proxy) }
        proxy = nil
        endBackgroundTask()
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let origin else {
            decisionHandler(.cancel)
            return
        }
        // WebKit marks a redirect only as `.other`, so a provisional load tells it from `location = …`.
        let redirect = action.navigationType == .other && provisional
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        // Bypass both WebKit's HTTP cache and the proxy's separate cached HTML on Reload.
        if mainFrame, action.navigationType == .reload, origin.sameOrigin(url.absoluteString),
           action.request.value(forHTTPHeaderField: "Cache-Control") != "no-cache" {
            var fresh = action.request
            fresh.cachePolicy = .reloadIgnoringLocalCacheData
            fresh.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            decisionHandler(.cancel)
            webView.load(fresh)
            return
        }
        switch NavigationPolicy.decide(origin: origin, url: url.absoluteString, pageUrl: webView.url?.absoluteString, mainFrame: mainFrame, redirect: redirect) {
        case .allow:
            decisionHandler(.allow)
        case .external:
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        case .servers:
            decisionHandler(.cancel)
            showDevices()
        case .reconnect:
            // The cockpit's "Retry now": a dead socket is replaced at once, a live one is asked.
            decisionHandler(.cancel)
            startLog.step("page asked to reconnect")
            link?.start(reason: "page")
            if let proxy { checkProxy(proxy, "page") }
        case .haptic:
            // A long-press quick action: one tap of feedback, no load, no UI, no history.
            decisionHandler(.cancel)
            DispatchQueue.main.async { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
        case .block:
            decisionHandler(.cancel)
        }
    }

    /// The proxy answered 502 or 503 with no session: the page reloads once one exists.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if link != nil, response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode == 502 || http.statusCode == 503 {
            startLog.step("page \(http.statusCode), reloads when ready")
            reloadWhenReady = true
            if cover != nil {
                watchdog.failed(http.statusCode == 503 ? "No connection to cezar came up in time." : "cezar's answer was cut off on the way.")
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        provisional = true
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        provisional = false
        if Self.isPage(webView.url) { watchdog.committed(relayNowMs()) }
    }

    /// The server's page, not the about:blank a rebind or a fresh web view shows.
    private static func isPage(_ url: URL?) -> Bool {
        url?.scheme == "http" || url?.scheme == "https"
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let facts = Challenge(challenge)
        guard let responder else {
            let trust = facts.method == NSURLAuthenticationMethodServerTrust
            completionHandler(trust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
            return
        }
        switch responder.onChallenge(facts) {
        case let .answer(username, password):
            completionHandler(.useCredential, URLCredential(user: username, password: password, persistence: .forSession))
        case .systemDefault:
            completionHandler(.performDefaultHandling, nil)
        case .cancelForeign:
            completionHandler(.cancelAuthenticationChallenge, nil)
        case .cancelRejected:
            completionHandler(.cancelAuthenticationChallenge, nil)
            leave(ShellConnector.passwordRejected)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        provisional = false
        if Self.isPage(webView.url) { watchdog.loaded(relayNowMs()) }
        if pendingLogin, origin?.sameOrigin(webView.url?.absoluteString) == true { confirmPendingLogin() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        provisional = false
        let nsError = error as NSError
        // Cancelled, and WebKit's "interrupted by policy change", are our own decisions above.
        if nsError.code == NSURLErrorCancelled || nsError.code == 102 { return }
        // The relay's own banner explains an outage; the page reloads when the session is back.
        if link != nil {
            reloadWhenReady = true
            if cover != nil { watchdog.failed("Loading the cockpit failed: \(nsError.localizedDescription)") }
            return
        }
        let tls = nsError.domain == NSURLErrorDomain && (-1204 ... -1200).contains(nsError.code)
        leave(tls ? ShellConnector.tlsFailure : ShellConnector.connectionError)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled || nsError.code == 102 { return }
        if cover != nil { watchdog.failed("Loading the cockpit failed: \(nsError.localizedDescription)") }
    }

    /// Spec M2 item 2. A reload raises a fresh challenge if WebKit dropped the session. Under the cover,
    /// with its deadlines: a reload into a page that cannot draw must not be the black screen.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // In the background the proxy answers 503: the page loads when it is seen again.
        guard started else {
            startLog.step("web content process ended in the background")
            restartWhenVisible = true
            return
        }
        startLog.step("web content process ended, reloads")
        restart(fresh: false)
    }

    private func confirmPendingLogin() {
        guard let origin = origin as? ServerOrigin else { return }
        let url = origin.origin
        let label = pendingLabel
        let pendingId = storeId
        Task { @MainActor in
            let cookies = await WebsiteData.cookieHeader(serverId: pendingId, url: url)
            let outcome = await connector.confirmLogin(url: url, pendingId: pendingId, cookies: cookies, label: label)
            guard outcome.screen == ShellConnector.open, let next = outcome.url.flatMap(URL.init(string:)) else { return }
            pendingLogin = false
            cancelButton?.removeFromSuperview()
            serverId = outcome.serverId
            bindResponder()
            webView.load(URLRequest(url: next))
        }
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, let origin else { return nil }
        switch NavigationPolicy.decideWindow(origin: origin, url: url.absoluteString) {
        case .allow: webView.load(URLRequest(url: url))
        case .external: UIApplication.shared.open(url)
        default: break
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        alert(message, done: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let controller = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        controller.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(controller, animated: true)
    }
}
