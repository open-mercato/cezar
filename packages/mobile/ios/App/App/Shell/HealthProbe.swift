import Foundation

/// A GET that never follows a redirect and never reuses the webview's session.
protocol HttpGet {
    func get(url: String, headers: [String: String]) async throws -> HttpAnswer
}

final class PlatformHttpGet: NSObject, HttpGet, URLSessionTaskDelegate {
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func get(url: String, headers: [String: String]) async throws -> HttpAnswer {
        guard url.hasPrefix("https://"), let target = URL(string: url) else { throw URLError(.badURL) }
        var request = URLRequest(url: target)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var lower: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { lower[name.lowercased()] = value }
        }
        return HttpAnswer(status: http.statusCode, headers: lower, body: String(decoding: data.prefix(256 * 1024), as: UTF8.self))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Reads a server's health natively, before any page loads (spec "In the shell").
struct HealthProbe {
    let http: HttpGet
    let userAgent: String

    private static let tlsErrors: Set<URLError.Code> = [
        .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
        .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
        .clientCertificateRequired,
    ]

    func probe(_ origin: ServerOrigin, username: String?, password: String?, cookies: String?) async -> HealthAnswer {
        var headers = ["Accept": "application/json", "User-Agent": userAgent]
        if let password { headers["Authorization"] = "Basic " + Data("\(username ?? ""):\(password)".utf8).base64EncodedString() }
        if let cookies, !cookies.isEmpty { headers["Cookie"] = cookies }
        do {
            return HealthClassifier.classify(try await http.get(url: origin.url("/api/v1/health"), headers: headers))
        } catch let error as URLError where Self.tlsErrors.contains(error.code) {
            return HealthAnswer(kind: .tlsFailure, status: 0)
        } catch {
            return HealthAnswer(kind: .unreachable, status: 0)
        }
    }
}
