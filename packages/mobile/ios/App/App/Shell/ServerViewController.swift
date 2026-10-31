import UIKit
import WebKit

/// Hosts server pages in a plain WKWebView with no bridge, so page script has no path to native
/// code by construction (spec "No native bridge on server pages"). The framework's webview injects
/// its bridge into every main frame, so it only ever shows the bundled connect page.
final class ServerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let connector: ShellConnector
    private let origin: ServerOrigin
    private let startUrl: URL
    private let note: String?
    private let onLeave: (ShellRoute) -> Void
    private var serverId: String?
    private var pendingLabel: String?
    private var pendingLogin: Bool
    private var responder: BasicChallengeResponder?
    private var webView: WKWebView!
    private var provisional = false
    private var leaving = false

    init(connector: ShellConnector, origin: ServerOrigin, startUrl: URL, serverId: String?, note: String?,
         pendingLogin: Bool, pendingLabel: String?, onLeave: @escaping (ShellRoute) -> Void) {
        self.connector = connector
        self.origin = origin
        self.startUrl = startUrl
        self.serverId = serverId
        self.note = note
        self.pendingLogin = pendingLogin
        self.pendingLabel = pendingLabel
        self.onLeave = onLeave
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        bindResponder()
    }

    required init?(coder: NSCoder) {
        fatalError("not used from a storyboard")
    }

    private func bindResponder() {
        guard let serverId, let server = connector.server(serverId) else { return }
        responder = BasicChallengeResponder(server: server) { [connector] id in connector.password(id) }
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.applicationNameForUserAgent = "Mobile/15E148 " + ShellServices.userAgentToken(version: ShellServices.version)
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: startUrl))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let note { alert(note) { } }
    }

    private func leave(_ screen: String) {
        guard !leaving else { return }
        leaving = true
        let route = ShellRoute(screen: screen, serverId: serverId)
        dismiss(animated: true) { [onLeave] in onLeave(route) }
    }

    private func alert(_ message: String, done: @escaping () -> Void) {
        let controller = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "OK", style: .default) { _ in done() })
        present(controller, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else {
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
        responder?.onPageLoaded()
        if pendingLogin, origin.sameOrigin(webView.url?.absoluteString) { confirmPendingLogin() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        provisional = false
        let nsError = error as NSError
        // Cancelled, and WebKit's "interrupted by policy change", are our own decisions above.
        if nsError.code == NSURLErrorCancelled || nsError.code == 102 { return }
        let tls = nsError.domain == NSURLErrorDomain && (-1204 ... -1200).contains(nsError.code)
        leave(tls ? ShellConnector.tlsFailure : ShellConnector.connectionError)
    }

    /// Spec M2 item 2. A reload raises a fresh challenge if WebKit dropped the session.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        responder?.onPageLoaded()
        webView.load(URLRequest(url: webView.url ?? startUrl))
    }

    private func confirmPendingLogin() {
        let url = origin.origin
        let label = pendingLabel
        Task { @MainActor in
            let cookies = await WebsiteData.cookieHeader(for: url)
            let outcome = await connector.confirmLogin(url: url, cookies: cookies, label: label)
            guard outcome.screen == ShellConnector.open, let next = outcome.url.flatMap(URL.init(string:)) else { return }
            pendingLogin = false
            serverId = outcome.serverId
            bindResponder()
            webView.load(URLRequest(url: next))
        }
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
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
