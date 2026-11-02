import Capacitor
import UIKit

/// Framework adapter: hosts the connect page and nothing else.
class ShellViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ConnectionPlugin())
    }

    func show(_ server: ServerViewController) {
        present(server, animated: false)
    }

    /// The server view sent the user back: the page re-reads the route through launch().
    func returned(with route: ShellRoute) {
        ShellRoute.set(route)
        webView?.reload()
    }
}
