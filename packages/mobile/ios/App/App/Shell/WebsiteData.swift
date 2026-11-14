import CryptoKit
import Foundation
import WebKit

/// One persistent WebKit data store per saved server (iOS 17+). Cookies, storage and the network
/// session's `.forSession` credentials live in it, so Forget deletes the whole store and with it the
/// Basic answer no API can reach in the shared store (#1883 review finding 1).
enum WebsiteData {
    private static let owedKey = "cezar.websiteData.owedRemovals"

    /// Server ids are UUIDs. Anything else maps to a stable name-based one, so no id is refused.
    static func identifier(for serverId: String) -> UUID {
        if let uuid = UUID(uuidString: serverId) { return uuid }
        var bytes = Array(SHA256.hash(data: Data(("cezar-website-data\n" + serverId).utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    @MainActor
    static func store(for serverId: String) -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: identifier(for: serverId))
    }

    @MainActor
    static func cookieHeader(serverId: String, url: String) async -> String? {
        guard let target = URL(string: url), let host = target.host else { return nil }
        let cookies = await store(for: serverId).httpCookieStore.allCookies()
        let matching = cookies.filter { matches(cookieDomain: $0.domain, host: host) }
        return HTTPCookie.requestHeaderFields(with: matching)["Cookie"]
    }

    /// Deletes the server's store. WebKit refuses while a web view still holds it, so a refusal is
    /// owed and retried at the next launch, before any server view exists. Its data is wiped meanwhile.
    @MainActor
    static func forget(serverId: String) async {
        let id = identifier(for: serverId)
        await wipe(serverId: serverId)
        if await remove(id) { return }
        var owed = UserDefaults.standard.stringArray(forKey: owedKey) ?? []
        if !owed.contains(id.uuidString) { owed.append(id.uuidString) }
        UserDefaults.standard.set(owed, forKey: owedKey)
    }

    /// Empties the server's store and keeps it: a removed phone's server stays on the list.
    @MainActor
    static func wipe(serverId: String) async {
        await store(for: serverId).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    /// Called once at launch.
    @MainActor
    static func removeOwed() async {
        let owed = UserDefaults.standard.stringArray(forKey: owedKey) ?? []
        guard !owed.isEmpty else { return }
        var left: [String] = []
        for raw in owed {
            guard let id = UUID(uuidString: raw) else { continue }
            if !(await remove(id)) { left.append(raw) }
        }
        UserDefaults.standard.set(left, forKey: owedKey)
    }

    /// A dismissed web view lets go of its store a moment later, so a few short retries cover the usual case.
    @MainActor
    private static func remove(_ id: UUID) async -> Bool {
        for attempt in 0..<5 {
            do {
                try await WKWebsiteDataStore.remove(forIdentifier: id)
                return true
            } catch {
                if attempt < 4 { try? await Task.sleep(nanoseconds: 300_000_000) }
            }
        }
        return false
    }

    private static func matches(cookieDomain: String, host: String) -> Bool {
        let domain = cookieDomain.hasPrefix(".") ? String(cookieDomain.dropFirst()) : cookieDomain
        return host == domain || host.hasSuffix("." + domain)
    }
}
