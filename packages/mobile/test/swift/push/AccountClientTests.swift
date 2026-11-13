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
    // statusReadsSuspendedAndThisPhonesTermsRecord
    do {
        let relay = FakeRelay()
        let client = AccountClient(relay: relay, clock: { now })
        relay.answer(200, pending)
        let older = try? client.status(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar)
        expect(older?.suspended == false, "suspended defaults to false")
        expect(older != nil && older?.device == nil, "an older relay sends no device")
        relay.answer(200, "{\"status\":{\"state\":\"confirmed\",\"suspended\":true,\"secondsLeft\":-1},"
            + "\"device\":{\"termsVersion\":null,\"acceptedAt\":null,\"graceEndsAt\":3,\"secondsLeft\":100}}")
        let fresh = try? client.status(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar)
        expect(fresh?.suspended == true, "suspended read")
        expect(fresh?.device == AccountClient.Device(termsVersion: nil, acceptedAt: nil), "device not accepted yet")
        relay.answer(200, "{\"status\":{\"state\":\"confirmed\",\"secondsLeft\":-1},\"device\":{\"termsVersion\":\"2026-11-13\",\"acceptedAt\":1800000000}}")
        let accepted = try? client.status(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar)
        expect(accepted?.device == AccountClient.Device(termsVersion: "2026-11-13", acceptedAt: 1_800_000_000), "device accepted")
    }
    // deviceTermsIsSignedAndAcceptsTheVersion
    do {
        let relay = FakeRelay()
        let keys = DeviceKeys.generate()
        relay.answer(200, "{\"device\":{\"termsVersion\":\"2026-11-13\",\"acceptedAt\":1800000000,\"graceEndsAt\":3,\"secondsLeft\":0}}")
        let device = try? AccountClient(relay: relay, clock: { now }).deviceTerms(origin: origin, keys: keys, cezarId: cezar, termsVersion: "2026-11-13")
        expect(device == AccountClient.Device(termsVersion: "2026-11-13", acceptedAt: 1_800_000_000), "accepted device")
        let sent = relay.sent[0]
        expect(sent.url == origin + "/v1/devices/terms", "terms url")
        expect(text(sent.body) == "{\"cezar\":\"\(cezar)\",\"device\":\"\(keys.deviceId())\",\"termsVersion\":\"2026-11-13\",\"accepted\":true}", "terms body")
        let publicKey = Bytes.fromBase64url(sent.headers["X-Cezar-Relay-Key"], length: 32) ?? []
        let proof = "cezar-relay-post-v1\n/v1/devices/terms\n\(Bytes.hex(RelayCrypto.sha256(sent.body)))\n-\n\(now / 1000)"
        let signature = Bytes.fromBase64url(sent.headers["X-Cezar-Relay-Sig"], length: 64) ?? []
        expect(RelayCrypto.ed25519Verify(publicKey, Bytes.utf8(proof), signature), "terms signature verifies")
    }
    // deviceTermsRefusalsKeepTheCurrentVersion
    do {
        let relay = FakeRelay()
        let client = AccountClient(relay: relay, clock: { now })
        relay.answer(409, "{\"code\":\"terms-outdated\",\"current\":\"2026-12-01\"}")
        do {
            _ = try client.deviceTerms(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar, termsVersion: "2026-11-13")
            expect(false, "terms-outdated")
        } catch let failure as AccountClient.Failure {
            expect(failure.code == "terms-outdated" && failure.current == "2026-12-01", "terms-outdated keeps current")
            expect(AccountClient.message(failure).contains("terms changed"), "terms-outdated message")
        } catch {
            expect(false, "terms-outdated threw something else")
        }
        relay.answer(404, "{\"code\":\"no-account\"}")
        do {
            _ = try client.deviceTerms(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar, termsVersion: "2026-11-13")
            expect(false, "no-account")
        } catch let failure as AccountClient.Failure {
            expect(failure.code == "no-account" && failure.current == nil, "no-account has no current")
        } catch {
            expect(false, "no-account threw something else")
        }
    }
    // resendIsSignedAndNamesCezarAndDevice
    do {
        let relay = FakeRelay()
        let keys = DeviceKeys.generate()
        relay.answer(200, "{\"expiresAt\":1800000900}")
        let expires = try? AccountClient(relay: relay, clock: { now }).resend(origin: origin, keys: keys, cezarId: cezar)
        expect(expires == 1_800_000_900, "resend expiry")
        expect(relay.sent[0].url == origin + "/v1/accounts/resend", "resend url")
        expect(text(relay.sent[0].body) == "{\"cezar\":\"\(cezar)\",\"device\":\"\(keys.deviceId())\"}", "resend body")
        expect(relay.sent[0].headers["X-Cezar-Relay-Sig"] != nil, "signed")
    }
    // refusalsCarryTheRelaysCodeAndAPlainMessage
    do {
        let relay = FakeRelay()
        let client = AccountClient(relay: relay, clock: { now })
        for (status, code, words) in [(429, "rate-limited", "Too many"), (404, "no-account", "no email set up"), (409, "already-confirmed", "already confirmed")] {
            relay.answer(status, "{\"code\":\"\(code)\"}")
            do {
                _ = try client.resend(origin: origin, keys: DeviceKeys.generate(), cezarId: cezar)
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
