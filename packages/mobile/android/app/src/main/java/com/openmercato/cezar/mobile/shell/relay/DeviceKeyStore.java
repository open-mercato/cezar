package com.openmercato.cezar.mobile.shell.relay;

import com.openmercato.cezar.mobile.shell.CredentialStore;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.GeneralSecurityException;
import java.util.regex.Pattern;

/** Device keys as Keystore-sealed blobs in the no-backup directory (spec Decision 2). */
public final class DeviceKeyStore {
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

    private final File directory;
    private final CredentialStore.Cipher cipher;

    public DeviceKeyStore(File directory, CredentialStore.Cipher cipher) {
        this.directory = directory;
        this.cipher = cipher;
    }

    public void put(String id, DeviceKeys keys) {
        try (OutputStream out = new FileOutputStream(file(id))) {
            out.write(cipher.seal(keys.toBytes()));
        } catch (IOException | GeneralSecurityException e) {
            throw new IllegalStateException("cannot save the device keys", e);
        }
    }

    /** Null when absent or unreadable: a lost key reads as a phone that must pair again. */
    public DeviceKeys get(String id) {
        File file = file(id);
        if (!file.exists()) return null;
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream blob = new ByteArrayOutputStream();
            byte[] buffer = new byte[256];
            int count;
            while ((count = in.read(buffer)) != -1) blob.write(buffer, 0, count);
            return DeviceKeys.fromBytes(cipher.open(blob.toByteArray()));
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    public void delete(String id) {
        File file = file(id);
        if (file.exists() && !file.delete()) throw new IllegalStateException("cannot delete the device keys");
    }

    private File file(String id) {
        if (!SAFE_ID.matcher(id).matches()) throw new IllegalArgumentException("bad server id");
        return new File(directory, id + ".relaykey");
    }
}
