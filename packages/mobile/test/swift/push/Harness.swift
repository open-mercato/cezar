// The tiny harness of test/swift/shell: no XCTest on the Command Line Tools.
import Foundation

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ name: String, file: String = #fileID, line: Int = #line) {
    checks += 1
    if !condition() {
        failures += 1
        print("FAIL \(file):\(line): \(name)")
    }
}

/// `assertThrows`: true when `work` threw.
func throwsError(_ work: () throws -> Void) -> Bool {
    do {
        try work()
        return false
    } catch {
        return true
    }
}

/// Runs async work to the end from synchronous test code.
func blocking<T>(_ work: @escaping () async -> T) -> T {
    let done = DispatchSemaphore(value: 0)
    var result: T?
    Task {
        result = await work()
        done.signal()
    }
    done.wait()
    return result!
}

func temporaryDirectory() -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cezar-push-" + UUID().uuidString)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

func text(_ bytes: [UInt8]?) -> String { String(decoding: bytes ?? [], as: UTF8.self) }
