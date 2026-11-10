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
    private var askPush: Bool
    private var started = false
    /// The socket closes 30 s after the page leaves the screen, so a Stage 1 signal in that window still shows.
    private var grace: GraceClose?
    private var signals: SignalStream?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

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
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        Self.openCount += 1
        if pendingLogin { addCancelButton() }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(appForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        center.addObserver(self, selector: #selector(appBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        if let relayServer {
            openProxy(relayServer)
        } else if let url = URL(string: start) {
            webView.load(URLRequest(url: url))
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
        becameVisible()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        becameHidden()
        if isBeingDismissed || presentingViewController == nil { tearDown() }
    }

    private func leave(_ screen: String) {
        guard !leaving else { return }
        leaving = true
        let route = ShellRoute(screen: screen, serverId: serverId)
        // From the presenter: `dismiss` here would close an open alert and leave this view up.
        presentingViewController?.dismiss(animated: true) { [onLeave] in onLeave(route) }
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
        let relay = ShellServices.relay
        grace = GraceClose(scheduler: GraceClose.MainScheduler()) { [weak self] in
            if relay.holds(opened) {
                link.setListener(nil)
                link.stop()
            }
            self?.endBackgroundTask()
        }
        signals = signalStream(server, link, opened)
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
            // In the grace window only the stream matters: the screen catches up when it starts again.
            guard self.started else { return }
            if status.kind == .deviceRemoved {
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

    private func onSessionUp() {
        if !pushSynced {
            pushSynced = true
            syncPush()
        }
        if askPush {
            askPush = false
            askAboutPush()
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
                                           message: "Cezar can tell this phone when it needs you. The notification says only that, and you can turn it off on the Servers list.",
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
        let text = counting ? ConnectionBannerText.of(kind: Self.bannerKind(status.kind), retryAfterSeconds: status.retryAfterSeconds, notReadyForMs: waited) : nil
        guard let text else {
            banner?.hide()
            if counting && waited < ConnectionBannerText.graceMs {
                let tick = DispatchWorkItem { [weak self] in self?.showBanner() }
                bannerTimer = tick
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(ConnectionBannerText.graceMs - waited)), execute: tick)
            }
            return
        }
        if banner == nil {
            let view = ConnectionBanner(onRetry: { [weak self] in self?.link?.retryNow() },
                                        onServers: { [weak self] in self?.leave(ShellConnector.list) })
            view.install(in: self.view)
            banner = view
        }
        banner?.show(text)
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
        }
    }

    /// The page is served only while on screen; the port stays bound and answers 503 (spec). The socket
    /// itself closes 30 s after, for Stage 1 signals, unless the screen comes back first.
    private func becameVisible() {
        guard !started else { return }
        started = true
        ForegroundServers.shared.started(serverId)
        endBackgroundTask()
        guard let proxy, let relayServer else { return }
        if proxy.listening() {
            startRelay()
            return
        }
        // A long suspension can tear the listener down: bind a new one, with a new gate cookie, and reload.
        // Blank first: until then the page would keep sending the old cookie to a port another app may
        // hold now (security review F3).
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        if let cookie = proxy.gateCookie() { webView.configuration.websiteDataStore.httpCookieStore.delete(cookie) }
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
        link.start()
    }

    private func becameHidden() {
        guard started else { return }
        started = false
        ForegroundServers.shared.stopped(serverId)
        guard let proxy, let grace else { return }
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
        if viewIfLoaded?.window != nil { becameVisible() }
    }

    @objc private func appBackground() {
        becameHidden()
    }

    private func tearDown() {
        Self.openCount = max(0, Self.openCount - 1)
        NotificationCenter.default.removeObserver(self)
        grace?.cancel()
        signals?.stop()
        link?.setListener(nil)
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
        switch NavigationPolicy.decide(origin: origin, url: url.absoluteString, pageUrl: webView.url?.absoluteString, mainFrame: mainFrame, redirect: redirect) {
        case .allow:
            decisionHandler(.allow)
        case .external:
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        case .servers:
            decisionHandler(.cancel)
            leave(ShellConnector.list)
        case .block:
            decisionHandler(.cancel)
        }
    }

    /// The proxy answered 502 or 503 with no session: the page reloads once one exists.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if link != nil, response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode == 502 || http.statusCode == 503 {
            reloadWhenReady = true
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        provisional = true
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        provisional = false
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
            return
        }
        let tls = nsError.domain == NSURLErrorDomain && (-1204 ... -1200).contains(nsError.code)
        leave(tls ? ShellConnector.tlsFailure : ShellConnector.connectionError)
    }

    /// Spec M2 item 2. A reload raises a fresh challenge if WebKit dropped the session.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = webView.url ?? URL(string: origin?.url("/") ?? start) { webView.load(URLRequest(url: url)) }
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
