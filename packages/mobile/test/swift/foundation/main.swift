// The relay foundation (Bytes, RelayCrypto, RelayIds, DeviceKeys) against test-vectors/relay, on macOS.
import Foundation

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ name: String, line: Int = #line) {
    checks += 1
    if !condition() {
        failures += 1
        print("FAIL line \(line): \(name)")
    }
}

func vectors(_ name: String) -> [String: Any] {
    let url = URL(fileURLWithPath: "../../test-vectors/relay/\(name)")
    return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}

func hex(_ text: Any?) -> [UInt8] { Bytes.fromHex(text as! String)! }

// Bytes § 2
expect(Bytes.base64url([0xfb, 0xff]) == "-_8", "url alphabet, no padding")
expect(Bytes.fromBase64url("-_8") == [0xfb, 0xff], "decodes")
for bad in ["-_8=", "+/8", "-_9", "a", "", "ab cd"] { expect(Bytes.fromBase64url(bad) == nil, "refuses \(bad)") }
expect(Bytes.fromBase64url("AAAA", length: 3) == [0, 0, 0] && Bytes.fromBase64url("AAAA", length: 4) == nil, "exact length")

// proof.json: keys, ids, proof strings; CryptoKit signs randomly, so the vector signature verifies
let proofs = vectors("proof.json")
for case let row as [String: Any] in (proofs["sockets"] as! [Any]) + (proofs["posts"] as! [Any]) {
    let name = row["name"] as! String
    let key = RelayCrypto.ed25519Public(hex(row["seed"]))
    expect(Bytes.base64url(key) == row["key"] as? String, "\(name): key")
    expect(RelayIds.id(key) == row["id"] as? String, "\(name): id")
    let proof = row["proofString"] as! String
    expect(RelayCrypto.ed25519Verify(key, Bytes.utf8(proof), Bytes.fromBase64url(row["sig"] as? String)!), "\(name): vector sig verifies")
    let ours = RelayIds.sign(hex(row["seed"]), proof)
    expect(RelayCrypto.ed25519Verify(key, Bytes.utf8(proof), Bytes.fromBase64url(ours)!), "\(name): our sig verifies")
    expect(!RelayCrypto.ed25519Verify(key, Bytes.utf8(proof + "x"), Bytes.fromBase64url(ours)!), "\(name): wrong message fails")
    if let path = row["path"] as? String, let body = row["body"] as? String {
        expect(RelayIds.postProof(path: path, body: Bytes.utf8(body), time: (row["time"] as! NSNumber).int64Value) == proof, "\(name): post proof")
    }
}
let socket = (proofs["sockets"] as! [[String: Any]]).first { ($0["proofString"] as! String).contains("\nphone\n") }
if let socket {
    let lines = (socket["proofString"] as! String).split(separator: "\n").map(String.init)
    expect(RelayIds.socketProof(role: "phone", roomId: lines[2], deviceId: lines[3], time: Int64(lines[4])!) == socket["proofString"] as? String, "phone socket proof")
}

// qr.json § 9.2 HKDF
let qr = vectors("qr.json")
let salt = Bytes.ascii("cezar-relay-pair-salt-v1")
expect(salt.count == 24, "salt is 24 bytes")
expect(RelayCrypto.hkdf(hex(qr["secret"]), salt: salt, info: Bytes.ascii("cezar-pair-locator-v1"), length: 32) == hex(qr["locatorHex"]), "QR locator")
expect(RelayCrypto.hkdf(hex(qr["secret"]), salt: salt, info: Bytes.ascii("cezar-pair-psk-v1"), length: 32) == hex(qr["psk"]), "QR psk")

// code.json § 9.2 PBKDF2
let code = vectors("code.json")
for case let row as [String: Any] in code["cases"] as! [Any] {
    let okm = RelayCrypto.pbkdf2(password: Bytes.ascii(row["code"] as! String), salt: Bytes.ascii(code["salt"] as! String),
                                 iterations: (code["iterations"] as! NSNumber).intValue, length: 64)
    expect(Array(okm[0..<32]) == hex(row["locatorHex"]) && Array(okm[32..<64]) == hex(row["psk"]), "code \(row["code"]!): okm")
}

// X25519 and ChaChaPoly
let a = RelayCrypto.x25519Secret(), b = RelayCrypto.x25519Secret()
expect(try! RelayCrypto.x25519(a, RelayCrypto.x25519Public(b)) == (try! RelayCrypto.x25519(b, RelayCrypto.x25519Public(a))), "X25519 agrees")
expect((try? RelayCrypto.x25519(a, [UInt8](repeating: 0, count: 32))) == nil, "all-zero output refused")
var order8 = [UInt8](repeating: 0, count: 32); order8[0] = 1
expect((try? RelayCrypto.x25519(a, order8)) == nil, "low-order point refused")
let key = RelayCrypto.random(32)
let sealed = RelayCrypto.seal(key: key, counter: 7, ad: [1, 2], plaintext: Bytes.utf8("hello"))
expect(sealed.count == 21, "tag appended")
expect((try? RelayCrypto.open(key: key, counter: 7, ad: [1, 2], ciphertext: sealed)) == Bytes.utf8("hello"), "opens")
expect((try? RelayCrypto.open(key: key, counter: 8, ad: [1, 2], ciphertext: sealed)) == nil, "wrong nonce fails")
expect((try? RelayCrypto.open(key: key, counter: 7, ad: [1], ciphertext: sealed)) == nil, "wrong ad fails")
expect((try? RelayCrypto.open(key: key, counter: 7, ad: [1, 2], ciphertext: Array(sealed.prefix(15)))) == nil, "short fails")
let text = Bytes.utf8("the largest counter before a rekey")
let big = RelayCrypto.seal(key: key, counter: UInt64.max - 1, ad: [], plaintext: text)
expect((try? RelayCrypto.open(key: key, counter: UInt64.max - 1, ad: [], ciphertext: big)) == text, "high counter round-trip")

// DeviceKeys
let keys = DeviceKeys.generate()
expect(DeviceKeys.fromBytes(keys.toBytes()) == keys && DeviceKeys.fromBytes([1, 2]) == nil, "key blob")
expect(keys.deviceId() == RelayIds.id(keys.relayKey()), "device id")
expect(KeychainDeviceKeyStore.safe("6F1C2C1E-0A6B-4B8C-9C55-7C1B2B7B0D11") && !KeychainDeviceKeyStore.safe("../x") && !KeychainDeviceKeyStore.safe(""), "safe ids")

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
