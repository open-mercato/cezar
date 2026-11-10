import Capacitor
import Foundation
import UIKit

/// Framework adapter for the connect page. All decisions live in the plain Shell group.
@objc(ConnectionPlugin)
public class ConnectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ConnectionPlugin"
    public let jsName = "Connection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "launch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "add", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    private var connector: ShellConnector { ShellServices.connector }

    @objc func launch(_ call: CAPPluginCall) {
        run(call) { [self] in
            if let route = ShellRoute.take() {
                return listed(["screen": route.screen, "serverId": route.serverId ?? ""])
            }
            let last = connector.lastUsedId().flatMap { connector.server($0) }
            let cookies = await cookies(for: last?.url)
            return await present(connector.launch(cookiesForLast: cookies), label: nil)
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        run(call) { [self] in
            let cookies = await cookies(for: connector.server(id)?.url)
            return await present(connector.open(id, cookies: cookies), label: nil)
        }
    }

    @objc func add(_ call: CAPPluginCall) {
        let url = call.getString("url")
        let username = call.getString("username")
        let password = call.getString("password")
        let label = call.getString("label")
        run(call) { [self] in
            await present(connector.add(url: url, username: username, password: password, label: label), label: label)
        }
    }

    @objc func forget(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        run(call) { [self] in
            let url = connector.server(id)?.url
            connector.forget(id)
            if let url { await WebsiteData.forget(url: url) }
            return listed([:])
        }
    }

    private func cookies(for url: String?) async -> String? {
        guard let url else { return nil }
        return await WebsiteData.cookieHeader(for: url)
    }

    /// Refuses before any work. This class also guards the case the view split cannot: the
    /// framework's message handler checks no origin at all.
    private func run(_ call: CAPPluginCall, work: @escaping () async -> [String: Any]) {
        Task { @MainActor in
            let caller = self.bridge?.webView?.url?.absoluteString
            guard OriginGate.allows(callerUrl: caller, shellUrl: self.bridge?.config.serverURL.absoluteString) else {
                call.reject("Refused: the connection plugin serves the bundled connect page only.")
                return
            }
            call.resolve(await work())
        }
    }

    @MainActor
    private func present(_ outcome: ShellConnector.Outcome, label: String?) -> [String: Any] {
        if let url = outcome.url.flatMap(URL.init(string:)), let origin = outcome.origin,
           let root = bridge?.viewController as? ShellViewController {
            root.show(ServerViewController(connector: connector, origin: origin, startUrl: url, serverId: outcome.serverId, note: outcome.note,
                                           pendingLogin: outcome.screen == ShellConnector.login, pendingLabel: label) { [weak root] route in
                root?.returned(with: route)
            })
        }
        return listed(["screen": outcome.screen, "serverId": outcome.serverId ?? "", "status": outcome.status])
    }

    private func listed(_ fields: [String: Any]) -> [String: Any] {
        var result = fields
        result["servers"] = connector.list().map { server -> [String: Any] in
            ["id": server.id, "label": server.label, "url": server.url, "username": server.username ?? ""]
        }
        return result
    }
}
