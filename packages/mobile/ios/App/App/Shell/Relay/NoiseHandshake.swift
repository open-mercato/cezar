import Foundation

/// Where a handshake's ephemeral keys come from. Production ships only `RandomEphemerals`: the fixed
/// keys the vectors need live in the test target, so no shipped caller can inject one (vectors README).
protocol NoiseEphemerals {
    func next() -> [UInt8]
}

struct RandomEphemerals: NoiseEphemerals {
    func next() -> [UInt8] { RelayCrypto.x25519Secret() }
}

/// Noise revision 34 for 25519_ChaChaPoly_SHA256, patterns `KK`, `XX` and `XXpsk3`. An unaudited state
/// machine, thin over audited primitives (spec QR8); the same shape as generator/noise.mjs.
final class NoiseHandshake {
    struct Keys {
        let send: NoiseCipher
        let receive: NoiseCipher
    }

    struct OutOfTurn: Error {}

    private static let xx = [["e"], ["e", "ee", "s", "es"], ["s", "se"]]
    private static let xxPsk3 = [["e"], ["e", "ee", "s", "es"], ["s", "se", "psk"]]
    private static let kk = [["e", "es", "ss"], ["e", "ee", "se"]]

    private let messages: [[String]]
    private let initiator: Bool
    private let hasPsk: Bool
    private let staticSecret: [UInt8]
    private let staticPublic: [UInt8]
    private let psk: [UInt8]?
    private let ephemerals: NoiseEphemerals
    private(set) var remoteStatic: [UInt8]?
    private var ephemeral: [UInt8]?
    private var remoteEphemeral: [UInt8]?
    private var ck: [UInt8]
    private var h: [UInt8]
    private var cipher = NoiseCipher(nil)
    private var index = 0

    /// `ephemerals` is the vectors' seam; the factories below always pass `RandomEphemerals`.
    init(pattern: String, initiator: Bool, prologue: [UInt8], staticSecret: [UInt8], remoteStatic: [UInt8]?, psk: [UInt8]?,
         ephemerals: NoiseEphemerals) {
        messages = pattern == "KK" ? Self.kk : pattern == "XX" ? Self.xx : Self.xxPsk3
        self.initiator = initiator
        hasPsk = pattern == "XXpsk3"
        self.staticSecret = staticSecret
        staticPublic = RelayCrypto.x25519Public(staticSecret)
        self.remoteStatic = remoteStatic
        self.psk = psk
        self.ephemerals = ephemerals
        let name = Bytes.ascii("Noise_\(pattern)_25519_ChaChaPoly_SHA256")
        ck = name.count <= 32 ? name + [UInt8](repeating: 0, count: 32 - name.count) : RelayCrypto.sha256(name)
        h = ck
        mixHash(prologue)
        if pattern == "KK" {
            mixHash(initiator ? staticPublic : remoteStatic ?? [])
            mixHash(initiator ? remoteStatic ?? [] : staticPublic)
        }
    }

    static func xxpsk3Initiator(prologue: [UInt8], staticSecret: [UInt8], psk: [UInt8]) -> NoiseHandshake {
        NoiseHandshake(pattern: "XXpsk3", initiator: true, prologue: prologue, staticSecret: staticSecret, remoteStatic: nil, psk: psk,
                       ephemerals: RandomEphemerals())
    }

    static func kkInitiator(prologue: [UInt8], staticSecret: [UInt8], remoteStatic: [UInt8]) -> NoiseHandshake {
        NoiseHandshake(pattern: "KK", initiator: true, prologue: prologue, staticSecret: staticSecret, remoteStatic: remoteStatic, psk: nil,
                       ephemerals: RandomEphemerals())
    }

    private init(copying other: NoiseHandshake) {
        messages = other.messages
        initiator = other.initiator
        hasPsk = other.hasPsk
        staticSecret = other.staticSecret
        staticPublic = other.staticPublic
        psk = other.psk
        ephemerals = other.ephemerals
        remoteStatic = other.remoteStatic
        ephemeral = other.ephemeral
        remoteEphemeral = other.remoteEphemeral
        ck = other.ck
        h = other.h
        cipher = other.cipher.copy()
        index = other.index
    }

    /// A reply that fails must leave this state untouched, so the real one can still follow (§ 10).
    func copy() -> NoiseHandshake { NoiseHandshake(copying: self) }

    private func mixHash(_ data: [UInt8]) {
        h = RelayCrypto.sha256(h, data)
    }

    /// Noise's HKDF over HMAC-SHA256, as § 4.3 of the Noise spec writes it.
    private func hkdf(_ ikm: [UInt8], outputs: Int) -> [[UInt8]] {
        let temp = RelayCrypto.hmacSha256(key: ck, ikm)
        var out: [[UInt8]] = []
        var previous: [UInt8] = []
        for i in 1...outputs {
            previous = RelayCrypto.hmacSha256(key: temp, previous, [UInt8(i)])
            out.append(previous)
        }
        return out
    }

    private func mixKey(_ ikm: [UInt8]) {
        let out = hkdf(ikm, outputs: 2)
        ck = out[0]
        cipher = NoiseCipher(out[1])
    }

    private func mixKeyAndHash(_ ikm: [UInt8]) {
        let out = hkdf(ikm, outputs: 3)
        ck = out[0]
        mixHash(out[1])
        cipher = NoiseCipher(out[2])
    }

    private func encryptAndHash(_ plaintext: [UInt8]) throws -> [UInt8] {
        let out = try cipher.encrypt(ad: h, plaintext)
        mixHash(out)
        return out
    }

    private func decryptAndHash(_ ciphertext: [UInt8]) throws -> [UInt8] {
        let out = try cipher.decrypt(ad: h, ciphertext)
        mixHash(ciphertext)
        return out
    }

    private func dh(_ token: String) throws -> [UInt8] {
        let chars = Array(token)
        let initiatorEphemeral = chars[0] == "e"
        let responderEphemeral = chars[1] == "e"
        let mineEphemeral = initiator ? initiatorEphemeral : responderEphemeral
        let theirsEphemeral = initiator ? responderEphemeral : initiatorEphemeral
        guard let mine = mineEphemeral ? ephemeral : staticSecret, let theirs = theirsEphemeral ? remoteEphemeral : remoteStatic else {
            throw RelayCrypto.DecryptFailure(message: "missing key")
        }
        return try RelayCrypto.x25519(mine, theirs)
    }

    private var writing: Bool { (index % 2 == 0) == initiator }

    func writeMessage(_ payload: [UInt8]) throws -> [UInt8] {
        guard index < messages.count, writing else { throw OutOfTurn() }
        var out: [UInt8] = []
        for token in messages[index] {
            switch token {
            case "e":
                let secret = ephemerals.next()
                ephemeral = secret
                let pub = RelayCrypto.x25519Public(secret)
                out += pub
                mixHash(pub)
                if hasPsk { mixKey(pub) }
            case "s":
                out += try encryptAndHash(staticPublic)
            case "psk":
                mixKeyAndHash(psk ?? [])
            default:
                mixKey(try dh(token))
            }
        }
        out += try encryptAndHash(payload)
        index += 1
        return out
    }

    func readMessage(_ message: [UInt8]) throws -> [UInt8] {
        guard index < messages.count, !writing else { throw OutOfTurn() }
        var at = 0
        for token in messages[index] {
            switch token {
            case "e":
                if message.count - at < 32 { throw RelayCrypto.DecryptFailure(message: "message too short") }
                let key = Array(message[at..<at + 32])
                remoteEphemeral = key
                at += 32
                mixHash(key)
                if hasPsk { mixKey(key) }
            case "s":
                let length = cipher.hasKey ? 48 : 32
                if message.count - at < length { throw RelayCrypto.DecryptFailure(message: "message too short") }
                remoteStatic = try decryptAndHash(Array(message[at..<at + length]))
                at += length
            case "psk":
                mixKeyAndHash(psk ?? [])
            default:
                mixKey(try dh(token))
            }
        }
        let payload = try decryptAndHash(Array(message[at...]))
        index += 1
        return payload
    }

    var handshakeHash: [UInt8] { h }

    var done: Bool { index == messages.count }

    /// First key carries initiator to responder.
    func split() throws -> Keys {
        guard done else { throw OutOfTurn() }
        let out = hkdf([], outputs: 2)
        let first = NoiseCipher(out[0])
        let second = NoiseCipher(out[1])
        return initiator ? Keys(send: first, receive: second) : Keys(send: second, receive: first)
    }
}
