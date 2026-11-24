package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** A start with the bundle on the phone opens at once; the probe stays for every other open. */
public class QuickStartTest {
    private static final HttpAnswer CEZAR = HealthClassifierTest.answer(200, "application/json", null, "{\"version\":\"1\",\"capabilities\":{\"managers\":true}}");

    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final List<String> calls = new ArrayList<>();
    private String quickPath;
    private HealthAnswer health;
    private ShellConnector connector;
    private String id;

    @Before
    public void build() {
        ServerListStore servers = new ServerListStore(folder.getRoot());
        CredentialStore credentials = new CredentialStore(folder.getRoot(), new CredentialStore.Cipher() {
            @Override public byte[] seal(byte[] plain) {
                return plain;
            }

            @Override public byte[] open(byte[] sealed) {
                return sealed;
            }
        });
        connector = new ShellConnector(servers, credentials, new HealthProbe((url, headers) -> {
            throw new AssertionError("never over https");
        }, "ua"), new ShellConnector.RelayPort() {
            @Override public HealthAnswer probe(ServerRecord server) {
                calls.add("probe");
                return health;
            }

            @Override public void goodbye(ServerRecord server) {
                calls.add("goodbye");
            }

            @Override public void forgetKeys(String serverId) {
                calls.add("forgetKeys");
            }

            @Override public String quickPath(ServerRecord server) {
                return quickPath;
            }

            @Override public void opened(ServerRecord server, String path) {
                calls.add("opened " + path);
            }

            @Override public void forgetBundle(String serverId) {
                calls.add("forgetBundle");
            }
        });
        RelayFields fields = new RelayFields("https://relay.example.test", "cezar-id", "key", "device-id", 0);
        id = connector.saveRelayServer(connector.relayServerId(fields.cezarId, fields.cezarKey), "Laptop", fields);
    }

    @Test
    public void aColdStartWithTheBundleCachedSkipsTheProbe() {
        quickPath = "/manager";
        ShellConnector.Outcome outcome = connector.launch(null);
        assertEquals(ShellConnector.OPEN, outcome.screen);
        assertEquals("/manager", outcome.url);
        assertTrue(calls.toString(), calls.isEmpty());
    }

    @Test
    public void withNothingCachedTheStartProbesAndRemembersWhereItLanded() {
        health = HealthClassifier.classify(CEZAR);
        ShellConnector.Outcome outcome = connector.launch(null);
        assertEquals("/manager", outcome.url);
        assertEquals(List.of("probe", "opened /manager"), calls);
    }

    @Test
    public void retryFromTheListStillProbes() {
        quickPath = "/manager";
        health = HealthClassifier.classify(CEZAR);
        connector.open(id, null);
        assertEquals("probe", calls.get(0));
    }

    @Test
    public void removedAndForgottenServersLoseTheirBundle() {
        health = HealthAnswer.of(HealthAnswer.Kind.DEVICE_REMOVED, 0);
        assertEquals(ShellConnector.DEVICE_REMOVED, connector.open(id, null).screen);
        assertTrue(calls.toString(), calls.contains("forgetBundle"));
        calls.clear();
        connector.forget(id);
        assertEquals("first, before the relay's goodbye", "forgetBundle", calls.get(0));
        assertNull(connector.server(id));
    }
}
