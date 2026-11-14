import Foundation

/// Enough of `text/event-stream` for `/workspace/phone/signals` (spec R5, Stage 1): `event` and `data`
/// fields, comments, and a blank line that ends an event. Bytes may arrive split anywhere.
final class SignalParser {
    typealias Events = (_ type: String, _ data: String) -> Void

    /// cezar's events are a few dozen bytes. A longer line spoils its event instead of growing a buffer.
    static let maxLine = 4096

    private let events: Events
    private var line: [UInt8] = []
    private var afterCr = false
    private var overlong = false
    private var broken = false
    private var type = ""
    private var data: String?

    init(_ events: @escaping Events) {
        self.events = events
    }

    func feed(_ bytes: [UInt8]) {
        feed(bytes, offset: 0, length: bytes.count)
    }

    func feed(_ bytes: [UInt8], offset: Int, length: Int) {
        for i in offset..<(offset + length) {
            let b = bytes[i]
            if afterCr {
                afterCr = false
                if b == 0x0A { continue }
            }
            if b == 0x0D {
                afterCr = true
                endLine()
            } else if b == 0x0A {
                endLine()
            } else if line.count < Self.maxLine {
                line.append(b)
            } else {
                overlong = true
            }
        }
    }

    private func endLine() {
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        if overlong {
            overlong = false
            broken = true
            return
        }
        if text.isEmpty {
            dispatch()
            return
        }
        if text.hasPrefix(":") { return }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
        } else {
            field = text[...]
            value = ""
        }
        if value.hasPrefix(" ") { value = value.dropFirst() }
        if field == "event" {
            type = String(value)
        } else if field == "data" {
            data = data.map { $0 + "\n" + value } ?? String(value)
        }
    }

    private func dispatch() {
        let any = data != nil || !type.isEmpty
        let eventType = type.isEmpty ? "message" : type
        let eventData = data ?? ""
        let spoiled = broken
        type = ""
        data = nil
        broken = false
        if any && !spoiled { events(eventType, eventData) }
    }
}
