import Foundation

/// Where a device switch lands on the other computer.
enum DeviceLanding {
    static let manager = "/manager"
    static let tasks = "/tasks"

    /// The same kind of page: Manager stays Manager, anything else is the global Tasks page, as project
    /// ids differ across computers. A target without Manager (its start path is not "/manager") gets Tasks.
    static func path(currentPath: String?, startPath: String?) -> String {
        guard isManager(currentPath) else { return tasks }
        if let startPath, !isManager(startPath) { return tasks }
        return manager
    }

    /// The path of a whole URL, or the path itself.
    static func pathOf(_ urlOrPath: String?) -> String? {
        guard let urlOrPath else { return nil }
        if urlOrPath.hasPrefix("/") { return urlOrPath }
        guard let parts = URLComponents(string: urlOrPath), parts.scheme != nil else { return nil }
        return parts.path.isEmpty ? "/" : parts.path
    }

    /// "/manager" itself or below it, never "/managers".
    private static func isManager(_ path: String?) -> Bool {
        guard let path, path.hasPrefix(manager) else { return false }
        guard let next = path.dropFirst(manager.count).first else { return true }
        return next == "/" || next == "?" || next == "#"
    }
}
