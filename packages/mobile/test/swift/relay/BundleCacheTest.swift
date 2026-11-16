import Foundation

/// Android's BundleCacheTest: what is kept, how it reads back, and what goes.
func bundleCacheTests() {
    func headers(_ pairs: String...) -> [TunnelFrame.Header] {
        stride(from: 0, to: pairs.count, by: 2).map { TunnelFrame.Header(name: pairs[$0], value: pairs[$0 + 1]) }
    }
    func folder() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("bundle-" + UUID().uuidString) }
    let asset = headers("content-type", "text/javascript", "cache-control", "public, max-age=31536000, immutable")
    let shell = headers("content-type", "text/html; charset=utf-8", "cache-control", "no-cache", "etag", "\"1\"")

    test("only hashed bundle files and page loads are candidates") {
        expect(BundleCache.kindOf(method: "GET", target: "/assets/index-Ab12.js", fetchDest: "script", accept: "*/*") == .asset, "asset")
        expect(BundleCache.kindOf(method: "GET", target: "/manager/abc?x=1", fetchDest: "document", accept: "text/html") == .shell, "document")
        expect(BundleCache.kindOf(method: "GET", target: "/", fetchDest: nil, accept: "text/html,application/xhtml+xml") == .shell, "accept html")
        expect(BundleCache.kindOf(method: "GET", target: "/api/v1/workspace/managers", fetchDest: "empty", accept: "*/*") == .none, "api")
        expect(BundleCache.kindOf(method: "GET", target: "/api/v1/health", fetchDest: "document", accept: "text/html") == .none, "an API page load is still the API")
        expect(BundleCache.kindOf(method: "POST", target: "/assets/x.js", fetchDest: "script", accept: "*/*") == .none, "POST")
        expect(BundleCache.kindOf(method: "GET", target: "/assets/../secret", fetchDest: "script", accept: "*/*") == .none, "dot-dot")
        expect(BundleCache.kindOf(method: "GET", target: "/assets/sub/x.js", fetchDest: "script", accept: "*/*") == .none, "nested")
        expect(BundleCache.kindOf(method: "GET", target: "/icon.svg", fetchDest: "image", accept: "image/*") == .none, "image")
    }

    test("only what the server marks static is kept") {
        expect(BundleCache.storable(.asset, status: 200, headers: asset), "immutable asset")
        expect(!BundleCache.storable(.asset, status: 200, headers: headers("content-type", "text/javascript")), "an asset not marked immutable")
        expect(BundleCache.storable(.shell, status: 200, headers: shell), "shell")
        expect(BundleCache.storable(.shell, status: 200, headers: headers("content-type", "text/html")), "cezar's shell carries no ETag")
        expect(!BundleCache.storable(.shell, status: 200, headers: headers("content-type", "application/json", "etag", "x")), "a login page is no shell")
        expect(!BundleCache.storable(.asset, status: 404, headers: asset), "404")
        expect(!BundleCache.storable(.shell, status: 200, headers: headers("content-type", "text/html", "etag", "x", "cache-control", "no-store")), "no-store")
        expect(!BundleCache.storable(.none, status: 200, headers: asset), "none")
    }

    test("entries round-trip with their headers and nothing else") {
        let cache = BundleCache(directory: folder(), maxBytes: 1 << 20)
        cache.put(.asset, "/assets/a-1.js?v=2", headers: headers("content-type", "text/javascript", "cache-control", "immutable", "set-cookie", "s=1"),
                  body: Bytes.ascii("a()"))
        let hit = cache.get(.asset, "/assets/a-1.js")
        expect(hit.map { text($0.body) } == "a()", "body")
        expect(hit?.header("content-type") == "text/javascript", "content-type")
        expect(hit != nil && hit?.header("set-cookie") == nil, "never a cookie")
        cache.put(.shell, "/", headers: shell, body: Bytes.ascii("<html>"))
        expect(cache.get(.shell, "/tasks/1").map { text($0.body) } == "<html>", "one shell answers every route")
        expect(cache.hasShell(), "has shell")
    }

    test("the directory is kept out of backups") {
        let dir = folder()
        BundleCache(directory: dir, maxBytes: 1 << 20).saveStartPath("/")
        expect((try? dir.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true, "excluded from backup")
    }

    test("the start path is remembered and clear goes with everything") {
        let dir = folder()
        let cache = BundleCache(directory: dir, maxBytes: 1 << 20)
        cache.saveStartPath("/manager")
        cache.put(.shell, "/", headers: shell, body: Bytes.ascii("<html>"))
        expect(BundleCache(directory: dir, maxBytes: 1 << 20).startPath() == "/manager", "remembered")
        cache.clear()
        expect(!FileManager.default.fileExists(atPath: dir.path), "directory gone")
        expect(!cache.hasShell() && cache.startPath() == nil, "nothing left")
    }

    test("over the cap the oldest bundle files go but the shell stays") {
        let dir = folder()
        let cache = BundleCache(directory: dir, maxBytes: 2500)
        cache.put(.shell, "/", headers: shell, body: [UInt8](repeating: 0, count: 500))
        cache.put(.asset, "/assets/old.js", headers: asset, body: [UInt8](repeating: 0, count: 1000))
        let old = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("a-") }
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: dir.appendingPathComponent(old[0]).path)
        cache.put(.asset, "/assets/new.js", headers: asset, body: [UInt8](repeating: 0, count: 1000))
        expect(cache.get(.asset, "/assets/old.js") == nil, "oldest gone")
        expect(cache.get(.asset, "/assets/new.js")?.body.count == 1000, "newest kept")
        expect(cache.hasShell(), "shell kept")
    }

    test("a damaged file is a miss, not a crash") {
        let dir = folder()
        let cache = BundleCache(directory: dir, maxBytes: 1 << 20)
        cache.put(.shell, "/", headers: shell, body: Bytes.ascii("<html>"))
        try Data([0, 0, 0, 1, 0x7f, 0x7f]).write(to: dir.appendingPathComponent("shell"))
        expect(cache.get(.shell, "/") == nil, "miss")
        expect(!cache.hasShell(), "deleted")
    }

    test("a server id that is not the app's own gets no cache") {
        let connections = RelayConnections(transport: SilentTransport(), keys: MemoryKeys(), userAgent: "ua", bundles: folder())
        expect(connections.bundle("../x") == nil && connections.bundle("") == nil && connections.bundle(String(repeating: "a", count: 65)) == nil, "refused")
        expect(connections.bundle(UUID().uuidString) != nil, "a UUID")
        expect(RelayConnections(transport: SilentTransport(), keys: MemoryKeys(), userAgent: "ua").bundle(UUID().uuidString) == nil, "no directory, no cache")
    }

    test("forget and a probed open reach the bundle through the relay port") {
        let connections = RelayConnections(transport: SilentTransport(), keys: MemoryKeys(), userAgent: "ua", bundles: folder())
        let server = ServerRecord(id: UUID().uuidString, label: "Laptop", url: nil,
                                  relay: RelayFields(origin: "https://relay.example.test", cezarId: "c", cezarKey: "k", deviceId: "d", port: 0))
        connections.opened(server, path: "/manager")
        expect(connections.quickPath(server) == nil, "no shell, no quick start")
        connections.bundle(server.id)?.put(.shell, "/", headers: shell, body: Bytes.ascii("<html>"))
        expect(connections.quickPath(server) == "/manager", "quick start")
        connections.forgetBundle(server.id)
        expect(connections.quickPath(server) == nil, "forgotten")
    }
}
