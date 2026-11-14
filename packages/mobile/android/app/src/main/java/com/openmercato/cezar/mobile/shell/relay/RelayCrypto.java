package com.openmercato.cezar.mobile.shell.relay;

import java.security.SecureRandom;
import org.bouncycastle.crypto.InvalidCipherTextException;
import org.bouncycastle.crypto.agreement.X25519Agreement;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.generators.HKDFBytesGenerator;
import org.bouncycastle.crypto.generators.PKCS5S2ParametersGenerator;
import org.bouncycastle.crypto.modes.ChaCha20Poly1305;
import org.bouncycastle.crypto.params.AEADParameters;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.params.HKDFParameters;
import org.bouncycastle.crypto.params.KeyParameter;
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.X25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

/** Every primitive this client uses, each a direct call into BouncyCastle's lightweight API. None is written here. */
public final class RelayCrypto {
    public static final class DecryptFailure extends Exception {
        DecryptFailure(String message) {
            super(message);
        }
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    private RelayCrypto() {}

    public static byte[] random(int length) {
        byte[] out = new byte[length];
        RANDOM.nextBytes(out);
        return out;
    }

    public static byte[] sha256(byte[]... parts) {
        SHA256Digest digest = new SHA256Digest();
        for (byte[] part : parts) digest.update(part, 0, part.length);
        byte[] out = new byte[32];
        digest.doFinal(out, 0);
        return out;
    }

    public static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) {
        HKDFBytesGenerator generator = new HKDFBytesGenerator(new SHA256Digest());
        generator.init(new HKDFParameters(ikm, salt, info));
        byte[] out = new byte[length];
        generator.generateBytes(out, 0, length);
        return out;
    }

    public static byte[] pbkdf2(byte[] password, byte[] salt, int iterations, int length) {
        PKCS5S2ParametersGenerator generator = new PKCS5S2ParametersGenerator(new SHA256Digest());
        generator.init(password, salt, iterations);
        return ((KeyParameter) generator.generateDerivedMacParameters(length * 8)).getKey();
    }

    public static byte[] x25519Secret() {
        return random(32);
    }

    public static byte[] x25519Public(byte[] secret) {
        return new X25519PrivateKeyParameters(secret, 0).generatePublicKey().getEncoded();
    }

    /** Refuses an all-zero output, in `XXpsk3` and `KK` (§ 9.3). */
    public static byte[] x25519(byte[] secret, byte[] peer) throws DecryptFailure {
        byte[] out = new byte[32];
        try {
            X25519Agreement agreement = new X25519Agreement();
            agreement.init(new X25519PrivateKeyParameters(secret, 0));
            agreement.calculateAgreement(new X25519PublicKeyParameters(peer, 0), out, 0);
        } catch (IllegalStateException e) {
            throw new DecryptFailure("low-order X25519 key");
        }
        int bits = 0;
        for (byte b : out) bits |= b;
        if (bits == 0) throw new DecryptFailure("low-order X25519 key");
        return out;
    }

    public static byte[] ed25519Public(byte[] seed) {
        return new Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().getEncoded();
    }

    public static byte[] ed25519Sign(byte[] seed, byte[] message) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, new Ed25519PrivateKeyParameters(seed, 0));
        signer.update(message, 0, message.length);
        return signer.generateSignature();
    }

    public static boolean ed25519Verify(byte[] publicKey, byte[] message, byte[] signature) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(false, new Ed25519PublicKeyParameters(publicKey, 0));
        signer.update(message, 0, message.length);
        return signer.verifySignature(signature);
    }

    /** ChaCha20-Poly1305 with Noise's nonce: four zero bytes, then the counter as a little-endian uint64 (§ 16). */
    public static byte[] seal(byte[] key, long counter, byte[] ad, byte[] plaintext) {
        ChaCha20Poly1305 cipher = cipher(true, key, counter, ad);
        byte[] out = new byte[plaintext.length + 16];
        int written = cipher.processBytes(plaintext, 0, plaintext.length, out, 0);
        try {
            cipher.doFinal(out, written);
        } catch (InvalidCipherTextException e) {
            throw new IllegalStateException(e);
        }
        return out;
    }

    public static byte[] open(byte[] key, long counter, byte[] ad, byte[] ciphertext) throws DecryptFailure {
        if (ciphertext.length < 16) throw new DecryptFailure("ciphertext too short");
        ChaCha20Poly1305 cipher = cipher(false, key, counter, ad);
        byte[] out = new byte[ciphertext.length - 16];
        int written = cipher.processBytes(ciphertext, 0, ciphertext.length, out, 0);
        try {
            cipher.doFinal(out, written);
        } catch (InvalidCipherTextException | IllegalStateException e) {
            throw new DecryptFailure("authentication failed");
        }
        return out;
    }

    private static ChaCha20Poly1305 cipher(boolean encrypt, byte[] key, long counter, byte[] ad) {
        byte[] nonce = new byte[12];
        for (int i = 0; i < 8; i++) nonce[4 + i] = (byte) (counter >>> (8 * i));
        ChaCha20Poly1305 cipher = new ChaCha20Poly1305();
        cipher.init(encrypt, new AEADParameters(new KeyParameter(key), 128, nonce, ad));
        return cipher;
    }
}
