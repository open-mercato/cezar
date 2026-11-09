package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.CredentialStore;
import com.openmercato.cezar.mobile.shell.HealthAnswer;
import com.openmercato.cezar.mobile.shell.HealthProbe;
import com.openmercato.cezar.mobile.shell.RelayFields;
import com.openmercato.cezar.mobile.shell.ServerListStore;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The grant's whole life on the phone, with a fake token source, a fake relay and a fake cezar (spec R5 as built). */
public class PushCoordinatorTest {
    private static final long DAY_MS = 24L * 60 * 60 * 1000;
    private static final long START = 1_800_000_000_000L;
    private static final long EXPIRES = START / 1000 + 90 * DAY_MS / 1000;
    private static final String ID_1 = "AAAAAAAAAAAAAAAAAAAAAA";
    private static final String ID_2 = "BBBBBBBBBBBBBBBBBBBBBB";
    private static final ServerRecord SERVER = new ServerRecord("r", "Laptop", new RelayFields("https://relay.example.test", "cezarcezarcezarcezar01", "x25519", "device", 0), null);

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private final FakeRelay relay = new FakeRelay();
    private final FakeCezar cezar = new FakeCezar();
    private final Map<String, DeviceKeys> keys = new HashMap<>();
    private final List<String> deletedKeys = new ArrayList<>();
    private boolean pushAvailable = true;
    private String token = "token-1";
    private int tokenCalls;
    private long now = START;
    private PushStore store;
    private PushCoordinator push;

    @Before
    public void build() {
        keys.put("r", DeviceKeys.generate());
        store = new PushStore(folder.getRoot());
        TokenSource tokens = new TokenSource() {
            @Override public boolean available() {
                return pushAvailable;
            }

            @Override public String token() throws IOException {
                tokenCalls++;
                if (token == null) throw new IOException("no token");
                return token;
            }
        };
        push = new PushCoordinator(store, tokens, new GrantClient(relay, () -> now), new PushCoordinator.Keys() {
            @Override public DeviceKeys get(String serverId) {
                return keys.get(serverId);
            }

            @Override public void delete(String serverId) {
                deletedKeys.add(serverId);
                keys.remove(serverId);
            }
        }, () -> now, new Random(1));
    }

    private String sentBody(int index) {
        return new String(relay.sent.get(index).body, StandardCharsets.UTF_8);
    }

    private void granted() {
        assertTrue(push.setEnabled(SERVER, true));
        relay.answer(200, FakeRelay.grant(ID_1, EXPIRES));
        push.sync(SERVER, cezar.api());
    }

    @Test
    public void withoutFirebaseTheSwitchAndTheAskStillWorkAndNoGrantIsAttempted() {
        pushAvailable = false;
        assertFalse(push.available());
        assertTrue("Stage 1 asks after the first pairing too", push.shouldAsk());
        assertTrue("the switch turns on for the signal stream", push.setEnabled(SERVER, true));
        assertTrue(push.enabled("r"));
        push.sync(SERVER, cezar.api());
        push.onNewToken(Collections.singletonList(SERVER));
        assertTrue(cezar.calls.isEmpty());
        assertTrue(relay.sent.isEmpty());
        assertEquals(0, tokenCalls);
        assertTrue(push.setEnabled(SERVER, false));
        assertFalse(push.enabled("r"));
        assertTrue("nothing to revoke without a grant", relay.sent.isEmpty());
        push.markAsked();
        assertFalse(push.shouldAsk());
    }

    @Test
    public void aServerWithoutARelayHasNoSwitch() {
        pushAvailable = false;
        ServerRecord manual = new ServerRecord("m", "Box", "https://box.example.com", null, null, null);
        assertFalse(push.setEnabled(manual, true));
        assertFalse(push.enabled("m"));
    }

    @Test
    public void turningTheSwitchOnOnlySavesItTheNextSessionGetsAndHandsOverTheGrant() throws Exception {
        assertTrue(push.setEnabled(SERVER, true));
        assertTrue(relay.sent.isEmpty());
        assertEquals(0, tokenCalls);
        relay.answer(200, FakeRelay.grant(ID_1, EXPIRES));
        push.sync(SERVER, cezar.api());
        assertEquals(Arrays.asList("GET /api/v1/workspace/phone/push", "PUT /api/v1/workspace/phone/push"), cezar.calls);
        assertEquals("{\"platform\":\"android\",\"token\":\"token-1\",\"cezarKey\":\"" + GrantClientTest.CEZAR_KEY + "\"}", sentBody(0));
        assertEquals(ID_1, cezar.grantId);
        PushStore.Server saved = store.server("r");
        assertTrue(saved.enabled);
        assertTrue(saved.held);
        assertTrue(saved.grant.handedOver);
        cezar.calls.clear();
        push.sync(SERVER, cezar.api());
        assertEquals("a held, fresh grant costs one GET", Arrays.asList("GET /api/v1/workspace/phone/push"), cezar.calls);
        assertEquals(1, relay.sent.size());
    }

    @Test
    public void openRenewsOnceUnderThirtyDaysRemain() {
        granted();
        now = START + 59 * DAY_MS;
        push.sync(SERVER, cezar.api());
        assertEquals("31 days left: nothing", 1, relay.sent.size());
        now = START + 61 * DAY_MS;
        relay.answer(200, FakeRelay.grant(ID_2, EXPIRES + 61 * DAY_MS / 1000));
        push.sync(SERVER, cezar.api());
        assertEquals(2, relay.sent.size());
        assertEquals(ID_2, cezar.grantId);
        assertEquals(ID_2, store.server("r").grant.grantId);
    }

    @Test
    public void cezarHoldingNoGrantGetsAFreshOne() {
        granted();
        cezar.grantId = null;
        relay.answer(200, FakeRelay.grant(ID_2, EXPIRES));
        push.sync(SERVER, cezar.api());
        assertEquals(ID_2, cezar.grantId);
    }

    @Test
    public void aNewTokenGetsANewGrantAndTheNextOpenHandsItOver() {
        granted();
        cezar.calls.clear();
        token = "token-2";
        relay.answer(200, FakeRelay.grant(ID_2, EXPIRES));
        push.onNewToken(Collections.singletonList(SERVER));
        assertTrue(sentBody(1).contains("\"token\":\"token-2\""));
        assertTrue("no session needed for the relay", cezar.calls.isEmpty());
        assertFalse(store.server("r").grant.handedOver);
        push.sync(SERVER, cezar.api());
        assertEquals(ID_2, cezar.grantId);
        assertEquals("handed over, not minted again", 2, relay.sent.size());
        assertTrue(store.server("r").grant.handedOver);
    }

    @Test
    public void switchingOffRevokesAtTheRelayAndDeletesAtCezarOnTheNextSession() {
        granted();
        relay.answer(204, "");
        push.setEnabled(SERVER, false);
        assertTrue(relay.sent.get(1).url.endsWith("/v1/push-grants/revoke"));
        assertEquals("{\"grant\":\"sealed-" + ID_1 + "\"}", sentBody(1));
        assertNull(store.server("r").grant);
        assertTrue(store.revokes().isEmpty());
        assertTrue("its own key stays: the server is still saved", deletedKeys.isEmpty());
        cezar.calls.clear();
        push.sync(SERVER, cezar.api());
        assertEquals(Arrays.asList("DELETE /api/v1/workspace/phone/push"), cezar.calls);
        assertNull(cezar.grantId);
        cezar.calls.clear();
        push.sync(SERVER, cezar.api());
        assertTrue("nothing left to say", cezar.calls.isEmpty());
    }

    @Test
    public void aDeleteThatFailsIsOwedToTheNextSession() {
        granted();
        relay.answer(204, "");
        push.setEnabled(SERVER, false);
        cezar.offline = true;
        push.sync(SERVER, cezar.api());
        assertTrue(store.server("r").held);
        cezar.offline = false;
        push.sync(SERVER, cezar.api());
        assertFalse(store.server("r").held);
    }

    @Test
    public void cezarWithPushOffLeavesThePhoneNoGrant() {
        granted();
        cezar.available = false;
        relay.answer(204, "");
        push.sync(SERVER, cezar.api());
        assertNull(store.server("r").grant);
        assertTrue(relay.sent.get(1).url.endsWith("/revoke"));
    }

    @Test
    public void aPutRefusedWith409DropsTheGrantItJustGot() {
        push.setEnabled(SERVER, true);
        relay.answer(200, FakeRelay.grant(ID_1, EXPIRES)).answer(204, "");
        cezar.refusePut = true;
        push.sync(SERVER, cezar.api());
        assertNull(store.server("r").grant);
        assertEquals(2, relay.sent.size());
    }

    @Test
    public void aFailedGrantLeavesTheSwitchOnForTheNextOpen() {
        push.setEnabled(SERVER, true);
        relay.answer(new PushRelay.Answer(503, null, 30, -1, ""));
        push.sync(SERVER, cezar.api());
        assertEquals(Arrays.asList("GET /api/v1/workspace/phone/push"), cezar.calls);
        assertTrue(store.server("r").enabled);
        relay.answer(200, FakeRelay.grant(ID_1, EXPIRES));
        push.sync(SERVER, cezar.api());
        assertEquals(ID_1, cezar.grantId);
    }

    @Test
    public void forgetKeepsTheDeviceKeyUntilTheRevokeSettles() {
        granted();
        relay.answer(new PushRelay.Answer(503, null, 60, -1, ""));
        assertTrue("the key must stay", push.forget(SERVER));
        assertTrue(deletedKeys.isEmpty());
        assertEquals(Collections.singletonList("Laptop"), push.removing());
        push.retryRevokes();
        assertEquals("not before Retry-After", 2, relay.sent.size());
        now += 61_000;
        relay.answer(204, "");
        push.retryRevokes();
        assertEquals(3, relay.sent.size());
        assertEquals(Collections.singletonList("r"), deletedKeys);
        assertTrue(push.removing().isEmpty());
    }

    @Test
    public void forgetWithoutAGrantOwesNothing() {
        assertFalse(push.forget(SERVER));
        assertTrue(relay.sent.isEmpty());
    }

    @Test
    public void aRevokeRetriesWithJitterAfterANetworkFailure() {
        granted();
        assertTrue(push.forget(SERVER));
        PushStore.Revoke owed = store.revokes().get(0);
        assertTrue(owed.notBefore >= now + 1000 && owed.notBefore <= now + 2000);
        assertEquals(1, owed.attempts);
    }

    @Test
    public void terminalAnswersStopAndExpiryEndsTheWait() {
        for (int status : new int[] {400, 401, 410}) {
            // A 401 without a Date has no clock to correct by, so it is not retried.
            build();
            granted();
            relay.answer(status, "{}");
            assertFalse("status " + status, push.forget(SERVER));
            assertTrue(store.revokes().isEmpty());
        }
        build();
        granted();
        relay.answer(new PushRelay.Answer(429, "rate-limited", 3600, -1, ""));
        assertTrue(push.forget(SERVER));
        int sent = relay.sent.size();
        now = (EXPIRES + 1) * 1000;
        push.retryRevokes();
        assertEquals("an expired grant has nothing left to deny", sent, relay.sent.size());
        assertTrue(store.revokes().isEmpty());
        assertTrue(deletedKeys.contains("r"));
    }

    @Test
    public void forgetServerKeepsTheKeyWhilePushOwesARevoke() {
        ServerListStore servers = new ServerListStore(folder.getRoot());
        servers.put(SERVER);
        List<String> calls = new ArrayList<>();
        ShellConnector connector = new ShellConnector(servers, new CredentialStore(folder.getRoot(), new CredentialStore.Cipher() {
            @Override public byte[] seal(byte[] plain) {
                return plain;
            }

            @Override public byte[] open(byte[] sealed) {
                return sealed;
            }
        }), new HealthProbe((url, headers) -> {
            throw new IOException("unused");
        }, "ua"), new ShellConnector.RelayPort() {
            @Override public HealthAnswer probe(ServerRecord server) {
                return null;
            }

            @Override public void goodbye(ServerRecord server) {
                calls.add("goodbye");
            }

            @Override public void forgetKeys(String id) {
                calls.add("forgetKeys");
            }
        }, push::forget);
        granted();
        relay.answer(new PushRelay.Answer(503, null, -1, -1, ""));
        connector.forget("r");
        assertEquals(Collections.singletonList("goodbye"), calls);
        assertNull(servers.get("r"));
        servers.put(new ServerRecord("s", "Other", new RelayFields("https://relay.example.test", "cezarcezarcezarcezar02", "x", "d", 0), null));
        connector.forget("s");
        assertEquals(Arrays.asList("goodbye", "goodbye", "forgetKeys"), calls);
    }
}
