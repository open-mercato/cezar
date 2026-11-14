package com.openmercato.cezar.mobile.shell;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Deque;
import java.util.Locale;
import java.util.TimeZone;
import java.util.function.LongSupplier;

/**
 * What the last starts did, step by step, for the user to copy from the Servers screen. Steps,
 * timings, relay states and the relay's host only: never a key, a cookie, a path or page content.
 */
public final class StartupLog {
    public static final int MAX_LINES = 300;

    private final File file;
    private final LongSupplier clock;
    private final Deque<String> lines = new ArrayDeque<>();
    private long startedAt;
    private boolean loaded;

    public StartupLog(File file, LongSupplier clock) {
        this.file = file;
        this.clock = clock;
    }

    /** A new start: later lines carry their offset from it. */
    public synchronized void begin(String what) {
        startedAt = clock.getAsLong();
        add("── " + stamp(startedAt) + " " + what);
    }

    public synchronized void step(String what) {
        add("+" + (clock.getAsLong() - startedAt) + "ms " + what);
    }

    public synchronized String text() {
        load();
        StringBuilder out = new StringBuilder();
        for (String line : lines) out.append(line).append('\n');
        return out.toString();
    }

    private void add(String line) {
        load();
        lines.addLast(line.replace('\n', ' '));
        while (lines.size() > MAX_LINES) lines.removeFirst();
        save();
    }

    private void load() {
        if (loaded) return;
        loaded = true;
        if (file == null || !file.isFile()) return;
        try {
            for (String line : new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).split("\n")) {
                if (!line.isEmpty()) lines.addLast(line);
            }
        } catch (IOException e) {
            // A lost log costs nothing but the log.
        }
        while (lines.size() > MAX_LINES) lines.removeFirst();
    }

    private void save() {
        if (file == null) return;
        File temp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(text().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            temp.delete();
            return;
        }
        if (!temp.renameTo(file)) temp.delete();
    }

    private static String stamp(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }
}
