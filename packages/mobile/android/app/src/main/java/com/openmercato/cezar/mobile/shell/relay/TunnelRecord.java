package com.openmercato.cezar.mobile.shell.relay;

import java.util.Arrays;

/** The padded plaintext of RELAY_PROTOCOL.md § 11, and the sizes that follow from `frameBytes` (§ 8). */
public final class TunnelRecord {
    public static final class Malformed extends Exception {
        public Malformed(String message) {
            super(message);
        }
    }

    private static final int UNIT = 256;

    private TunnelRecord() {}

    public static byte[] pad(byte[] content) {
        int length = Math.max(UNIT, (content.length + 2 + UNIT - 1) / UNIT * UNIT);
        byte[] record = new byte[length];
        record[0] = (byte) (content.length >>> 8);
        record[1] = (byte) content.length;
        System.arraycopy(content, 0, record, 2, content.length);
        return record;
    }

    public static byte[] unpad(byte[] record) throws Malformed {
        if (record.length == 0 || record.length % UNIT != 0) throw new Malformed("record length");
        int length = ((record[0] & 0xff) << 8) | (record[1] & 0xff);
        if (length + 2 > record.length) throw new Malformed("content length");
        for (int i = 2 + length; i < record.length; i++) if (record[i] != 0) throw new Malformed("padding");
        return Arrays.copyOfRange(record, 2, 2 + length);
    }

    public static int maxCiphertext(int frameBytes) {
        return Math.min(65535, frameBytes - 17);
    }

    public static int maxRecord(int frameBytes) {
        return (maxCiphertext(frameBytes) - 16) / UNIT * UNIT;
    }

    public static int maxContent(int frameBytes) {
        return maxRecord(frameBytes) - 2;
    }

    public static int maxData(int frameBytes) {
        return maxRecord(frameBytes) - 7;
    }
}
