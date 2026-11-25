package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import com.openmercato.cezar.mobile.shell.CredentialStore;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DeviceKeyStoreTest {
    private static final CredentialStore.Cipher PLAIN = new CredentialStore.Cipher() {
        @Override public byte[] seal(byte[] plain) {
            return plain;
        }

        @Override public byte[] open(byte[] sealed) {
            return sealed;
        }
    };

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void newKeysReplaceOldOnesAndNoPartialFileStays() {
        DeviceKeyStore store = new DeviceKeyStore(folder.getRoot(), PLAIN);
        store.put("a", DeviceKeys.generate());
        DeviceKeys next = DeviceKeys.generate();
        store.put("a", next);
        assertArrayEquals(next.toBytes(), store.get("a").toBytes());
        assertEquals(1, folder.getRoot().list().length);
        store.delete("a");
        assertNull(store.get("a"));
    }
}
