package com.openmercato.cezar.mobile.shell.relay;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/**
 * Noise revision 34 for 25519_ChaChaPoly_SHA256, patterns `KK`, `XX` and `XXpsk3`. An unaudited state
 * machine, thin over audited primitives (spec QR8); the same shape as generator/noise.mjs.
 */
public final class NoiseHandshake {
    private static final byte[] EMPTY = new byte[0];
    private static final String[][] XX = {{"e"}, {"e", "ee", "s", "es"}, {"s", "se"}};
    private static final String[][] XX_PSK3 = {{"e"}, {"e", "ee", "s", "es"}, {"s", "se", "psk"}};
    private static final String[][] KK = {{"e", "es", "ss"}, {"e", "ee", "se"}};

    public static final class Keys {
        public final NoiseCipher send;
        public final NoiseCipher receive;

        Keys(NoiseCipher send, NoiseCipher receive) {
            this.send = send;
            this.receive = receive;
        }
    }

    private final String[][] messages;
    private final boolean initiator;
    private final boolean hasPsk;
    private final byte[] staticSecret;
    private final byte[] staticPublic;
    private final byte[] psk;
    private final byte[] fixedEphemeral;
    private byte[] remoteStatic;
    private byte[] ephemeral;
    private byte[] remoteEphemeral;
    private byte[] ck;
    private byte[] h;
    private NoiseCipher cipher = new NoiseCipher(null);
    private int index;

    private NoiseHandshake(String pattern, boolean initiator, byte[] prologue, byte[] staticSecret, byte[] remoteStatic, byte[] psk, byte[] fixedEphemeral) {
        this.messages = "KK".equals(pattern) ? KK : "XX".equals(pattern) ? XX : XX_PSK3;
        this.initiator = initiator;
        this.hasPsk = "XXpsk3".equals(pattern);
        this.staticSecret = staticSecret;
        this.staticPublic = RelayCrypto.x25519Public(staticSecret);
        this.remoteStatic = remoteStatic;
        this.psk = psk;
        this.fixedEphemeral = fixedEphemeral;
        byte[] name = Bytes.ascii("Noise_" + pattern + "_25519_ChaChaPoly_SHA256");
        ck = name.length <= 32 ? Arrays.copyOf(name, 32) : RelayCrypto.sha256(name);
        h = ck;
        mixHash(prologue);
        if ("KK".equals(pattern)) {
            mixHash(initiator ? staticPublic : remoteStatic);
            mixHash(initiator ? remoteStatic : staticPublic);
        }
    }

    public static NoiseHandshake xxpsk3Initiator(byte[] prologue, byte[] staticSecret, byte[] psk) {
        return new NoiseHandshake("XXpsk3", true, prologue, staticSecret, null, psk, null);
    }

    public static NoiseHandshake kkInitiator(byte[] prologue, byte[] staticSecret, byte[] remoteStatic) {
        return new NoiseHandshake("KK", true, prologue, staticSecret, remoteStatic, null, null);
    }

    /** Fixed ephemerals exist for vectors only (§ 16), so this stays package-private. */
    static NoiseHandshake forVector(String pattern, boolean initiator, byte[] prologue, byte[] staticSecret, byte[] remoteStatic, byte[] psk, byte[] ephemeralSecret) {
        return new NoiseHandshake(pattern, initiator, prologue, staticSecret, remoteStatic, psk, ephemeralSecret);
    }

    /** A reply that fails must leave this state untouched, so the real one can still follow (§ 10). */
    public NoiseHandshake copy() {
        return new NoiseHandshake(this);
    }

    private NoiseHandshake(NoiseHandshake other) {
        messages = other.messages;
        initiator = other.initiator;
        hasPsk = other.hasPsk;
        staticSecret = other.staticSecret;
        staticPublic = other.staticPublic;
        psk = other.psk;
        fixedEphemeral = other.fixedEphemeral;
        remoteStatic = other.remoteStatic;
        ephemeral = other.ephemeral;
        remoteEphemeral = other.remoteEphemeral;
        ck = other.ck;
        h = other.h;
        cipher = other.cipher.copy();
        index = other.index;
    }

    private void mixHash(byte[] data) {
        h = RelayCrypto.sha256(h, data);
    }

    private void mixKey(byte[] ikm) {
        byte[] out = RelayCrypto.hkdf(ikm, ck, EMPTY, 64);
        ck = Arrays.copyOfRange(out, 0, 32);
        cipher = new NoiseCipher(Arrays.copyOfRange(out, 32, 64));
    }

    private void mixKeyAndHash(byte[] ikm) {
        byte[] out = RelayCrypto.hkdf(ikm, ck, EMPTY, 96);
        ck = Arrays.copyOfRange(out, 0, 32);
        mixHash(Arrays.copyOfRange(out, 32, 64));
        cipher = new NoiseCipher(Arrays.copyOfRange(out, 64, 96));
    }

    private byte[] encryptAndHash(byte[] plaintext) {
        byte[] out = cipher.encrypt(h, plaintext);
        mixHash(out);
        return out;
    }

    private byte[] decryptAndHash(byte[] ciphertext) throws RelayCrypto.DecryptFailure {
        byte[] out = cipher.decrypt(h, ciphertext);
        mixHash(ciphertext);
        return out;
    }

    private byte[] dh(String token) throws RelayCrypto.DecryptFailure {
        boolean initiatorEphemeral = token.charAt(0) == 'e';
        boolean responderEphemeral = token.charAt(1) == 'e';
        boolean mineEphemeral = initiator ? initiatorEphemeral : responderEphemeral;
        boolean theirsEphemeral = initiator ? responderEphemeral : initiatorEphemeral;
        return RelayCrypto.x25519(mineEphemeral ? ephemeral : staticSecret, theirsEphemeral ? remoteEphemeral : remoteStatic);
    }

    private boolean writing() {
        return (index % 2 == 0) == initiator;
    }

    public byte[] writeMessage(byte[] payload) throws RelayCrypto.DecryptFailure {
        if (!writing()) throw new IllegalStateException("out of turn");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (String token : messages[index]) {
            if (token.equals("e")) {
                ephemeral = fixedEphemeral != null ? fixedEphemeral : RelayCrypto.x25519Secret();
                byte[] pub = RelayCrypto.x25519Public(ephemeral);
                out.write(pub, 0, 32);
                mixHash(pub);
                if (hasPsk) mixKey(pub);
            } else if (token.equals("s")) {
                byte[] sealed = encryptAndHash(staticPublic);
                out.write(sealed, 0, sealed.length);
            } else if (token.equals("psk")) {
                mixKeyAndHash(psk);
            } else {
                mixKey(dh(token));
            }
        }
        byte[] sealed = encryptAndHash(payload);
        out.write(sealed, 0, sealed.length);
        index++;
        return out.toByteArray();
    }

    public byte[] readMessage(byte[] message) throws RelayCrypto.DecryptFailure {
        if (writing()) throw new IllegalStateException("out of turn");
        int at = 0;
        for (String token : messages[index]) {
            if (token.equals("e")) {
                if (message.length - at < 32) throw new RelayCrypto.DecryptFailure("message too short");
                remoteEphemeral = Arrays.copyOfRange(message, at, at + 32);
                at += 32;
                mixHash(remoteEphemeral);
                if (hasPsk) mixKey(remoteEphemeral);
            } else if (token.equals("s")) {
                int length = cipher.hasKey() ? 48 : 32;
                if (message.length - at < length) throw new RelayCrypto.DecryptFailure("message too short");
                remoteStatic = decryptAndHash(Arrays.copyOfRange(message, at, at + length));
                at += length;
            } else if (token.equals("psk")) {
                mixKeyAndHash(psk);
            } else {
                mixKey(dh(token));
            }
        }
        byte[] payload = decryptAndHash(Arrays.copyOfRange(message, at, message.length));
        index++;
        return payload;
    }

    public byte[] remoteStatic() {
        return remoteStatic;
    }

    public byte[] handshakeHash() {
        return h;
    }

    public boolean done() {
        return index == messages.length;
    }

    /** First key carries initiator to responder. */
    public Keys split() {
        if (!done()) throw new IllegalStateException("handshake not finished");
        byte[] out = RelayCrypto.hkdf(EMPTY, ck, EMPTY, 64);
        NoiseCipher first = new NoiseCipher(Arrays.copyOfRange(out, 0, 32));
        NoiseCipher second = new NoiseCipher(Arrays.copyOfRange(out, 32, 64));
        return initiator ? new Keys(first, second) : new Keys(second, first);
    }
}
