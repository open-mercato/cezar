import Foundation

/// Whether the lock is on, as an empty file's presence: nothing here can hold a secret (spec QR3).
struct LockSetting {
    struct Failure: Error, LocalizedError {
        var errorDescription: String? { "Could not save the lock setting" }
    }

    private let file: URL

    init(directory: URL) {
        file = directory.appendingPathComponent("app-lock-on")
    }

    func enabled() -> Bool {
        FileManager.default.fileExists(atPath: file.path)
    }

    func set(_ enabled: Bool) throws {
        let manager = FileManager.default
        if enabled {
            try? manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            _ = manager.createFile(atPath: file.path, contents: Data())
            if !manager.fileExists(atPath: file.path) { throw Failure() }
        } else {
            try? manager.removeItem(at: file)
            if manager.fileExists(atPath: file.path) { throw Failure() }
        }
    }
}
