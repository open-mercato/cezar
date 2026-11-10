import Foundation

/// `HealthProbe`'s tunnel transport. `url` is a path here, since a relay server has no origin to name.
final class TunnelHttpGet: HttpGet {
    private let http: TunnelHttp
    private let queue = DispatchQueue(label: "cezar-tunnel-get", attributes: .concurrent)

    init(sessions: @escaping () -> TunnelSession?) {
        http = TunnelHttp(sessions: sessions)
    }

    /// The tunnel blocks, so it runs off the caller's executor. Repeated headers join with ", " as URLSession's do.
    func get(url: String, headers: [String: String]) async throws -> HttpAnswer {
        let http = self.http
        let answer: TunnelHttp.Answer = try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try http.send(method: "GET", path: url, headers: headers, body: nil) })
            }
        }
        return HttpAnswer(status: answer.status, headers: answer.headers.mapValues { $0.joined(separator: ", ") }, body: answer.body)
    }
}
