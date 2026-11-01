package com.openmercato.cezar.mobile.shell.relay;

import java.util.Arrays;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** What either pairing credential gives: a locator, a PSK and, for a QR code, the key to pin (§ 9.2). */
public final class PairSecret {
    private static final byte[] HKDF_SALT = Bytes.ascii("cezar-relay-pair-salt-v1");
    private static final byte[] CODE_SALT = Bytes.ascii("cezar-pair-code-v1");
    private static final int CODE_ITERATIONS = 200000;
    private static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private static final Pattern QR = Pattern.compile("(.*?)/p#([0-9]+)\\.(.*)");
    private static final Pattern FIELDS = Pattern.compile("([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})");

    public final RelayOrigin relay;
    public final byte[] locatorBytes;
    public final byte[] psk;
    /** cezar's X25519 key from a QR code; null for a typed code, where the six digits carry the weight. */
    public final byte[] pinnedKey;

    private PairSecret(RelayOrigin relay, byte[] locatorBytes, byte[] psk, byte[] pinnedKey) {
        this.relay = relay;
        this.locatorBytes = locatorBytes;
        this.psk = psk;
        this.pinnedKey = pinnedKey;
    }

    public String locator() {
        return Bytes.base64url(locatorBytes);
    }

    /** The strict § 9.1 parser. `version` is read first, so a later layout still says "Update the app". */
    public static PairSecret fromQr(String text, boolean debugBuild) throws RelayOrigin.Refused {
        Matcher match = QR.matcher(text == null ? "" : text);
        if (!match.matches()) throw new RelayOrigin.Refused("grammar");
        RelayOrigin.matched(match.group(1));
        if (!match.group(2).equals("1")) throw new RelayOrigin.Refused("version");
        Matcher fields = FIELDS.matcher(match.group(3));
        if (!fields.matches()) throw new RelayOrigin.Refused("grammar");
        byte[] secret = Bytes.fromBase64url(fields.group(1), 32);
        byte[] key = Bytes.fromBase64url(fields.group(2), 32);
        if (secret == null || key == null) throw new RelayOrigin.Refused("grammar");
        RelayOrigin relay = RelayOrigin.parse(match.group(1), debugBuild);
        return new PairSecret(relay, hkdfLabel(secret, "cezar-pair-locator-v1"), hkdfLabel(secret, "cezar-pair-psk-v1"), key);
    }

    private static byte[] hkdfLabel(byte[] secret, String info) {
        return RelayCrypto.hkdf(secret, HKDF_SALT, Bytes.ascii(info), 32);
    }

    /** Normalizes a typed code under § 9.2; null when refused. */
    public static String normalizeCode(String typed) {
        if (typed == null) return null;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < typed.length(); i++) {
            char c = typed.charAt(i);
            if (c == ' ' || c == '-' || (c >= '‐' && c <= '―')) continue;
            if (c >= 'a' && c <= 'z') c = (char) (c - 'a' + 'A');
            if (c == 'O') c = '0';
            if (c == 'I' || c == 'L') c = '1';
            if (ALPHABET.indexOf(c) < 0) return null;
            out.append(c);
        }
        return out.length() == 12 ? out.toString() : null;
    }

    /** Slow on purpose, 200,000 rounds: call it off the main thread. */
    public static PairSecret fromCode(String typed, RelayOrigin relay) throws RelayOrigin.Refused {
        String code = normalizeCode(typed);
        if (code == null) throw new RelayOrigin.Refused("grammar");
        byte[] okm = RelayCrypto.pbkdf2(Bytes.ascii(code), CODE_SALT, CODE_ITERATIONS, 64);
        return new PairSecret(relay, Arrays.copyOfRange(okm, 0, 32), Arrays.copyOfRange(okm, 32, 64), null);
    }

    public static String sasDigits(byte[] handshakeHash) {
        byte[] out = RelayCrypto.hkdf(handshakeHash, HKDF_SALT, Bytes.ascii("cezar-pair-sas-v1"), 4);
        long n = ((out[0] & 0xffL) << 24) | ((out[1] & 0xffL) << 16) | ((out[2] & 0xffL) << 8) | (out[3] & 0xffL);
        return String.format(Locale.ROOT, "%06d", n % 1000000);
    }
}
