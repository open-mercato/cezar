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
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pairCode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pairCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pairPoll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lockSet", returnType: CAPPluginReturnPromise),
    ]

    /// A QR string from a debug-only route. Release builds have no way to set it.
    static let debugQr = "debug-qr"
    private static let pollMs: Int64 = 20000

    private var connector: ShellConnector { ShellServices.connector }
    private var push: PushCoordinator { ShellServices.push }

    /// Waits for the lock, so a locked app opens no server and consumes no route behind it (spec QR3).
    @objc func launch(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AppLock.shared.whenUnlocked { [self] in start(call) }
        }
    }

    private func start(_ call: CAPPluginCall) {
        // § 7: an owed revoke is retried on each app open, off the launch's path.
        DispatchQueue.global(qos: .utility).async { ShellServices.push.retryRevokes() }
        let route = ShellRoute.take()
        if route != nil { LaunchHold.shared.release() }
        if let route, ShellServices.debugBuild, route.screen == Self.debugQr {
            run(call) { [self] in pairing(await offMain { ShellServices.pairing.startQr(route.serverId) }) }
            return
        }
        if let tap = PushTap.take() {
            run(call) { [self] in
                let outcome = await PushTap.open(connector, tap) { server in await Self.managerId(server) }
                if let outcome, outcome.url == nil { LaunchHold.shared.release() }
                if let outcome { return await present(outcome) }
                return await launchAsUsual()
            }
            return
        }
        if let route {
            run(call) { [self] in listed(["screen": route.screen, "serverId": route.serverId ?? ""]) }
            return
        }
        run(call) { [self] in await launchAsUsual() }
    }

    private func launchAsUsual() async -> [String: Any] {
        if await MainActor.run(body: { root()?.serverOpen ?? false }) {
            LaunchHold.shared.release()
            return listed(["screen": ShellConnector.open])
        }
        let last = connector.lastUsedId().flatMap { connector.server($0) }
        let outcome = await connector.launch(cookiesForLast: await cookies(for: last))
        // Opening a server: its view releases the splash once its own cover is up.
        if outcome.url == nil { LaunchHold.shared.release() }
        return await present(outcome)
    }

    /// Asked in the session the open just made. The id never left it: the push carries only the cezarId.
    private static func managerId(_ server: ServerRecord) async -> String? {
        await offMain {
            guard let link = ShellServices.relay.link(server), link.session() != nil else { return nil }
            return (try? ShellServices.cezarPush({ link.session() }).get())?.managerId
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        // Back from Servers: the bundle is on the phone, so the view opens at once and reports the link itself.
        let quick = call.getBool("quick") ?? false
        run(call) { [self] in await present(connector.open(id, cookies: await cookies(for: connector.server(id)), quick: quick)) }
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

    /// The server's whole data store goes, relay or not: cookies, storage and any cached Basic answer.
    @objc func forget(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        run(call) { [self] in
            let known = connector.server(id) != nil
            connector.forget(id)
            if known { await WebsiteData.forget(serverId: id) }
            return listed([:])
        }
    }

    /// Reads and opens nothing, unlike launch: the page calls it each time it returns to the foreground.
    @objc func list(_ call: CAPPluginCall) {
        run(call) { [self] in listed([:]) }
    }

    /// A relay server's Notifications switch. On asks iOS for permission first (spec R5).
    @objc func pushSet(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let enabled = call.getBool("enabled") ?? false
        run(call) { [self] in
            if enabled {
                let granted = await withCheckedContinuation { done in ShellServices.notifier.requestAuthorization { done.resume(returning: $0) } }
                if !granted { return listed(["pushError": "Allow notifications for Cezar in Settings to turn this on."]) }
            }
            let server = connector.server(id)
            await offMain { _ = ShellServices.push.setEnabled(server, enabled) }
            if enabled, !(await offMain { ShellServices.notifier.allowed() }) {
                return listed(["pushError": "Notifications for Cezar are off in Settings."])
            }
            return listed([:])
        }
    }

    @objc func lockSet(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        run(call) { [self] in
            let error = await withCheckedContinuation { done in
                DispatchQueue.main.async { AppLock.shared.change(on: enabled) { done.resume(returning: $0) } }
            }
            return listed(error.map { ["lockError": $0] } ?? [:])
        }
    }

    @objc func scan(_ call: CAPPluginCall) {
        run(call) { [self] in
            let scanned: (String?, String?) = await withCheckedContinuation { done in
                Task { @MainActor in
                    guard let root = self.root() else {
                        done.resume(returning: (nil, nil))
                        return
                    }
                    root.present(QrScannerViewController { code, error in done.resume(returning: (code, error)) }, animated: true)
                }
            }
            if let error = scanned.1 { throw ScanRefused(message: error) }
            guard let code = scanned.0 else { return listed([:]) }
            return pairing(await offMain { ShellServices.pairing.startQr(code) })
        }
    }

    /// PBKDF2 runs inside, so never on the main thread.
    @objc func pairCode(_ call: CAPPluginCall) {
        let code = call.getString("code")
        let relay = call.getString("relay")
        run(call) { [self] in pairing(await offMain { ShellServices.pairing.startCode(code, relayAddress: relay) }) }
    }

    @objc func pairCancel(_ call: CAPPluginCall) {
        run(call) { [self] in
            await offMain { ShellServices.pairing.cancel() }
            return listed([:])
        }
    }

    /// A long poll, on its own thread so that Cancel still gets through.
    @objc func pairPoll(_ call: CAPPluginCall) {
        let seq = call.getInt("seq") ?? 0
        run(call) { [self] in
            let next = await offMain { ShellServices.pairing.next(seen: seq, timeoutMs: Self.pollMs) }
            guard next.phase == .approved, let id = ShellServices.lastPaired.value else { return pairing(next) }
            let askPush = push.shouldAsk()
            return await present(connector.open(id, cookies: nil), askPush: askPush)
        }
    }

    private func pairing(_ snapshot: PairingFlow.Snapshot) -> [String: Any] {
        listed(["screen": "pair", "seq": snapshot.seq, "phase": snapshot.phase.rawValue.lowercased(),
                "digits": snapshot.digits ?? NSNull(), "label": snapshot.label ?? NSNull(), "reason": snapshot.reason ?? NSNull()])
    }

    private func cookies(for server: ServerRecord?) async -> String? {
        guard let server, let url = server.url else { return nil }
        return await WebsiteData.cookieHeader(serverId: server.id, url: url)
    }

    @MainActor
    private func root() -> ShellViewController? { bridge?.viewController as? ShellViewController }

    /// Refuses before any work. This class also guards the case the view split cannot: the
    /// framework's message handler checks no origin at all.
    private func run(_ call: CAPPluginCall, work: @escaping () async throws -> [String: Any]) {
        Task { @MainActor in
            let caller = self.bridge?.webView?.url?.absoluteString
            guard OriginGate.allows(callerUrl: caller, shellUrl: self.bridge?.config.serverURL.absoluteString) else {
                call.reject("Refused: the connection plugin serves the bundled connect page only.")
                return
            }
            do {
                call.resolve(try await work())
            } catch let refused as ScanRefused {
                call.reject(refused.message)
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// The page shows a rejection as a notice with a way back to Servers.
    private struct ScanRefused: Error {
        let message: String
    }

    /// `askPush`: the first relay pairing, whose server view asks once about notifications.
    private func present(_ outcome: ShellConnector.Outcome, label: String? = nil, askPush: Bool = false) async -> [String: Any] {
        // Removed by the computer: what the cockpit kept on the phone goes, as on Forget.
        if outcome.screen == ShellConnector.deviceRemoved, let id = outcome.serverId { await WebsiteData.wipe(serverId: id) }
        if let url = outcome.url, let storeId = outcome.serverId ?? outcome.pendingId {
            let server = outcome.serverId.flatMap { connector.server($0) }
            await MainActor.run {
                guard let root = self.root() else {
                    LaunchHold.shared.release()
                    return
                }
                let origin: PageOrigin? = server?.relay != nil ? nil : outcome.origin
                guard server?.relay != nil || origin != nil else {
                    LaunchHold.shared.release()
                    return
                }
                root.show(ServerViewController(connector: connector, origin: origin, start: url, serverId: outcome.serverId, storeId: storeId,
                                               note: outcome.note, pendingLogin: outcome.screen == ShellConnector.login,
                                               pendingLabel: label, askPush: askPush) { [weak root] route in
                    root?.returned(with: route)
                })
            }
        }
        return listed(["screen": outcome.screen, "serverId": outcome.serverId ?? "", "status": outcome.status])
    }

    private func listed(_ fields: [String: Any]) -> [String: Any] {
        var result = fields
        result["servers"] = connector.list().map { server -> [String: Any] in
            var row: [String: Any] = ["id": server.id, "label": server.label, "url": server.relay?.origin ?? server.url ?? "",
                                      "relay": server.relay != nil, "username": server.username ?? ""]
            // Stage 1 needs only the session, so every relay server has the switch, APNs or not.
            if server.relay != nil { row["push"] = push.enabled(server.id) }
            return row
        }
        result["removing"] = push.removing()
        result["pairing"] = true
        result["relayDefault"] = RelayOrigin.defaultOrigin
        result["lock"] = ["enabled": AppLock.shared.enabled, "available": AppLock.shared.available()]
        return result
    }
}

/// Runs blocking work off the main thread.
func offMain<T>(_ work: @escaping () -> T) async -> T {
    await withCheckedContinuation { done in
        DispatchQueue.global(qos: .userInitiated).async { done.resume(returning: work()) }
    }
}
