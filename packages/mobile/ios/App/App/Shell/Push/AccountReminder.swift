import Foundation

/// The gentle banner while the computer's relay email waits for confirmation (RELAY_PROTOCOL.md § 18).
enum AccountReminder {
    /// Nil unless pending: a confirmed account needs nothing, a blocked one never reaches a page.
    static func text(_ status: AccountClient.Status?) -> String? {
        guard let status, status.state == "pending" else { return nil }
        let left = status.secondsLeft >= 0 ? " within \(timeLeft(status.secondsLeft))" : ""
        return "Confirm your computer's email\(left) to keep this phone connected."
    }

    /// "47 h", "3 h 20 min", "12 min".
    static func timeLeft(_ seconds: Int64) -> String {
        if seconds < 60 { return "a minute" }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours >= 10 { return "\(hours) h" }
        if hours > 0 { return minutes > 0 ? "\(hours) h \(minutes) min" : "\(hours) h" }
        return "\(minutes) min"
    }
}
