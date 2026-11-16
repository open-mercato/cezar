import Foundation

/// The connector already has the list and the normal open PushTap needs.
extension ShellConnector: PushTap.Connector {
    /// The same outcome, landing on `url` instead.
    static func withUrl(_ outcome: Outcome, _ url: String) -> Outcome {
        var copy = outcome
        copy.url = url
        return copy
    }
}
