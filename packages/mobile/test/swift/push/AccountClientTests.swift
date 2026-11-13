import Foundation

/// AccountClientTest: RELAY_PROTOCOL.md § 18, the phone's three calls and the reminder they feed.
func accountClientTest() {
    let now: Int64 = 1_800_000_000_000
    let origin = "https://relay.example.test"
    let cezar = "AAAAAAAAAAAAAAAAAAAAAA"
    let pending = "{\"account\":\"a1\",\"status\":{\"state\":\"pending\",\"email\":\"me@example.test\",\"termsVersion\":\"2026-11-13\",\"acceptedAt\":1,\"confirmedAt\":null,\"graceEndsAt\":2,\"secondsLeft\":170000}}"

    // statusIsSignedByTheDeviceKeyAndNamesCezarAndDevice
    do {
        let relay = FakeRelay()
        let client = AccountClient(relay: relay, clock: { now })
        let keys = DeviceKeys.generate()
        relay.answer(200, pending)
        let status = try? client.status(origin: origin, keys: keys, cezarId: cezar)
        expect(status == AccountClient.Status(state: "pending", email: "me@example.test", secondsLeft: 170000), "pending status")
        let sent = relay.sent[0]
        expect(sent.url == origin + "/v1/accounts/status", "status url")
        expect(text(sent.body) == "{\"cezar\":\"\(cezar)\",\"device\":\"\(keys.deviceId())\"}", "status body")
        let publicKey = Bytes.fromBase64url(sent.headers["X-Cezar-Relay-Key"], length: 32) ?? []
        expect(RelayIds.id(publicKey) == keys.deviceId(), "signed by the device key")
        let proof = "cezar-relay-post-v1\n/v1/accounts/status\n\(Bytes.hex(RelayCrypto.sha256(sent.body)))\n-\n\(now / 1000)"
        let signature = Bytes.fromBase64url(sent.headers["X-Cezar-Relay-Sig"], length: 64) ?? []
        expect(RelayCrypto.ed25519Verify(publicKey, Bytes.utf8(proof), signature), "the signature verifies")
    }
    // aPhoneGetsTheEmailMaskedAndShowsItAsIs
    do {
        let relay = FakeRelay()
        relay.answer(200, pending.replacingOccurrences(of: "me@example.test", with: "p***@gmail.com"))
        let status = try? AccountClient(relay: relay, clock: { now }).status(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar)
        expect(status?.email == "p***@gmail.com", "masked email kept as sent")
    }
    // confirmSendsTheCodeWithNoProof
    do {
        let relay = FakeRelay()
        let client = AccountClient(relay: relay, clock: { now })
        relay.answer(200, "{\"status\":{\"state\":\"confirmed\",\"email\":\"me@example.test\",\"termsVersion\":\"2026-11-13\",\"acceptedAt\":1,\"confirmedAt\":3,\"graceEndsAt\":null,\"secondsLeft\":null}}")
        let status = try? client.confirm(origin: origin, cezarId: cezar, code: "123456")
        expect(status?.state == "confirmed" && status?.secondsLeft == -1, "confirmed")
        expect(text(relay.sent[0].body) == "{\"cezar\":\"\(cezar)\",\"code\":\"123456\"}", "confirm body")
        expect(relay.sent[0].headers["X-Cezar-Relay-Sig"] == nil, "no proof")
    }
    // refusalsCarryTheRelaysCodeAndAPlainMessage
    do {
        let relay = FakeRelay()
        let client = AccountClient(relay: relay, clock: { now })
        for (status, code, words) in [(400, "bad-code", "That code is wrong"), (410, "code-expired", "expired"), (429, "rate-limited", "Too many"),
                                      (404, "no-account", "no email set up"), (409, "already-confirmed", "already confirmed")] {
            relay.answer(status, "{\"code\":\"\(code)\"}")
            do {
                _ = try client.confirm(origin: origin, cezarId: cezar, code: "000000")
                expect(false, code)
            } catch let failure as AccountClient.Failure {
                expect(failure.code == code, "code \(code)")
                expect(AccountClient.message(failure).contains(words), "message for \(code)")
            } catch {
                expect(false, "\(code) threw something else")
            }
        }
        do {
            _ = try client.resend(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar)
            expect(false, "offline")
        } catch let failure as AccountClient.Failure {
            expect(failure.code == "unreachable", "offline is unreachable")
        } catch {
            expect(false, "offline threw something else")
        }
    }
    // theReminderShowsOnlyWhilePending
    expect(AccountReminder.text(AccountClient.Status(state: "pending", email: "me@example.test", secondsLeft: 47 * 3600 + 5))
        == "Confirm your computer's email within 47 h to keep this phone connected.", "reminder text")
    expect(AccountReminder.timeLeft(3 * 3600 + 20 * 60) == "3 h 20 min", "hours and minutes")
    expect(AccountReminder.text(AccountClient.Status(state: "confirmed", email: nil, secondsLeft: -1)) == nil, "no reminder once confirmed")
    expect(AccountReminder.text(AccountClient.Status(state: "blocked", email: nil, secondsLeft: 0)) == nil, "no reminder when blocked")
    expect(AccountReminder.text(nil) == nil, "no reminder without a status")
}
