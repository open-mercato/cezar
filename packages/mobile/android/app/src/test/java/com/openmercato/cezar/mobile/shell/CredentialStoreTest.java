package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class CredentialStoreTest {
    /** AES-GCM with a software key: the shape of KeystoreCipher, without the Keystore. */
    private static final class SoftwareCipher implements CredentialStore.Cipher {
        private final SecretKeySpec key = new SecretKeySpec(new byte[32], "AES");

        @Override
        public byte[] seal(byte[] plain) throws GeneralSecurityException {
            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
            byte[] sealed = cipher.doFinal(plain);
            byte[] out = new byte[12 + sealed.length];
            System.arraycopy(iv, 0, out, 0, 12);
            System.arraycopy(sealed, 0, out, 12, sealed.length);
            return out;
        }

        @Override
        public byte[] open(byte[] blob) throws GeneralSecurityException {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, blob, 0, 12));
            return cipher.doFinal(blob, 12, blob.length - 12);
        }
    }

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private CredentialStore store() {
        return new CredentialStore(folder.getRoot(), new SoftwareCipher());
    }

    @Test
    public void roundTripsAndDeletes() {
        CredentialStore store = store();
        store.put("a-1", "secret");
        assertEquals("secret", store.get("a-1"));
        store.delete("a-1");
        assertNull(store.get("a-1"));
        store.delete("a-1");
    }

    @Test
    public void thePasswordIsNotOnDisk() throws Exception {
        store().put("a-1", "secret");
        String blob = new String(Files.readAllBytes(new File(folder.getRoot(), "a-1.cred").toPath()), StandardCharsets.ISO_8859_1);
        assertFalse(blob.contains("secret"));
    }

    @Test
    public void aBlobThatWillNotOpenReadsAsNoPassword() throws Exception {
        Files.write(new File(folder.getRoot(), "a-1.cred").toPath(), new byte[] {1, 2, 3});
        assertNull(store().get("a-1"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void anIdCannotEscapeTheDirectory() {
        store().get("../servers");
    }
}
