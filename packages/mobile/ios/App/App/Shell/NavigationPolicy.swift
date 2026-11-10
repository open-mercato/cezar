import Foundation

/// Which navigations stay in the server webview (spec "Other shell behaviour").
enum NavigationPolicy {
    enum Action { case allow, external, servers, block }

    static func decide(origin: ServerOrigin, url: String, pageUrl: String?, mainFrame: Bool, redirect: Bool) -> Action {
        let scheme = schemeOf(url)
        if scheme == "cezar" {
            let bare = url.lowercased()
            return mainFrame && (bare == "cezar://servers" || bare == "cezar://servers/") ? .servers : .block
        }
        if ["about", "blob", "data"].contains(scheme) { return .allow }
        if scheme == "mailto" || scheme == "tel" { return mainFrame ? .external : .block }
        if scheme != "https" && scheme != "http" { return .block }
        if origin.sameOrigin(url) || !mainFrame { return .allow }
        // An SSO login leaves the origin by redirect and works on its own pages until it returns.
        // The responder still refuses every challenge off the origin.
        if scheme == "https" && (redirect || !origin.sameOrigin(pageUrl)) { return .allow }
        return .external
    }

    /// `window.open` and `target=_blank`: same origin stays here, the rest leave the app.
    static func decideWindow(origin: ServerOrigin, url: String) -> Action {
        if origin.sameOrigin(url) { return .allow }
        return ["https", "http", "mailto", "tel"].contains(schemeOf(url)) ? .external : .block
    }

    private static func schemeOf(_ url: String) -> String {
        URLComponents(string: url)?.scheme?.lowercased() ?? ""
    }
}
