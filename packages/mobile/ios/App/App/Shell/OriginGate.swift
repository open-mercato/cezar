import Foundation

/// The connection plugin serves the bundled connect page and no one else (spec Decision 2).
enum OriginGate {
    /// `shellUrl` is the app's own start URL, such as capacitor://localhost.
    static func allows(callerUrl: String?, shellUrl: String?) -> Bool {
        guard let callerUrl, let shellUrl, !callerUrl.contains("\\"),
              let caller = URLComponents(string: callerUrl), let shell = URLComponents(string: shellUrl),
              let shellHost = shell.host, let shellScheme = shell.scheme else { return false }
        return caller.scheme?.lowercased() == shellScheme.lowercased() && caller.host?.lowercased() == shellHost.lowercased()
            && caller.port == shell.port
    }
}
