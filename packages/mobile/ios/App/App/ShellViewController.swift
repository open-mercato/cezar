import Capacitor
import UIKit

/// Framework adapter: hosts the connect page and nothing else.
class ShellViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        holdSplash()
    }

    /// LaunchScreen.storyboard over the connect page while a cold start decides; never past `LaunchHold.maxMs`.
    private func holdSplash() {
        guard LaunchHold.shared.holding() else { return }
        let splash = splash()
        let drop = { [weak splash] in
            DispatchQueue.main.async { splash?.removeFromSuperview() }
        }
        LaunchHold.shared.onRelease(drop)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(LaunchHold.maxMs)), execute: drop)
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ConnectionPlugin())
        // iOS has no Back button: the left-edge swipe asks the page, as Android's Back does.
        let swipe = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        swipe.edges = .left
        webView?.addGestureRecognizer(swipe)
    }

    @objc private func edgeSwipe(_ swipe: UIScreenEdgePanGestureRecognizer) {
        guard swipe.state == .recognized else { return }
        webView?.evaluateJavaScript(PageBack.script)
    }

    var serverOpen: Bool { presentedViewController is ServerViewController }

    func show(_ server: ServerViewController) {
        present(server, animated: false)
    }

    /// The server view for an outcome with a page to load, or nil when there is none.
    func serverView(_ outcome: ShellConnector.Outcome, label: String? = nil, askPush: Bool = false) -> ServerViewController? {
        let connector = ShellServices.connector
        guard let url = outcome.url, let storeId = outcome.serverId ?? outcome.pendingId else { return nil }
        let server = outcome.serverId.flatMap { connector.server($0) }
        let origin: PageOrigin? = server?.relay != nil ? nil : outcome.origin
        guard server?.relay != nil || origin != nil else { return nil }
        return ServerViewController(connector: connector, origin: origin, start: url, serverId: outcome.serverId, storeId: storeId,
                                    note: outcome.note, pendingLogin: outcome.screen == ShellConnector.login,
                                    pendingLabel: label, askPush: askPush) { [weak self] route in
            self?.returned(with: route)
        }
    }

    /// The device switcher's open: the splash covers the change, the new view paints under its own cover,
    /// so the connect page never shows between the two.
    func switchServer(to outcome: ShellConnector.Outcome) {
        let cover = splash()
        dismiss(animated: false) { [weak self] in
            guard let self else { return }
            if let next = self.serverView(outcome) {
                self.present(next, animated: false) { cover.removeFromSuperview() }
            } else {
                cover.removeFromSuperview()
                self.returned(with: ShellRoute(screen: ShellConnector.connectionError, serverId: outcome.serverId))
            }
        }
    }

    private func splash() -> UIView {
        let splash = UIImageView(image: UIImage(named: "Splash"))
        splash.contentMode = .scaleAspectFill
        splash.backgroundColor = .black
        splash.clipsToBounds = true
        splash.isUserInteractionEnabled = true
        splash.frame = view.bounds
        splash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(splash)
        return splash
    }

    /// The server view sent the user back: the page re-reads the route through launch().
    func returned(with route: ShellRoute) {
        ShellRoute.set(route)
        webView?.reload()
    }

    /// A notification tap was recorded: launch() opens its server, over whatever is up now.
    func reopenForTap() {
        if let server = presentedViewController as? ServerViewController {
            server.dismiss(animated: false) { [weak self] in self?.webView?.reload() }
        } else {
            webView?.reload()
        }
    }
}
