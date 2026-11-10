import Foundation
import WebKit

/// The webview's store for one origin: cookies for the probe, and the wipe behind Forget server.
enum WebsiteData {
    @MainActor
    static func cookieHeader(for url: String) async -> String? {
        guard let target = URL(string: url), let host = target.host else { return nil }
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        let matching = cookies.filter { matches(cookieDomain: $0.domain, host: host) }
        return HTTPCookie.requestHeaderFields(with: matching)["Cookie"]
    }

    @MainActor
    static func forget(url: String) async {
        guard let host = URL(string: url)?.host else { return }
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        // Records are grouped by registrable domain, so this is the narrowest cut WebKit offers.
        let records = await store.dataRecords(ofTypes: types).filter { record in
            host == record.displayName || host.hasSuffix("." + record.displayName)
        }
        await store.removeData(ofTypes: types, for: records)
    }

    private static func matches(cookieDomain: String, host: String) -> Bool {
        let domain = cookieDomain.hasPrefix(".") ? String(cookieDomain.dropFirst()) : cookieDomain
        return host == domain || host.hasSuffix("." + domain)
    }
}
