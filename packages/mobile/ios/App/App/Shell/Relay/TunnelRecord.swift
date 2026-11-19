import Foundation

/// The padded plaintext of RELAY_PROTOCOL.md § 11, and the sizes that follow from `frameBytes` (§ 8).
enum TunnelRecord {
    struct Malformed: Error, Equatable {
        let message: String
        init(_ message: String) { self.message = message }
    }

    static let unit = 256

    static func pad(_ content: [UInt8]) -> [UInt8] {
        precondition(content.count <= 0xffff, "content over 65535 bytes")
        let length = max(unit, (content.count + 2 + unit - 1) / unit * unit)
        var record = [UInt8](repeating: 0, count: length)
        record[0] = UInt8(truncatingIfNeeded: content.count >> 8)
        record[1] = UInt8(truncatingIfNeeded: content.count)
        record.replaceSubrange(2..<2 + content.count, with: content)
        return record
    }

    static func unpad(_ record: [UInt8]) throws -> [UInt8] {
        if record.isEmpty || record.count % unit != 0 { throw Malformed("record length") }
        let length = (Int(record[0]) << 8) | Int(record[1])
        if length + 2 > record.count { throw Malformed("content length") }
        for i in (2 + length)..<record.count where record[i] != 0 { throw Malformed("padding") }
        return Array(record[2..<2 + length])
    }

    static func maxCiphertext(_ frameBytes: Int) -> Int { min(65535, frameBytes - 17) }
    static func maxRecord(_ frameBytes: Int) -> Int { (maxCiphertext(frameBytes) - 16) / unit * unit }
    static func maxContent(_ frameBytes: Int) -> Int { maxRecord(frameBytes) - 2 }
    static func maxData(_ frameBytes: Int) -> Int { maxRecord(frameBytes) - 7 }
}
