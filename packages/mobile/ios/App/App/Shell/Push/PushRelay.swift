import Foundation

/// `PushRelay.Answer`: a Swift protocol cannot nest a type.
struct PushRelayAnswer: Equatable {
    let status: Int
    /// The refusal's `code`, or nil.
    let code: String?
    /// Seconds, or -1 without a usable `Retry-After`.
    let retryAfter: Int64
    /// The `Date` header in milliseconds, or -1.
    let date: Int64
    let body: String
}

/// The relay's two push `POST` routes, as a transport: URLSession in the app, a fake in tests.
protocol PushRelay {
    /// Blocks; call it off the main thread.
    func post(url: String, headers: [String: String], body: [UInt8]) throws -> PushRelayAnswer
}

/// URLSession's `POST`, replacing OkHttpPushRelay. Cleartext goes through App Transport Security, as for the socket.
final class URLSessionPushRelay: NSObject, PushRelay, URLSessionTaskDelegate {
    struct Failure: Error {
        let message: String
    }

    static let maxBody = 8192

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        // A signed POST is never resent by the library: GrantClient decides what a retry is.
        config.waitsForConnectivity = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    func post(url: String, headers: [String: String], body: [UInt8]) throws -> PushRelayAnswer {
        guard let target = URL(string: url) else { throw Failure(message: "bad relay url") }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = Data(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let done = DispatchSemaphore(value: 0)
        var result: (Data?, URLResponse?, Error?)
        session.dataTask(with: request) { data, response, error in
            result = (data, response, error)
            done.signal()
        }.resume()
        done.wait()
        // The error may quote the request: say only that it failed.
        guard result.2 == nil, let response = result.1 as? HTTPURLResponse else { throw Failure(message: "relay unreachable") }
        let data = result.0 ?? Data()
        let text = data.count > Self.maxBody ? "" : String(decoding: data, as: UTF8.self)
        return PushRelayAnswer(status: response.statusCode, code: Self.codeOf(text),
                               retryAfter: Self.retryAfter(response.value(forHTTPHeaderField: "Retry-After")),
                               date: Self.date(response.value(forHTTPHeaderField: "Date")), body: text)
    }

    /// No redirects: the proof is bound to this path (§ 3.1).
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    static func codeOf(_ text: String) -> String? {
        guard !text.isEmpty, let body = PushJson.object(text) else { return nil }
        return PushJson.text(body, "code")
    }

    static func retryAfter(_ value: String?) -> Int64 {
        guard let value, (1...9).contains(value.count), value.allSatisfy({ $0.isASCII && $0.isNumber }) else { return -1 }
        return Int64(value) ?? -1
    }

    /// An HTTP-date (RFC 9110 IMF-fixdate) in milliseconds, or -1.
    static func date(_ value: String?) -> Int64 {
        guard let value, let parsed = httpDate.date(from: value) else { return -1 }
        return Int64(parsed.timeIntervalSince1970 * 1000)
    }

    private static let httpDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter
    }()
}
