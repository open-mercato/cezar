import Foundation

/// PushCoordinatorTest: the grant's whole life on the phone, with a fake token source, a fake relay and a fake cezar (spec R5 as built).
private let dayMs: Int64 = 24 * 60 * 60 * 1000
private let start: Int64 = 1_800_000_000_000
private let expires: Int64 = start / 1000 + 90 * dayMs / 1000
private let id1 = "AAAAAAAAAAAAAAAAAAAAAA"
private let id2 = "BBBBBBBBBBBBBBBBBBBBBB"
private let relayServer = ServerRecord(id: "r", label: "Laptop", url: nil,
                                       relay: RelayFields(origin: "https://relay.example.test", cezarId: "cezarcezarcezarcezar01", cezarKey: "x25519", deviceId: "device", port: 0))

private final class World {
    let relay = FakeRelay()
    let cezar = FakeCezar()
    let keys = MemoryKeys()
    let tokens = FakeTokens()
    var now = start
    let folder = temporaryDirectory()
    let store: PushStore
    var push: PushCoordinator!

    init() {
        keys.keys["r"] = DeviceKeys.generate()
        store = PushStore(directory: folder)
        var seed: UInt64 = 1
        // A pinned generator, as Java's `new Random(1)`.
        let random: () -> Double = {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(1 << 53)
        }
        push = PushCoordinator(store: store, tokens: tokens, grants: GrantClient(relay: relay, clock: { [unowned self] in self.now }),
                               keys: keys, clock: { [unowned self] in self.now }, random: random)
    }

    func sentBody(_ index: Int) -> String { relay.body(index) }

    func granted() {
        expect(push.setEnabled(relayServer, true), "switch on")
        relay.answer(200, FakeRelay.grant(id1, expires))
        push.sync(relayServer, cezar.api())
    }
}

func pushCoordinatorTest() {
    // withoutApnsTheSwitchAndTheAskStillWorkAndNoGrantIsAttempted
    do {
        let w = World()
        w.tokens.pushAvailable = false
        expect(!w.push.available(), "no APNs")
        expect(w.push.shouldAsk(), "Stage 1 asks after the first pairing too")
        expect(w.push.setEnabled(relayServer, true), "the switch turns on for the signal stream")
        expect(w.push.enabled("r"), "saved on")
        w.push.sync(relayServer, w.cezar.api())
        w.push.onNewToken([relayServer])
        expect(w.cezar.calls.isEmpty, "no cezar call")
        expect(w.relay.sent.isEmpty, "no relay call")
        expect(w.tokens.calls == 0, "no token asked")
        expect(w.push.setEnabled(relayServer, false), "switch off")
        expect(!w.push.enabled("r"), "saved off")
        expect(w.relay.sent.isEmpty, "nothing to revoke without a grant")
        w.push.markAsked()
        expect(!w.push.shouldAsk(), "asked once")
    }
    // aServerWithoutARelayHasNoSwitch
    do {
        let w = World()
        w.tokens.pushAvailable = false
        let manual = ServerRecord(id: "m", label: "Box", url: "https://box.example.com")
        expect(!w.push.setEnabled(manual, true), "no switch")
        expect(!w.push.enabled("m"), "not saved")
    }
    // turningTheSwitchOnOnlySavesItTheNextSessionGetsAndHandsOverTheGrant
    do {
        let w = World()
        expect(w.push.setEnabled(relayServer, true), "on")
        expect(w.relay.sent.isEmpty && w.tokens.calls == 0, "on is only saved")
        w.relay.answer(200, FakeRelay.grant(id1, expires))
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.calls == ["GET /api/v1/workspace/phone/push", "PUT /api/v1/workspace/phone/push"], "GET then PUT")
        expect(w.sentBody(0) == "{\"platform\":\"ios\",\"token\":\"token-1\",\"cezarKey\":\"\(cezarKeyFixture)\"}", "grant body")
        expect(w.cezar.grantId == id1, "cezar holds the grant")
        let saved = w.store.server("r")
        expect(saved.enabled && saved.held && saved.grant?.handedOver == true, "saved handed over")
        w.cezar.calls.removeAll()
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.calls == ["GET /api/v1/workspace/phone/push"], "a held, fresh grant costs one GET")
        expect(w.relay.sent.count == 1, "no new grant")
    }
    // openRenewsOnceUnderThirtyDaysRemain
    do {
        let w = World()
        w.granted()
        w.now = start + 59 * dayMs
        w.push.sync(relayServer, w.cezar.api())
        expect(w.relay.sent.count == 1, "31 days left: nothing")
        w.now = start + 61 * dayMs
        w.relay.answer(200, FakeRelay.grant(id2, expires + 61 * dayMs / 1000)).answer(204, "")
        w.push.sync(relayServer, w.cezar.api())
        expect(w.relay.sent.count == 3, "a grant, then the revoke of the one it replaces")
        expect(w.sentBody(2) == "{\"grant\":\"sealed-\(id1)\"}", "the old grant revoked")
        expect(w.cezar.grantId == id2, "cezar holds the new one")
        expect(w.store.server("r").grant?.grantId == id2, "saved the new one")
    }
    // cezarHoldingNoGrantGetsAFreshOne
    do {
        let w = World()
        w.granted()
        w.cezar.grantId = nil
        w.relay.answer(200, FakeRelay.grant(id2, expires))
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.grantId == id2, "a fresh grant")
    }
    // aNewTokenGetsANewGrantAndTheNextOpenHandsItOver
    do {
        let w = World()
        w.granted()
        w.cezar.calls.removeAll()
        w.tokens.value = "token-2"
        w.relay.answer(200, FakeRelay.grant(id2, expires)).answer(204, "")
        w.push.onNewToken([relayServer])
        expect(w.sentBody(1).contains("\"token\":\"token-2\""), "a grant for the new token")
        expect(w.cezar.calls.isEmpty, "no session needed for the relay")
        expect(w.store.server("r").grant?.handedOver == false, "not handed over yet")
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.grantId == id2, "handed over")
        expect(w.relay.sent.count == 3, "handed over, not minted again")
        expect(w.store.server("r").grant?.handedOver == true, "saved handed over")
    }
    // aNewTokenWhoseGrantFailsIsRenewedOnTheNextOpen
    do {
        let w = World()
        w.granted()
        w.tokens.value = "token-2"
        w.relay.answer(PushRelayAnswer(status: 503, code: nil, retryAfter: 30, date: -1, body: ""))
        w.push.onNewToken([relayServer])
        expect(w.store.server("r").grant?.grantId == id1, "the grant for the dead token stays until a new one is got")
        w.relay.answer(200, FakeRelay.grant(id2, expires)).answer(204, "")
        w.push.sync(relayServer, w.cezar.api())
        expect(w.sentBody(2).contains("\"token\":\"token-2\""), "renewed on open")
        expect(w.cezar.grantId == id2, "handed over")
        expect(!w.store.renewOwed("r"), "renew settled")
        w.cezar.calls.removeAll()
        w.push.sync(relayServer, w.cezar.api())
        expect(w.relay.sent.count == 4, "renewed once")
    }
    // aStoreThatCannotBeWrittenDegradesInsteadOfThrowing
    do {
        let w = World()
        w.granted()
        try? FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: w.folder.path)
        expect(!w.push.setEnabled(relayServer, true), "an unsaved switch reports false")
        w.push.sync(relayServer, w.cezar.api())
        w.push.onNewToken([relayServer])
        w.push.retryRevokes()
        w.push.markAsked()
        expect(w.push.forget(relayServer), "unsure what is owed, the key stays")
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: w.folder.path)
    }
    // switchingOffRevokesAtTheRelayAndDeletesAtCezarOnTheNextSession
    do {
        let w = World()
        w.granted()
        w.relay.answer(204, "")
        w.push.setEnabled(relayServer, false)
        expect(w.relay.url(1).hasSuffix("/v1/push-grants/revoke"), "revoked at the relay")
        expect(w.sentBody(1) == "{\"grant\":\"sealed-\(id1)\"}", "the grant revoked")
        expect(w.store.server("r").grant == nil, "no grant kept")
        expect(w.store.revokes().isEmpty, "nothing owed")
        expect(w.keys.deleted.isEmpty, "its own key stays: the server is still saved")
        w.cezar.calls.removeAll()
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.calls == ["DELETE /api/v1/workspace/phone/push"], "cezar gets its DELETE")
        expect(w.cezar.grantId == nil, "cezar holds nothing")
        w.cezar.calls.removeAll()
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.calls.isEmpty, "nothing left to say")
    }
    // aDeleteThatFailsIsOwedToTheNextSession
    do {
        let w = World()
        w.granted()
        w.relay.answer(204, "")
        w.push.setEnabled(relayServer, false)
        w.cezar.offline = true
        w.push.sync(relayServer, w.cezar.api())
        expect(w.store.server("r").held, "still owed")
        w.cezar.offline = false
        w.push.sync(relayServer, w.cezar.api())
        expect(!w.store.server("r").held, "settled")
    }
    // cezarWithPushOffLeavesThePhoneNoGrant
    do {
        let w = World()
        w.granted()
        w.cezar.available = false
        w.relay.answer(204, "")
        w.push.sync(relayServer, w.cezar.api())
        expect(w.store.server("r").grant == nil, "dropped")
        expect(w.relay.url(1).hasSuffix("/revoke"), "and revoked")
    }
    // aPutRefusedWith409DropsTheGrantItJustGot
    do {
        let w = World()
        w.push.setEnabled(relayServer, true)
        w.relay.answer(200, FakeRelay.grant(id1, expires)).answer(204, "")
        w.cezar.refusePut = true
        w.push.sync(relayServer, w.cezar.api())
        expect(w.store.server("r").grant == nil, "dropped")
        expect(w.relay.sent.count == 2, "got, then revoked")
    }
    // aFailedGrantLeavesTheSwitchOnForTheNextOpen
    do {
        let w = World()
        w.push.setEnabled(relayServer, true)
        w.relay.answer(PushRelayAnswer(status: 503, code: nil, retryAfter: 30, date: -1, body: ""))
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.calls == ["GET /api/v1/workspace/phone/push"], "no PUT without a grant")
        expect(w.store.server("r").enabled, "still on")
        w.relay.answer(200, FakeRelay.grant(id1, expires))
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.grantId == id1, "the next open gets it")
    }
    // forgetKeepsTheDeviceKeyUntilTheRevokeSettles
    do {
        let w = World()
        w.granted()
        w.relay.answer(PushRelayAnswer(status: 503, code: nil, retryAfter: 60, date: -1, body: ""))
        expect(w.push.forget(relayServer), "the key must stay")
        expect(w.keys.deleted.isEmpty, "not deleted")
        expect(w.push.removing() == ["Laptop"], "listed as removing")
        w.push.retryRevokes()
        expect(w.relay.sent.count == 2, "not before Retry-After")
        w.now += 61_000
        w.relay.answer(204, "")
        w.push.retryRevokes()
        expect(w.relay.sent.count == 3, "retried")
        expect(w.keys.deleted == ["r"], "the key goes with the revoke")
        expect(w.push.removing().isEmpty, "no longer removing")
    }
    // Security review M1: a renewal whose hand-over fails must not leave cezar a grant nobody revokes.
    do {
        let w = World()
        w.granted()
        w.now = start + 61 * dayMs
        w.relay.answer(200, FakeRelay.grant(id2, expires + 61 * dayMs / 1000)).answer(204, "")
        w.cezar.dropOnPut = true
        w.push.sync(relayServer, w.cezar.api())
        expect(w.cezar.grantId == id1, "cezar still holds the old grant")
        expect(w.sentBody(2) == "{\"grant\":\"sealed-\(id1)\"}", "the old one is revoked anyway")
        w.relay.answer(204, "")
        w.push.setEnabled(relayServer, false)
        expect(w.sentBody(3) == "{\"grant\":\"sealed-\(id2)\"}", "and the new one on switch off")
        expect(w.store.revokes().isEmpty, "nothing owed")
    }
    // forgetWithoutAGrantOwesNothing
    do {
        let w = World()
        expect(!w.push.forget(relayServer), "nothing owed")
        expect(w.relay.sent.isEmpty, "no request")
    }
    // aRevokeRetriesWithJitterAfterANetworkFailure
    do {
        let w = World()
        w.granted()
        expect(w.push.forget(relayServer), "owed")
        let owed = w.store.revokes().first
        expect(owed != nil && owed!.notBefore >= w.now + 1000 && owed!.notBefore <= w.now + 2000, "jitter 1 to 2 s")
        expect(owed?.attempts == 1, "one attempt")
    }
    // terminalAnswersStopAndExpiryEndsTheWait
    for status in [400, 401, 410] {
        // A 401 without a Date has no clock to correct by, so it is not retried.
        let w = World()
        w.granted()
        w.relay.answer(status, "{}")
        expect(!w.push.forget(relayServer), "status \(status) settles")
        expect(w.store.revokes().isEmpty, "status \(status): nothing owed")
    }
    do {
        let w = World()
        w.granted()
        w.relay.answer(PushRelayAnswer(status: 429, code: "rate-limited", retryAfter: 3600, date: -1, body: ""))
        expect(w.push.forget(relayServer), "owed")
        expect(w.keys.deleted.isEmpty, "the key waits for the revoke")
        let sent = w.relay.sent.count
        w.now = (expires + 1) * 1000
        w.push.retryRevokes()
        expect(w.relay.sent.count == sent, "an expired grant has nothing left to deny")
        expect(w.store.revokes().isEmpty, "settled by expiry")
        expect(w.keys.deleted.contains("r"), "the key goes")
    }
    // The store survives a reread, and an unreadable file is empty.
    do {
        let folder = temporaryDirectory()
        let store = PushStore(directory: folder)
        try? store.putServer("x", PushStore.Server(enabled: true, held: false, grant: PushGrant(grant: "g", grantId: id1, expiresAt: 9, cezarKey: "k", handedOver: true)))
        try? store.setRevokes([PushStore.Revoke(serverId: "x", label: "L", origin: "https://o", grant: "g", expiresAt: 9, notBefore: 3, attempts: 2, forgotten: true)])
        let again = PushStore(directory: folder)
        expect(again.server("x") == PushStore.Server(enabled: true, held: false, grant: PushGrant(grant: "g", grantId: id1, expiresAt: 9, cezarKey: "k", handedOver: true)),
               "a server survives a reread")
        expect(again.revokes().first?.attempts == 2 && again.revokes().first?.forgotten == true, "a revoke survives a reread")
        try? Data("not json".utf8).write(to: folder.appendingPathComponent("push.json"))
        expect(again.server("x") == .off && again.revokes().isEmpty && !again.asked(), "unreadable means empty")
    }
}
