package com.openmercato.cezar.mobile.shell.relay;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import org.bouncycastle.util.encoders.Base64;

/** Wire encodings of RELAY_PROTOCOL.md § 2. java.util.Base64 is API 26; this app starts at 24. */
public final class Bytes {
    private static final Pattern BASE64URL = Pattern.compile("[A-Za-z0-9_-]+");

    private Bytes() {}

    public static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }

    public static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    public static byte[] concat(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        int at = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, at, part.length);
            at += part.length;
        }
        return out;
    }

    public static String base64url(byte[] bytes) {
        String text = new String(Base64.encode(bytes), StandardCharsets.US_ASCII);
        return text.replace('+', '-').replace('/', '_').replace("=", "");
    }

    /** Refuses padding, the `+/` alphabet and non-canonical trailing bits, as § 2 requires. Null when refused. */
    public static byte[] fromBase64url(String text) {
        if (text == null || !BASE64URL.matcher(text).matches() || text.length() % 4 == 1) return null;
        StringBuilder standard = new StringBuilder(text.replace('-', '+').replace('_', '/'));
        while (standard.length() % 4 != 0) standard.append('=');
        byte[] bytes;
        try {
            bytes = Base64.decode(standard.toString());
        } catch (RuntimeException e) {
            return null;
        }
        return base64url(bytes).equals(text) ? bytes : null;
    }

    /** Exactly `length` decoded bytes, or null. */
    public static byte[] fromBase64url(String text, int length) {
        byte[] bytes = fromBase64url(text);
        return bytes != null && bytes.length == length ? bytes : null;
    }
}
