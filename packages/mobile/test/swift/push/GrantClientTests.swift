import Foundation

/// GrantClientTest: RELAY_PROTOCOL.md §§ 3.1 and 7, as the phone sends them.
func grantClientTest() {
    let now: Int64 = 1_800_000_000_000
    let origin = "https://relay.example.test"
    func world() -> (FakeRelay, GrantClient, DeviceKeys, (Int64) -> Void) {
        let relay = FakeRelay()
        var clock = now
        let client = GrantClient(relay: relay, clock: { clock })
        return (relay, client, DeviceKeys.generate(), { clock = $0 })
    }
    func verify(_ key: String?, _ proof: String, _ sig: String?) -> Bool {
        guard let publicKey = Bytes.fromBase64url(key, length: 32), let signature = Bytes.fromBase64url(sig, length: 64) else { return false }
        return RelayCrypto.ed25519Verify(publicKey, Bytes.utf8(proof), signature)
    }

    // theGrantBodyHasExactlyTheThreeKeys
    do {
        let (relay, client, keys, _) = world()
        relay.answer(200, FakeRelay.grant(grantIdFixture, 1_807_776_000))
        _ = try? client.obtain(origin: origin, keys: keys, token: "apns-token-1", cezarKey: cezarKeyFixture)
        let sent = relay.sent[0]
        expect(sent.url == "https://relay.example.test/v1/push-grants", "grant url")
        expect(text(sent.body) == "{\"platform\":\"ios\",\"token\":\"apns-token-1\",\"cezarKey\":\"\(cezarKeyFixture)\"}", "grant body bytes")
        expect(Set((PushJson.object(text(sent.body)) ?? [:]).keys) == ["platform", "token", "cezarKey"], "exactly the three keys")
        expect(sent.headers["Content-Type"] == "application/json", "content type")
        expect(text(GrantClient.grantBody(token: "a\"b\\c/d", cezarKey: "k")) == "{\"platform\":\"ios\",\"token\":\"a\\\"b\\\\c/d\",\"cezarKey\":\"k\"}",
               "the token is quoted as JSON")
    }
    // theSignatureVerifiesAgainstThePostProofString
    do {
        let (relay, client, keys, _) = world()
        relay.answer(200, FakeRelay.grant(grantIdFixture, 1_807_776_000))
        _ = try? client.obtain(origin: origin, keys: keys, token: "tok", cezarKey: cezarKeyFixture)
        let sent = relay.sent[0]
        let publicKey = Bytes.fromBase64url(sent.headers["X-Cezar-Relay-Key"], length: 32) ?? []
        expect(RelayIds.id(publicKey) == keys.deviceId(), "the key header is this server's device key")
        expect(sent.headers["X-Cezar-Relay-Time"] == String(now / 1000), "unix seconds")
        let proof = "cezar-relay-post-v1\n/v1/push-grants\n\(Bytes.hex(RelayCrypto.sha256(sent.body)))\n-\n\(now / 1000)"
        expect(verify(sent.headers["X-Cezar-Relay-Key"], proof, sent.headers["X-Cezar-Relay-Sig"]), "signature verifies")
        expect(!verify(sent.headers["X-Cezar-Relay-Key"], proof.replacingOccurrences(of: "/v1/push-grants", with: "/v1/push"),
                       sent.headers["X-Cezar-Relay-Sig"]), "bound to the path")
    }
    // The shared vectors: proof.json's `posts`, the same bytes the relay and cezar check.
    do {
        let url = URL(fileURLWithPath: "../../test-vectors/relay/proof.json")
        let root = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        let posts = root?["posts"] as? [[String: Any]] ?? []
        expect(posts.count >= 2, "proof.json has the push posts")
        for post in posts {
            guard let seedHex = post["seed"] as? String, let seed = Bytes.fromHex(seedHex), let path = post["path"] as? String,
                  let body = post["body"] as? String, let time = (post["time"] as? NSNumber)?.int64Value else {
                expect(false, "vector shape")
                continue
            }
            let keys = DeviceKeys(ed25519Seed: seed, x25519Secret: [UInt8](repeating: 1, count: 32))
            let headers = GrantClient.proofHeaders(keys, path: path, body: Bytes.utf8(body), time: time)
            expect(headers["X-Cezar-Relay-Key"] == post["key"] as? String, "\(path): key header")
            expect(keys.deviceId() == post["id"] as? String, "\(path): device id")
            expect(headers["X-Cezar-Relay-Time"] == String(time), "\(path): time header")
            expect(RelayIds.postProof(path: path, body: Bytes.utf8(body), time: time) == post["proofString"] as? String, "\(path): proof string")
            expect(verify(headers["X-Cezar-Relay-Key"], post["proofString"] as? String ?? "", headers["X-Cezar-Relay-Sig"]), "\(path): our signature verifies")
            expect(verify(post["key"] as? String, post["proofString"] as? String ?? "", post["sig"] as? String), "\(path): the vector's signature verifies")
            if path == GrantClient.grantsPath, let fields = PushJson.object(body) {
                let ours = text(GrantClient.grantBody(token: fields["token"] as? String ?? "", cezarKey: fields["cezarKey"] as? String ?? ""))
                expect(ours == body.replacingOccurrences(of: "\"android\"", with: "\"ios\""), "grant body: the vector's shape, platform ios")
            }
            if path == GrantClient.revokePath, let fields = PushJson.object(body) {
                expect(text(GrantClient.revokeBody(grant: fields["grant"] as? String ?? "")) == body, "revoke body: the vector's bytes")
            }
        }
    }
    // theRevokeIsSignedOverItsOwnPathAndBody
    do {
        let (relay, client, keys, _) = world()
        relay.answer(204, "")
        expect(client.revoke(origin: origin, keys: keys, grant: "sealed").outcome == .done, "204 done")
        let sent = relay.sent[0]
        expect(sent.url == "https://relay.example.test/v1/push-grants/revoke", "revoke url")
        expect(text(sent.body) == "{\"grant\":\"sealed\"}", "revoke body")
        let proof = RelayIds.postProof(path: "/v1/push-grants/revoke", body: sent.body, time: now / 1000)
        expect(verify(sent.headers["X-Cezar-Relay-Key"], proof, sent.headers["X-Cezar-Relay-Sig"]), "revoke signature")
    }
    // theRevokeTable
    do {
        let rows: [(Int, GrantClient.Revoke)] = [(204, .done), (400, .stopped), (401, .stopped), (410, .stopped), (429, .retry),
                                                 (503, .retry), (200, .retry), (500, .retry), (404, .retry)]
        for (status, outcome) in rows {
            let answer = GrantClient.classify(PushRelayAnswer(status: status, code: nil, retryAfter: 7, date: -1, body: ""))
            expect(answer.outcome == outcome, "status \(status)")
        }
        expect(GrantClient.classify(PushRelayAnswer(status: 429, code: "rate-limited", retryAfter: 7, date: -1, body: "")).retryAfter == 7, "Retry-After kept")
        let (_, client, keys, _) = world()
        expect(client.revoke(origin: origin, keys: keys, grant: "g").outcome == .retry, "a network failure is retried")
    }
    // a401IsRetriedOnceWithTheRelaysClock
    do {
        let (relay, client, keys, _) = world()
        let relayNow = now + 300_000
        relay.answer(PushRelayAnswer(status: 401, code: "bad-proof", retryAfter: -1, date: relayNow, body: "{\"code\":\"bad-proof\"}"))
        relay.answer(204, "")
        expect(client.revoke(origin: origin, keys: keys, grant: "g").outcome == .done, "401 then 204")
        expect(relay.sent.count == 2, "retried once")
        expect(relay.sent.count > 1 && relay.sent[1].headers["X-Cezar-Relay-Time"] == String(relayNow / 1000), "the relay's clock")
        relay.answer(PushRelayAnswer(status: 401, code: "bad-proof", retryAfter: -1, date: relayNow, body: ""))
            .answer(PushRelayAnswer(status: 401, code: "bad-proof", retryAfter: -1, date: relayNow, body: ""))
        expect(client.revoke(origin: origin, keys: keys, grant: "g").outcome == .stopped, "two 401s stop")
        expect(relay.sent.count == 4, "once, never a loop")
    }
    // aMalformedGrantIsRefused
    do {
        let (relay, client, keys, _) = world()
        for body in ["{}", "{\"grant\":\"g\",\"grantId\":\"short\",\"expiresAt\":1}", "{\"grant\":\"\",\"grantId\":\"\(grantIdFixture)\",\"expiresAt\":1}",
                     "{\"grant\":\"g\",\"grantId\":\"\(grantIdFixture)\",\"expiresAt\":\"1\"}", "nope"] {
            relay.answer(200, body)
            do {
                _ = try client.obtain(origin: origin, keys: keys, token: "tok", cezarKey: cezarKeyFixture)
                expect(false, "refuses \(body)")
            } catch let failure as GrantClient.Failure {
                expect(!failure.message.contains("tok"), "never quotes the token")
            } catch {
                expect(false, "a Failure for \(body)")
            }
        }
    }
    // noRequestWithoutATokenOrWithABadCezarKey
    do {
        let (relay, client, keys, _) = world()
        for (token, key) in [(nil, cezarKeyFixture), ("", cezarKeyFixture), ("tok", "not-a-key"), ("tok", nil),
                             (String(repeating: "t", count: 1025), cezarKeyFixture)] as [(String?, String?)] {
            expect(throwsError { _ = try client.obtain(origin: origin, keys: keys, token: token, cezarKey: key) }, "refused before any request")
        }
        expect(relay.sent.isEmpty, "nothing sent")
    }
    // URLSessionPushRelay's header readers, which OkHttp did for Android.
    expect(URLSessionPushRelay.retryAfter("30") == 30, "Retry-After seconds")
    expect(URLSessionPushRelay.retryAfter("Wed, 21 Oct 2015 07:28:00 GMT") == -1 && URLSessionPushRelay.retryAfter("1234567890") == -1
           && URLSessionPushRelay.retryAfter(nil) == -1 && URLSessionPushRelay.retryAfter("-1") == -1, "unusable Retry-After")
    expect(URLSessionPushRelay.date("Thu, 01 Jan 2026 00:00:00 GMT") == 1_767_225_600_000, "Date in ms")
    expect(URLSessionPushRelay.date("yesterday") == -1, "a bad Date")
    expect(URLSessionPushRelay.codeOf("{\"code\":\"bad-proof\"}") == "bad-proof" && URLSessionPushRelay.codeOf("") == nil, "code")
}
