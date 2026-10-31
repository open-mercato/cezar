import Foundation

/// The User-Agent token and the one connector: the only thing a server page learns about the shell
/// is the token (spec Decision 2).
enum ShellServices {
    static func userAgentToken(version: String) -> String { "CezarMobile/\(version) (ios)" }

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    static let connector: ShellConnector = {
        var directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("cezar", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return ShellConnector(servers: ServerListStore(directory: directory), credentials: KeychainCredentialStore(),
                              probe: HealthProbe(http: PlatformHttpGet(), userAgent: userAgentToken(version: version)))
    }()
}

/// One-shot message from the server view back to the connect page.
struct ShellRoute {
    let screen: String
    let serverId: String?

    private static let lock = NSLock()
    private static var pending: ShellRoute?

    static func set(_ route: ShellRoute) {
        lock.lock()
        defer { lock.unlock() }
        pending = route
    }

    static func take() -> ShellRoute? {
        lock.lock()
        defer { lock.unlock() }
        let route = pending
        pending = nil
        return route
    }
}
