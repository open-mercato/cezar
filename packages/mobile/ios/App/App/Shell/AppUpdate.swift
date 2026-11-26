import Foundation

/// A new build of the app on the phone (a TestFlight or App Store update). What the old build cached of
/// each cockpit is dropped then, so no start after an update paints from a shell it did not fetch itself.
enum AppUpdate {
    static let key = "cezar.lastBuild"

    /// True once per new build; a first install is not an update.
    static func changed(build: String, defaults: UserDefaults = .standard) -> Bool {
        let last = defaults.string(forKey: key)
        if last == build { return false }
        defaults.set(build, forKey: key)
        return last != nil
    }
}
