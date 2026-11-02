package com.openmercato.cezar.mobile.shell;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Whole-file reads and writes. java.nio.file is API 26; this app starts at 24 (spec "New native code"). */
final class FileBytes {
    private FileBytes() { }

    static byte[] read(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int count = in.read(chunk); count != -1; count = in.read(chunk)) out.write(chunk, 0, count);
            return out.toByteArray();
        }
    }

    static void write(File file, byte[] bytes) throws IOException {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
    }
}
