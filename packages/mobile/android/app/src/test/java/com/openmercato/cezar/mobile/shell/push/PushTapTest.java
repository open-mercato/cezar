package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.CredentialStore;
import com.openmercato.cezar.mobile.shell.HealthAnswer;
import com.openmercato.cezar.mobile.shell.HealthClassifier;
import com.openmercato.cezar.mobile.shell.HttpAnswer;
import com.openmercato.cezar.mobile.shell.HealthProbe;
import com.openmercato.cezar.mobile.shell.RelayFields;
import com.openmercato.cezar.mobile.shell.ServerListStore;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** A tap carries a cezarId only; the manager comes from cezar inside the session (spec R5). */
public class PushTapTest {
    private static final String CEZAR_ID = "cezarcezarcezarcezar01";
    private static final ServerRecord RELAY = new ServerRecord("r", "Laptop", new RelayFields("https://relay.example.test", CEZAR_ID, "x25519", "device", 0), null);
    private static final ServerRecord MANUAL = new ServerRecord("m", "Box", "https://box.example.com", null, null, null);

    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final List<String> calls = new ArrayList<>();
    private HealthAnswer health = HealthAnswer.of(HealthAnswer.Kind.CEZAR_OFFLINE, 0);

    @Test
    public void theCezarIdFindsItsRelayServer() {
        assertEquals("r", PushTap.serverFor(CEZAR_ID, Arrays.asList(MANUAL, RELAY)).id);
        assertNull(PushTap.serverFor("cezarcezarcezarcezar02", Arrays.asList(MANUAL, RELAY)));
        assertNull(PushTap.serverFor(null, Arrays.asList(RELAY)));
        assertNull("a malformed id matches nothing", PushTap.serverFor(CEZAR_ID + "/../x", Arrays.asList(RELAY)));
    }

    @Test
    public void onlyAPlainManagerIdIsFollowed() {
        assertEquals("/manager/mgr_1-a", PushTap.landing("/manager", "mgr_1-a"));
        for (String bad : new String[] {null, "", "../settings", "a/b", "a?b", "a b", "%2e%2e", "x".repeat(65), "é"}) {
            assertEquals(String.valueOf(bad), "/manager", PushTap.landing("/manager", bad));
        }
        assertEquals("a root start stays at the root", "/", PushTap.landing("/", "mgr"));
    }

    @Test
    public void anOfferedTapIsTakenOnceAndAMalformedOneNever() {
        PushTap.offer(CEZAR_ID);
        assertEquals(CEZAR_ID, PushTap.take());
        assertNull(PushTap.take());
        PushTap.offer("javascript:alert(1)");
        assertNull(PushTap.take());
    }

    @Test
    public void aTapOpensThroughTheNormalOpenAndLandsOnTheManager() {
        ShellConnector connector = connector();
        health = cezar();
        ShellConnector.Outcome outcome = PushTap.open(connector, CEZAR_ID, server -> "mgr1");
        assertEquals(ShellConnector.OPEN, outcome.screen);
        assertEquals("/manager/mgr1", outcome.url);
        assertEquals(Arrays.asList("probe"), calls);
        assertEquals("/manager", PushTap.open(connector, CEZAR_ID, server -> null).url);
    }

    @Test
    public void aServerThatCannotOpenShowsItsScreenAndAsksNothing() {
        ShellConnector connector = connector();
        ShellConnector.Outcome outcome = PushTap.open(connector, CEZAR_ID, server -> {
            throw new AssertionError("no session to ask in");
        });
        assertEquals(ShellConnector.CEZAR_OFFLINE, outcome.screen);
    }

    @Test
    public void anUnknownCezarIdOpensNothing() {
        assertNull(PushTap.open(connector(), "cezarcezarcezarcezar02", server -> "m"));
        assertTrue(calls.isEmpty());
    }

    private HealthAnswer cezar() {
        java.util.Map<String, List<String>> headers = new java.util.HashMap<>();
        headers.put("content-type", Arrays.asList("application/json"));
        return HealthClassifier.classify(new HttpAnswer(200, headers, "{\"version\":\"1\",\"capabilities\":{\"managers\":true}}"));
    }

    private ShellConnector connector() {
        ServerListStore servers = new ServerListStore(folder.getRoot());
        servers.put(RELAY);
        CredentialStore credentials = new CredentialStore(folder.getRoot(), new CredentialStore.Cipher() {
            @Override public byte[] seal(byte[] plain) {
                return plain;
            }

            @Override public byte[] open(byte[] sealed) {
                return sealed;
            }
        });
        return new ShellConnector(servers, credentials, new HealthProbe((url, headers) -> {
            throw new AssertionError("never over https");
        }, "ua"), new ShellConnector.RelayPort() {
            @Override public HealthAnswer probe(ServerRecord server) {
                calls.add("probe");
                return health;
            }

            @Override public void goodbye(ServerRecord server) {
                calls.add("goodbye");
            }

            @Override public void forgetKeys(String id) {
                calls.add("forgetKeys");
            }
        });
    }
}
