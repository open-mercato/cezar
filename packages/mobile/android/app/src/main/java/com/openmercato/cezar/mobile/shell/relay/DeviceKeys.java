package com.openmercato.cezar.mobile.shell.relay;

import java.util.Arrays;

/** A phone's keys for one server: fresh per server, so two cezars cannot correlate it (§ 2). */
public final class DeviceKeys {
    public final byte[] ed25519Seed;
    public final byte[] x25519Secret;

    public DeviceKeys(byte[] ed25519Seed, byte[] x25519Secret) {
        this.ed25519Seed = ed25519Seed;
        this.x25519Secret = x25519Secret;
    }

    public static DeviceKeys generate() {
        return new DeviceKeys(RelayCrypto.random(32), RelayCrypto.x25519Secret());
    }

    public byte[] relayKey() {
        return RelayCrypto.ed25519Public(ed25519Seed);
    }

    public String deviceId() {
        return RelayIds.id(relayKey());
    }

    byte[] toBytes() {
        return Bytes.concat(ed25519Seed, x25519Secret);
    }

    static DeviceKeys fromBytes(byte[] bytes) {
        if (bytes.length != 64) throw new IllegalArgumentException("bad key blob");
        return new DeviceKeys(Arrays.copyOfRange(bytes, 0, 32), Arrays.copyOfRange(bytes, 32, 64));
    }
}
