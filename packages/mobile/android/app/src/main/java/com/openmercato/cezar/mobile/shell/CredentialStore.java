package com.openmercato.cezar.mobile.shell;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.util.regex.Pattern;

/** Passwords as encrypted blobs in a directory excluded from backup (spec Decision 2). */
public final class CredentialStore {
    /** Seals bytes with a key that stays out of this class. */
    public interface Cipher {
        byte[] seal(byte[] plain) throws GeneralSecurityException;
        byte[] open(byte[] sealed) throws GeneralSecurityException;
    }

    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

    private final File directory;
    private final Cipher cipher;

    public CredentialStore(File directory, Cipher cipher) {
        this.directory = directory;
        this.cipher = cipher;
    }

    public void put(String id, String password) {
        try {
            Files.write(file(id).toPath(), cipher.seal(password.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException | GeneralSecurityException e) {
            throw new IllegalStateException("cannot save the password", e);
        }
    }

    /** Null when absent or unreadable, a truncated blob included: a lost key reads as "no password saved", which re-asks. */
    public String get(String id) {
        File file = file(id);
        if (!file.exists()) return null;
        try {
            return new String(cipher.open(Files.readAllBytes(file.toPath())), StandardCharsets.UTF_8);
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    public void delete(String id) {
        File file = file(id);
        if (file.exists() && !file.delete()) throw new IllegalStateException("cannot delete the password");
    }

    private File file(String id) {
        if (!SAFE_ID.matcher(id).matches()) throw new IllegalArgumentException("bad server id");
        return new File(directory, id + ".cred");
    }
}
