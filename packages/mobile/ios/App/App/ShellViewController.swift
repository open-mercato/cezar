import Capacitor
import UIKit

/// Framework adapter: hosts the connect page and nothing else.
class ShellViewController: CAPBridgeViewController {
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
