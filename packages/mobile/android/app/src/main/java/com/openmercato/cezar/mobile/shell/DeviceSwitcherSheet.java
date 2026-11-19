package com.openmercato.cezar.mobile.shell;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.TypedArray;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import com.openmercato.cezar.mobile.R;
import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The native device switcher over a server page (switcher spec, "Native list"): one plain row per saved
 * server, with its avatar, name, status words and "N need you". Probing warms the relay links, so the
 * switch that follows is fast, and reads each computer's counts over its own connection. Main thread
 * only; nothing here is visible to page script.
 */
final class DeviceSwitcherSheet {
    interface Host {
        void switchTo(ServerRecord server);

        void leaveTo(String screen);
    }

    private static final int SHEET = 0xFF171717;
    private static final int FG = Color.WHITE;
    private static final int MUTED = 0xFFA3A3A3;
    private static final int GREY = 0xFF8E8E93;
    private static final int AMBER = 0xFFF5A524;
    private static final int RED = 0xFFEF4444;
    private static final int LINE = 0xFF262626;
    private static final int ACCENT = 0xFFA8F372;
    private static final int MAX_WIDTH_DP = 560;

    private final Activity activity;
    private final Host host;
    private final ShellConnector connector;
    private final RelayConnections relay;
    private final String currentId;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService probes = Executors.newCachedThreadPool(run -> {
        Thread thread = new Thread(run, "cezar-switcher-probe");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, Row> rows = new LinkedHashMap<>();
    private final LinearLayout list;
    private final Dialog dialog;
    private DeviceProbes probing;
    private String switching;
    private boolean closed;

    private final class Row {
        final ServerRecord server;
        final View view;
        final TextView words;
        final TextView need;
        final TextView tick;
        final ProgressBar spinner;
        DeviceSwitch.State state;
        long lastSeen;
        Integer needCount;

        Row(ServerRecord server, View view, TextView words, TextView need, TextView tick, ProgressBar spinner) {
            this.server = server;
            this.view = view;
            this.words = words;
            this.need = need;
            this.tick = tick;
            this.spinner = spinner;
        }

        boolean current() {
            return server.id.equals(currentId);
        }
    }

    DeviceSwitcherSheet(Activity activity, Host host, ShellConnector connector, RelayConnections relay, String currentId, DeviceSwitch.State current) {
        this.activity = activity;
        this.host = host;
        this.connector = connector;
        this.relay = relay;
        this.currentId = currentId;
        list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);
        dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(content(connector.list(), current));
        dialog.setCanceledOnTouchOutside(true);
        dialog.setOnDismissListener(unused -> close());
        place();
    }

    void show() {
        dialog.show();
        probe();
    }

    boolean showing() {
        return !closed;
    }

    void dismiss() {
        if (dialog.isShowing()) dialog.dismiss();
        else close();
    }

    /** The view's own state, for the current row. */
    void current(DeviceSwitch.State state) {
        Row row = rows.get(currentId);
        if (row != null) set(row, state);
    }

    /** The phone's clock and formats, for "Offline since …". */
    DeviceSwitch.Clock clock() {
        return clock(activity);
    }

    static DeviceSwitch.Clock clock(Activity activity) {
        return ShellServices.clock(activity);
    }

    private void close() {
        if (closed) return;
        closed = true;
        probes.shutdownNow();
        // Never the current server's link: cool() only stops what warm() started.
        if (probing != null) probing.stop(switching);
        else if (relay != null) relay.cool(switching);
    }

    private void probe() {
        for (Row row : rows.values()) if (!row.current()) set(row, DeviceSwitch.State.CHECKING);
        probing = new DeviceProbes(DeviceProbes.relayProbe(relay, probes), DeviceProbes.directProbe(connector, DeviceSwitcherSheet::cookies, probes),
                keep -> {
                    if (relay != null) relay.cool(keep);
                },
                (ms, work) -> main.postDelayed(work, ms),
                (id, answer) -> connector.sawHealth(id, answer, System.currentTimeMillis()),
                this::probed);
        probing.start(connector.list());
    }

    private static String cookies(ServerRecord server) {
        return server.url == null ? null : CookieManager.getInstance().getCookie(server.url);
    }

    /** Any thread. The row on screen keeps the view's own state: only its counts are read here. */
    private void probed(String id, DeviceProbes.Reading reading) {
        ServerListStore.Seen seen;
        try {
            seen = connector.seen(id);
        } catch (RuntimeException e) {
            return;
        }
        main.post(() -> {
            Row row = rows.get(id);
            if (closed || row == null) return;
            row.lastSeen = seen.at;
            row.needCount = seen.need();
            set(row, row.current() ? row.state : DeviceSwitch.state(reading, row.lastSeen, clock()));
        });
    }

    private void set(Row row, DeviceSwitch.State state) {
        if (row.state != null && row.state.status == DeviceSwitch.Status.SWITCHING) return;
        row.state = state;
        boolean spin = state.status == DeviceSwitch.Status.SWITCHING;
        row.words.setText(state.words);
        row.words.setTextColor(color(state.status));
        String needs = DeviceSwitch.needText(row.needCount);
        row.spinner.setVisibility(spin ? View.VISIBLE : View.GONE);
        row.tick.setVisibility(!spin && row.current() ? View.VISIBLE : View.GONE);
        row.need.setVisibility(!spin && !row.current() && needs != null ? View.VISIBLE : View.GONE);
        row.need.setText(needs);
        row.view.setContentDescription(DeviceSwitch.spoken(row.server.label, state.words, row.needCount, row.current()));
        reorder();
    }

    private static int color(DeviceSwitch.Status status) {
        switch (status) {
            case OFFLINE:
                return GREY;
            case ATTENTION:
                return AMBER;
            case BLOCKED:
                return RED;
            default:
                return MUTED;
        }
    }

    /** Rows settle into the spec's order as answers arrive; never under a switch already under way. */
    private void reorder() {
        if (switching != null || rows.isEmpty()) return;
        List<DeviceSwitch.Entry> entries = new ArrayList<>();
        for (Row row : rows.values()) {
            if (row.state == null) return;
            entries.add(new DeviceSwitch.Entry(row.server.id, row.state.status, row.needCount));
        }
        List<String> order = DeviceSwitch.order(entries, currentId);
        boolean same = list.getChildCount() == order.size();
        for (int i = 0; same && i < order.size(); i++) same = list.getChildAt(i) == rows.get(order.get(i)).view;
        if (same) return;
        list.removeAllViews();
        for (String id : order) list.addView(rows.get(id).view);
    }

    private void tapped(Row row) {
        if (switching != null) return;
        if (row.current()) {
            dismiss();
            return;
        }
        // The row keeps its spinner until the next view covers this one.
        set(row, DeviceSwitch.State.SWITCHING);
        switching = row.server.id;
        host.switchTo(row.server);
    }

    private View content(List<ServerRecord> servers, DeviceSwitch.State current) {
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(0, dp(8), 0, dp(12));
        View handle = new View(activity);
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(0xFF3A3A3A);
        pill.setCornerRadius(dp(2));
        handle.setBackground(pill);
        LinearLayout.LayoutParams handleSize = new LinearLayout.LayoutParams(dp(36), dp(4));
        handleSize.gravity = Gravity.CENTER_HORIZONTAL;
        handleSize.bottomMargin = dp(8);
        // A card on a tablet is not dragged.
        if (!tablet()) column.addView(handle, handleSize);

        for (ServerRecord server : servers) {
            ServerListStore.Seen seen = connector.seen(server.id);
            Row row = row(server);
            row.lastSeen = seen.at;
            row.needCount = seen.need();
            rows.put(server.id, row);
        }
        for (Row row : rows.values()) set(row, row.current() ? current : DeviceSwitch.State.CHECKING);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(list);
        int maxRows = (int) (activity.getResources().getDisplayMetrics().heightPixels * 0.55);
        column.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.post(() -> {
            if (scroll.getHeight() > maxRows) scroll.getLayoutParams().height = maxRows;
            scroll.requestLayout();
        });

        View line = new View(activity);
        line.setBackgroundColor(LINE);
        LinearLayout.LayoutParams lineSize = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(1) / 2));
        lineSize.topMargin = dp(6);
        lineSize.bottomMargin = dp(6);
        column.addView(line, lineSize);
        column.addView(action(R.drawable.ic_plus, "Connect another cezar", ACCENT, () -> leave(ShellConnector.ADD)));
        column.addView(action(R.drawable.ic_gear, "Manage cezars", FG, () -> leave(ShellConnector.LIST)));

        GradientDrawable sheet = new GradientDrawable();
        sheet.setColor(SHEET);
        float radius = dp(16);
        sheet.setCornerRadii(tablet() ? new float[] {radius, radius, radius, radius, radius, radius, radius, radius}
                : new float[] {radius, radius, radius, radius, 0, 0, 0, 0});
        column.setBackground(sheet);
        return column;
    }

    private void leave(String screen) {
        if (switching != null) return;
        dismiss();
        host.leaveTo(screen);
    }

    private Row row(ServerRecord server) {
        LinearLayout view = new LinearLayout(activity);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinimumHeight(dp(60));
        view.setPadding(dp(20), dp(10), dp(20), dp(10));
        view.setBackground(ripple());
        view.setClickable(true);
        view.setFocusable(true);

        LinearLayout.LayoutParams avatarSize = new LinearLayout.LayoutParams(dp(40), dp(40));
        avatarSize.rightMargin = dp(13);
        view.addView(avatar(server.label, 40), avatarSize);

        LinearLayout texts = new LinearLayout(activity);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView label = text(server.label, 16, FG);
        label.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        label.setSingleLine(true);
        label.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(label);
        TextView words = text("", 13, MUTED);
        words.setSingleLine(true);
        words.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(words);
        view.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        LinearLayout.LayoutParams sideSize = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sideSize.leftMargin = dp(12);
        TextView tick = text("✓", 20, ACCENT);
        tick.setTypeface(Typeface.DEFAULT_BOLD);
        view.addView(tick, sideSize);
        TextView need = text("", 13, AMBER);
        need.setTypeface(Typeface.DEFAULT_BOLD);
        view.addView(need, new LinearLayout.LayoutParams(sideSize));
        ProgressBar spinner = new ProgressBar(activity);
        spinner.setIndeterminate(true);
        spinner.getIndeterminateDrawable().setTint(FG);
        LinearLayout.LayoutParams spinnerSize = new LinearLayout.LayoutParams(dp(20), dp(20));
        spinnerSize.leftMargin = dp(12);
        view.addView(spinner, spinnerSize);
        // The row speaks for its children.
        for (int i = 0; i < view.getChildCount(); i++) {
            view.getChildAt(i).setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }

        Row row = new Row(server, view, words, need, tick, spinner);
        view.setOnClickListener(unused -> tapped(row));
        return row;
    }

    /** A circle in the name's colour with white initials, or the laptop glyph when the name has no letters. */
    private View avatar(String name, int sizeDp) {
        FrameLayout frame = new FrameLayout(activity);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Avatar.color(name));
        frame.setBackground(circle);
        String initials = Avatar.initials(name);
        if (initials.isEmpty()) {
            ImageView glyph = new ImageView(activity);
            glyph.setImageResource(R.drawable.ic_laptop);
            frame.addView(glyph, new FrameLayout.LayoutParams(dp(sizeDp / 2), dp(sizeDp / 2), Gravity.CENTER));
        } else {
            TextView letters = text(initials, Math.round(sizeDp * 0.38f), Color.WHITE);
            letters.setTypeface(Typeface.DEFAULT_BOLD);
            letters.setGravity(Gravity.CENTER);
            letters.setIncludeFontPadding(false);
            frame.addView(letters, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        return frame;
    }

    private View action(int icon, String label, int color, Runnable then) {
        LinearLayout view = new LinearLayout(activity);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinimumHeight(dp(52));
        view.setPadding(dp(20), dp(6), dp(20), dp(6));
        view.setBackground(ripple());
        view.setClickable(true);
        view.setFocusable(true);
        view.setContentDescription(label);
        ImageView glyph = new ImageView(activity);
        glyph.setImageResource(icon);
        glyph.setColorFilter(color);
        glyph.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        // Centred under the 40 dp avatars above.
        LinearLayout.LayoutParams iconSize = new LinearLayout.LayoutParams(dp(20), dp(20));
        iconSize.leftMargin = dp(10);
        iconSize.rightMargin = dp(23);
        view.addView(glyph, iconSize);
        TextView text = text(label, 16, color);
        text.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        view.addView(text);
        view.setOnClickListener(unused -> then.run());
        return view;
    }

    /** A bottom sheet on a phone; on a tablet a centred card, never 1600 px wide. */
    private void place() {
        Window window = dialog.getWindow();
        if (window == null) return;
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
        int width = Math.min(metrics.widthPixels, dp(MAX_WIDTH_DP));
        window.setLayout(width, ViewGroup.LayoutParams.WRAP_CONTENT);
        window.setGravity(tablet() ? Gravity.CENTER : Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.setDimAmount(0.5f);
        window.setWindowAnimations(android.R.style.Animation_InputMethod);
    }

    private boolean tablet() {
        return activity.getResources().getConfiguration().smallestScreenWidthDp >= 600;
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        return view;
    }

    private android.graphics.drawable.Drawable ripple() {
        TypedArray attrs = activity.obtainStyledAttributes(new int[] {android.R.attr.selectableItemBackground});
        android.graphics.drawable.Drawable drawable = attrs.getDrawable(0);
        attrs.recycle();
        return drawable;
    }

    private int dp(int value) {
        return (int) (value * activity.getResources().getDisplayMetrics().density + 0.5f);
    }
}
