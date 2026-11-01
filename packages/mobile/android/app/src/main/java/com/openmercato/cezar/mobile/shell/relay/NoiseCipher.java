package com.openmercato.cezar.mobile.shell.relay;

/**
 * Noise's CipherState. Unaudited, thin over {@link RelayCrypto}: no maintained library has `XXpsk3`,
 * `KK` and `Rekey` (RELAY_PROTOCOL.md § 16, spec QR8). The counter is an unsigned 64-bit value.
 */
public final class NoiseCipher {
    /** 2^64 - 1, reserved by Noise for Rekey. */
    private static final long MAX_NONCE = -1L;
    private static final byte[] EMPTY = new byte[0];

    private byte[] key;
    private long nonce;

    NoiseCipher(byte[] key) {
        this(key, 0);
    }

    NoiseCipher(byte[] key, long nonce) {
        this.key = key;
        this.nonce = nonce;
    }

    NoiseCipher copy() {
        return new NoiseCipher(key, nonce);
    }

    boolean hasKey() {
        return key != null;
    }

    /** Messages so far, for the 2^32 rekey rule. */
    public long nonce() {
        return nonce;
    }

    public byte[] encrypt(byte[] ad, byte[] plaintext) {
        if (key == null) return plaintext;
        if (nonce == MAX_NONCE) throw new IllegalStateException("nonce exhausted");
        byte[] out = RelayCrypto.seal(key, nonce, ad, plaintext);
        nonce++;
        return out;
    }

    public byte[] encrypt(byte[] plaintext) {
        return encrypt(EMPTY, plaintext);
    }

    public byte[] decrypt(byte[] ad, byte[] ciphertext) throws RelayCrypto.DecryptFailure {
        if (key == null) return ciphertext;
        if (nonce == MAX_NONCE) throw new RelayCrypto.DecryptFailure("nonce exhausted");
        byte[] out = RelayCrypto.open(key, nonce, ad, ciphertext);
        nonce++;
        return out;
    }

    public byte[] decrypt(byte[] ciphertext) throws RelayCrypto.DecryptFailure {
        return decrypt(EMPTY, ciphertext);
    }

    /** Noise § 11.3: only the key changes, the counter carries on. */
    public void rekey() {
        byte[] sealed = RelayCrypto.seal(key, MAX_NONCE, EMPTY, new byte[32]);
        byte[] next = new byte[32];
        System.arraycopy(sealed, 0, next, 0, 32);
        key = next;
    }
}
