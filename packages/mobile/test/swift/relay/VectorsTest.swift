import Foundation

/// Every file in test-vectors/relay, read in place so a copy cannot drift (RELAY_PROTOCOL.md § 17).
func vectorsTests() {
    var exercised: Set<String> = []
    func load(_ name: String) -> [String: Any] {
        exercised.insert(name)
        return vectors(name)
    }

    test("proofs") {
        let file = load("proof.json")
        let sockets = rows(file["sockets"])
        expect(sockets.count == 3, "three socket proofs")
        for row in sockets {
            let seed = hex(row["seed"])
            let key = RelayCrypto.ed25519Public(seed)
            expect(Bytes.base64url(key) == str(row, "key"), "\(str(row, "name")): key")
            expect(RelayIds.id(key) == str(row, "id"), "id")
            let lines = str(row, "proofString").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            expect(RelayIds.socketProof(role: lines[1], roomId: lines[2], deviceId: lines[3], time: Int64(num(row, "time"))) == str(row, "proofString"),
                   "socket proof")
            // CryptoKit signs with randomness: Swift verifies the vector's signature and its own (README).
            expect(RelayCrypto.ed25519Verify(key, Bytes.utf8(str(row, "proofString")), Bytes.fromBase64url(str(row, "sig"))!), "vector sig verifies")
            expect(RelayCrypto.ed25519Verify(key, Bytes.utf8(str(row, "proofString")), Bytes.fromBase64url(RelayIds.sign(seed, str(row, "proofString")))!),
                   "own sig verifies")
        }
        for row in rows(file["posts"]) {
            let seed = hex(row["seed"])
            expect(RelayIds.postProof(path: str(row, "path"), body: Bytes.utf8(str(row, "body")), time: Int64(num(row, "time"))) == str(row, "proofString"),
                   "post proof")
            let key = RelayCrypto.ed25519Public(seed)
            expect(RelayCrypto.ed25519Verify(key, Bytes.utf8(str(row, "proofString")), Bytes.fromBase64url(str(row, "sig"))!), "post sig verifies")
        }
    }

    test("qr accepted and derived") {
        let file = load("qr.json")
        for row in rows(file["accepted"]) {
            for debug in [false, true] {
                let allowed = row[debug ? "debug" : "release"] as! Bool
                do {
                    let secret = try PairSecret.fromQr(str(row, "qr"), debugBuild: debug)
                    expect(allowed, "\(str(row, "qr")) accepted only where allowed")
                    expect(secret.relay.origin == str(row, "relayOrigin") && secret.relay.socketOrigin == str(row, "socketOrigin"), "origins")
                    expect(secret.locator == str(file, "locator") && hex(secret.locatorBytes) == str(file, "locatorHex"), "locator")
                    expect(hex(secret.psk) == str(file, "psk"), "psk")
                    expect(secret.pinnedKey.map(hex) == str(file, "cezarX25519"), "pinned key")
                } catch {
                    expect(!allowed, "\(str(row, "qr")) refused only where not allowed")
                    expect((error as? RelayOrigin.Refused)?.reason == "cleartext", "refused as cleartext")
                }
            }
        }
    }

    test("qr refused") {
        for row in rows(load("qr.json")["refused"]) {
            for debug in [false, true] {
                do {
                    _ = try PairSecret.fromQr(str(row, "qr"), debugBuild: debug)
                    expect(false, "\(str(row, "name")) must be refused")
                } catch {
                    expect((error as? RelayOrigin.Refused)?.reason == str(row, "reason"), "\(str(row, "name")): \(str(row, "reason"))")
                }
            }
        }
    }

    test("codes") {
        let file = load("code.json")
        let relay = try RelayOrigin.parse("https://relay.example.test", debugBuild: false)
        for row in rows(file["cases"]) {
            for input in row["inputs"] as! [String] {
                expect(PairSecret.normalizeCode(input.trimmingCharacters(in: .whitespaces)) == str(row, "code"), "normalizes \(input)")
            }
            let secret = try PairSecret.fromCode(str(row, "code"), relay: relay)
            expect(secret.locator == str(row, "locator") && hex(secret.locatorBytes) == str(row, "locatorHex"), "code locator")
            expect(hex(secret.psk) == str(row, "psk") && secret.pinnedKey == nil, "code psk, no pin")
        }
        for row in rows(file["refused"]) {
            expect(PairSecret.normalizeCode(row["input"] as? String) == nil, "refuses \(str(row, "name"))")
        }
    }

    test("digits") {
        for row in rows(load("sas.json")["cases"]) {
            expect(PairSecret.sasDigits(hex(row["handshakeHash"])) == str(row, "sas"), "sas \(str(row, "sas"))")
        }
    }

    test("pairing handshake, both roles") {
        let file = load("handshake-xxpsk3.json")
        let phone = file["phone"] as! [String: Any]
        let cezar = file["cezar"] as! [String: Any]
        let prologue = hex(file["prologue"])
        let psk = hex(file["psk"])
        let initiator = vectorHandshake("XXpsk3", initiator: true, prologue: prologue, staticSecret: hex(phone["x25519Secret"]), remoteStatic: nil,
                                        psk: psk, ephemeral: hex(phone["ephemeralSecret"]))
        let responder = vectorHandshake("XXpsk3", initiator: false, prologue: prologue, staticSecret: hex(cezar["x25519Secret"]), remoteStatic: nil,
                                        psk: psk, ephemeral: hex(cezar["ephemeralSecret"]))
        for row in rows(file["messages"]) {
            let fromPhone = str(row, "from") == "phone"
            let payload = hex(row["payload"])
            let message = try (fromPhone ? initiator : responder).writeMessage(payload)
            expect(hex(message) == str(row, "message") && message.count == num(row, "bytes"), "message bytes")
            expect("01" + hex(message) == str(row, "frame"), "frame")
            expect(try (fromPhone ? responder : initiator).readMessage(message) == payload, "payload read back")
        }
        expect(hex(initiator.handshakeHash) == str(file, "handshakeHash") && hex(responder.handshakeHash) == str(file, "handshakeHash"), "hash")
        expect(PairSecret.sasDigits(initiator.handshakeHash) == str(file, "sas"), "sas")
        expect(initiator.remoteStatic.map(hex) == str(cezar, "x25519Public") && responder.remoteStatic.map(hex) == str(phone, "x25519Public"), "statics")
        let phoneKeys = try initiator.split()
        let cezarKeys = try responder.split()
        expect(RelayIds.id(RelayCrypto.ed25519Public(hex(cezar["ed25519Seed"]))) == str(cezar, "cezarId"), "cezar id")
        expect(RelayIds.id(RelayCrypto.ed25519Public(hex(phone["ed25519Seed"]))) == str(phone, "deviceId"), "device id")
        let transportKeys = file["transportKeys"] as! [String: Any]
        expect(try phoneKeys.send.encrypt([]) == NoiseCipher(hex(transportKeys["phoneToCezar"])).encrypt([]), "phoneToCezar is the first split key")
        let toPhone = hex(transportKeys["cezarToPhone"])
        let after = file["afterHandshake"] as! [String: Any]
        let pending = after["pending"] as! [String: Any]
        expect(hex(try cezarKeys.send.encrypt(hex(pending["record"]))) == str(pending, "ciphertext"), "pending sealed")
        expect(text(try TunnelRecord.unpad(phoneKeys.receive.decrypt(hex(pending["ciphertext"])))) == str(pending, "text"), "pending read")
        for row in rows(after["failuresWithoutPending"]) {
            expect(num(row, "nonce") == 0, "failures at nonce 0")
            expect(text(try TunnelRecord.unpad(NoiseCipher(toPhone).decrypt(hex(row["ciphertext"])))) == str(row, "text"), "failure text")
        }
        for row in rows(after["outcomesAtNonce1"]) {
            let nonce = UInt64(num(row, "nonce"))
            expect(hex(try NoiseCipher(toPhone, nonce: nonce).encrypt(hex(row["record"]))) == str(row, "ciphertext"), "outcome sealed")
            expect(text(try TunnelRecord.unpad(NoiseCipher(toPhone, nonce: nonce).decrypt(hex(row["ciphertext"])))) == str(row, "text"), "outcome read")
        }
    }

    test("session transcript") {
        let file = load("session-kk.json")
        let phone = file["phone"] as! [String: Any]
        let cezar = file["cezar"] as! [String: Any]
        let prologue = hex(file["prologue"])
        expect(hex(Bytes.ascii("cezar-session-v1") + Bytes.fromBase64url(str(file, "cezarId"))! + Bytes.fromBase64url(str(file, "deviceId"))!)
               == str(file, "prologue"), "prologue")
        let initiator = vectorHandshake("KK", initiator: true, prologue: prologue, staticSecret: hex(phone["x25519Secret"]),
                                        remoteStatic: hex(cezar["x25519Public"]), psk: nil, ephemeral: hex(phone["ephemeralSecret"]))
        let responder = vectorHandshake("KK", initiator: false, prologue: prologue, staticSecret: hex(cezar["x25519Secret"]),
                                        remoteStatic: hex(phone["x25519Public"]), psk: nil, ephemeral: hex(cezar["ephemeralSecret"]))
        let first = file["first"] as! [String: Any]
        let second = file["second"] as! [String: Any]
        let message = try initiator.writeMessage([])
        expect(hex(message) == str(first, "message") && message.count == 48, "first message")
        expect("01" + hex(message) == str(first, "phoneToRelay"), "first frame")
        expect(try responder.readMessage(message).isEmpty, "empty payload")
        let reply = try responder.writeMessage(hex(second["payload"]))
        expect(hex(reply) == str(second, "message") && "01" + hex(reply) == str(second, "relayToPhone"), "reply")
        expect(text(try TunnelRecord.unpad(initiator.readMessage(reply))) == str(second, "payloadText"), "reply payload")
        expect(hex(initiator.handshakeHash) == str(file, "handshakeHash"), "hash")
        let phoneKeys = try initiator.split()
        let cezarKeys = try responder.split()
        for row in rows(file["transcript"]) {
            let fromPhone = str(row, "from") == "phone"
            let record = hex(row["record"])
            expect(hex(try TunnelRecord.unpad(record)) == str(row, "content"), "\(str(row, "name")): content")
            expect(hex(TunnelRecord.pad(hex(row["content"]))) == str(row, "record"), "\(str(row, "name")): record")
            let sender = fromPhone ? phoneKeys.send : cezarKeys.send
            expect(sender.nonce == UInt64(num(row, "nonce")), "nonce")
            let sealed = try sender.encrypt(record)
            expect(hex(sealed) == str(row, "ciphertext"), "\(str(row, "name")): ciphertext")
            expect(try (fromPhone ? cezarKeys.receive : phoneKeys.receive).decrypt(sealed) == record, "decrypts")
            _ = try TunnelFrame.parse(hex(row["content"]))
        }
    }

    test("frames") {
        let file = load("frames.json")
        expect(Bytes.base64url(hex(file["deviceIdHex"])) == str(file, "deviceId"), "device id")
        expect(hex([1] + hex(file["ciphertext"])) == str(file["data"] as! [String: Any], "phoneToRelay"), "data frame")
    }

    test("tunnel frames") {
        let file = load("tunnel-frames.json")
        for row in rows(file["frames"]) {
            let content = hex(row["content"])
            let frame = try TunnelFrame.parse(content)
            expect(hex(TunnelRecord.pad(content)) == str(row, "record"), "\(str(row, "name")): record")
            expect(hex(try rebuild(frame, row["fields"] as! [String: Any])) == str(row, "content"), "\(str(row, "name")): rebuilt")
        }
        for row in rows(file["padding"]) {
            let record = TunnelRecord.pad([UInt8](repeating: 0xab, count: num(row, "contentLength")))
            expect(record.count == num(row, "recordLength") && hex(RelayCrypto.sha256(record)) == str(row, "recordSha256"), "padding")
        }
        for row in rows(file["limits"]) {
            let frameBytes = num(row, "frameBytes")
            expect(TunnelRecord.maxCiphertext(frameBytes) == num(row, "maxCiphertext") && TunnelRecord.maxRecord(frameBytes) == num(row, "maxRecord")
                   && TunnelRecord.maxContent(frameBytes) == num(row, "maxContent") && TunnelRecord.maxData(frameBytes) == num(row, "maxData"), "limits")
        }
        let chunking = file["chunking"] as! [String: Any]
        var left = num(chunking, "bodyBytes")
        let maxData = TunnelRecord.maxData(num(chunking, "frameBytes"))
        for chunk in chunking["chunks"] as! [Int] {
            expect(chunk == min(left, maxData), "chunk")
            left -= min(left, maxData)
        }
        expect(left == 0, "chunks cover the body")
    }

    test("rekey") {
        let file = load("rekey.json")
        var send: NoiseCipher?
        var key = ""
        for row in rows(file["steps"]) {
            if send == nil {
                key = str(row, "key")
                send = NoiseCipher(hex(key))
            } else if key != str(row, "key") {
                send!.rekey()
                key = str(row, "key")
            }
            expect(send!.nonce == UInt64(num(row, "nonce")), "\(str(row, "name")): nonce carries on")
            expect(hex(try send!.encrypt(hex(row["record"]))) == str(row, "ciphertext"), "\(str(row, "name")): ciphertext")
        }
        let other = file["otherDirection"] as! [String: Any]
        expect(hex(try NoiseCipher(hex(other["key"]), nonce: UInt64(num(other, "nonce"))).encrypt(hex(other["record"]))) == str(other, "ciphertext"),
               "other direction")
    }

    test("negative transport") {
        let file = load("negative.json")
        for row in rows(file["transport"]) {
            let receive = NoiseCipher(hex(row["key"]))
            var failed = false
            for step in rows(row["deliver"]) {
                do {
                    _ = try receive.decrypt(hex(step["ciphertext"]))
                    expect(str(step, "expect") != "fail", "\(str(row, "name")): must fail here")
                } catch {
                    expect(str(step, "expect") == "fail", "\(str(row, "name")): must not fail here")
                    failed = true
                    break
                }
            }
            expect(failed, "\(str(row, "name")) fails")
        }
        let after = file["afterRekey"] as! [String: Any]
        expect(throwsError { _ = try NoiseCipher(hex(after["key"]), nonce: UInt64(num(after, "nonce"))).decrypt(hex(after["ciphertext"])) },
               str(after, "name"))
    }

    test("negative handshakes") {
        let file = load("negative.json")
        let pair = vectors("handshake-xxpsk3.json")
        let session = vectors("session-kk.json")
        for row in rows(file["handshake"]) {
            let name = str(row, "name")
            if row["pinned"] != nil {
                expect(!Bytes.constantTimeEqual(hex(row["pinned"]), hex(row["receivedStatic"])), name)
            } else if str(row, "pattern") == "KK" {
                let message = hex(row["message"])
                let cezar = session["cezar"] as! [String: Any]
                let phone = session["phone"] as! [String: Any]
                let responder = vectorHandshake("KK", initiator: false, prologue: hex(session["prologue"]), staticSecret: hex(cezar["x25519Secret"]),
                                                remoteStatic: hex(phone["x25519Public"]), psk: nil, ephemeral: hex(cezar["ephemeralSecret"]))
                // The 48-byte rule is what refuses a KK first message with a payload.
                expect(message.count != 48 || throwsError { _ = try responder.readMessage(message) }, name)
            } else {
                let cezar = pair["cezar"] as! [String: Any]
                let responder = vectorHandshake("XXpsk3", initiator: false, prologue: hex(pair["prologue"]), staticSecret: hex(cezar["x25519Secret"]),
                                                remoteStatic: nil, psk: hex(pair["psk"]), ephemeral: hex(cezar["ephemeralSecret"]))
                for before in row["messagesBefore"] as! [String] { _ = try responder.readMessage(hex(before)) }
                _ = try responder.writeMessage([])
                expect(throwsError { _ = try responder.readMessage(hex(row["message"])) }, name)
            }
        }
    }

    test("negative records and frames") {
        let file = load("negative.json")
        for row in rows(file["record"]) { expect(throwsError { _ = try TunnelRecord.unpad(hex(row["record"])) }, "record: \(str(row, "name"))") }
        for row in rows(file["tunnel"]) { expect(throwsError { _ = try TunnelFrame.parse(hex(row["content"])) }, "tunnel: \(str(row, "name"))") }
    }

    test("published Noise vectors") {
        let list = rows(load("noise-published/vectors.json")["vectors"])
        expect(list.count == 5, "five published vectors")
        expect(list.contains { str($0, "protocol_name").contains("XXpsk3") }, "XXpsk3 among them")
        for row in list {
            let pattern = str(row, "protocol_name").split(separator: "_")[1]
            let prologue = hex(row["init_prologue"])
            let psks = row["init_psks"] as? [String] ?? []
            let psk = psks.first.map { hex($0) }
            let initiator = vectorHandshake(String(pattern), initiator: true, prologue: prologue, staticSecret: hex(row["init_static"]),
                                            remoteStatic: (row["init_remote_static"] as? String).map { hex($0) }, psk: psk, ephemeral: hex(row["init_ephemeral"]))
            let responder = vectorHandshake(String(pattern), initiator: false, prologue: prologue, staticSecret: hex(row["resp_static"]),
                                            remoteStatic: (row["resp_remote_static"] as? String).map { hex($0) }, psk: psk, ephemeral: hex(row["resp_ephemeral"]))
            let messages = rows(row["messages"])
            let handshakeMessages = pattern == "KK" ? 2 : 3
            var initiatorKeys: NoiseHandshake.Keys?
            var responderKeys: NoiseHandshake.Keys?
            for (i, message) in messages.enumerated() {
                let payload = hex(message["payload"])
                let fromInitiator = i % 2 == 0
                let wire: [UInt8]
                if i < handshakeMessages {
                    wire = try (fromInitiator ? initiator : responder).writeMessage(payload)
                    expect(try (fromInitiator ? responder : initiator).readMessage(wire) == payload, "payload")
                    if i == handshakeMessages - 1 {
                        initiatorKeys = try initiator.split()
                        responderKeys = try responder.split()
                        if let hash = row["handshake_hash"] as? String { expect(hex(initiator.handshakeHash) == hash, "published hash") }
                    }
                } else {
                    wire = try (fromInitiator ? initiatorKeys!.send : responderKeys!.send).encrypt(payload)
                    expect(try (fromInitiator ? responderKeys!.receive : initiatorKeys!.receive).decrypt(wire) == payload, "transport payload")
                }
                expect(hex(wire) == str(message, "ciphertext"), "\(str(row, "protocol_name")) message \(i)")
            }
        }
    }

    test("strict base64url") {
        expect(Bytes.fromBase64url("YQ==") == nil && Bytes.fromBase64url("Y+/a") == nil && Bytes.fromBase64url("YR") == nil, "refused")
        expect(Bytes.fromBase64url("YQ") == [0x61] && Bytes.fromBase64url("YQ", length: 2) == nil && Bytes.base64url([0x61]) == "YQ", "accepted")
    }

    // Every shared vector file is read: a new one fails here until a test reads it.
    let dir = URL(fileURLWithPath: "../../test-vectors/relay")
    let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    for name in files where name.hasSuffix(".json") {
        expect(exercised.contains(name), "vector file \(name) is exercised")
    }
    expect(exercised.contains("noise-published/vectors.json"), "noise-published is exercised")
    print("vectors exercised: \(exercised.sorted().joined(separator: ", "))")
}

private func rebuild(_ frame: TunnelFrame, _ fields: [String: Any]) throws -> [UInt8] {
    let headers = (fields["headers"] as? [[String]] ?? []).map { TunnelFrame.Header(name: $0[0], value: $0[1]) }
    switch frame.type {
    case TunnelFrame.HELLO: return TunnelFrame.hello(min: num(fields, "min"), max: num(fields, "max"))
    case TunnelFrame.OPEN: return try TunnelFrame.open(stream: num(fields, "stream"), method: str(fields, "method"), target: str(fields, "target"), headers: headers)
    case TunnelFrame.HEAD: return try TunnelFrame.head(stream: num(fields, "stream"), status: num(fields, "status"), headers: headers)
    case TunnelFrame.DATA: return TunnelFrame.data(stream: num(fields, "stream"), hex(fields["data"]))
    case TunnelFrame.END: return TunnelFrame.end(stream: num(fields, "stream"))
    case TunnelFrame.RESET: return TunnelFrame.reset(stream: num(fields, "stream"), code: num(fields, "code"))
    case TunnelFrame.WINDOW: return TunnelFrame.window(stream: num(fields, "stream"), increment: num(fields, "increment"))
    case TunnelFrame.LEASE: return TunnelFrame.lease()
    case TunnelFrame.REKEY: return TunnelFrame.rekey()
    default: return TunnelFrame.close(code: num(fields, "code"))
    }
}
