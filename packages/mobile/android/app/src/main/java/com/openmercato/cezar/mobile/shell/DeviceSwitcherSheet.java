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
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import com.openmercato.cezar.mobile.shell.relay.RelayLink;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The native device switcher over a server page: one row per saved server, its dot live while the
 * sheet is open. Probing warms the relay links, so the switch that follows is fast. Main thread only;
 * nothing here is visible to page script.
 */
final class DeviceSwitcherSheet {
    interface Host {
        void switchTo(ServerRecord server);

        void leaveTo(String screen);
    }

    private static final int SHEET = 0xFF171717;
    private static final int FG = Color.WHITE;
    private static final int MUTED = 0xFFA3A3A3;
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
    private final Map<String, Row> rows = new HashMap<>();
    private final Dialog dialog;
    private String switching;
    private boolean closed;

    private final class Row {
        final ServerRecord server;
        final View view;
        final View dot;
        final ProgressBar spinner;
        DeviceSwitch.Status status;

        Row(ServerRecord server, View view, View dot, ProgressBar spinner) {
            this.server = server;
            this.view = view;
            this.dot = dot;
            this.spinner = spinner;
        }
    }

    DeviceSwitcherSheet(Activity activity, Host host, ShellConnector connector, RelayConnections relay, String currentId, DeviceSwitch.Status current) {
        this.activity = activity;
        this.host = host;
        this.connector = connector;
        this.relay = relay;
        this.currentId = currentId;
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

    /** The view's own status, for the current row. */
    void current(DeviceSwitch.Status status) {
        Row row = rows.get(currentId);
        if (row != null) set(row, status);
    }

    private void close() {
        if (closed) return;
        closed = true;
        probes.shutdownNow();
        // Never the current server's link: cool() only stops what warm() started.
        if (relay != null) relay.cool(switching);
    }

    private void probe() {
        for (Row row : rows.values()) {
            if (row.server.id.equals(currentId)) continue;
            set(row, DeviceSwitch.Status.CHECKING);
            if (row.server.relay != null) probeRelay(row);
            else probeDirect(row);
        }
        main.postDelayed(() -> {
            if (closed) return;
            for (Row row : rows.values()) {
                if (row.status == DeviceSwitch.Status.CHECKING) set(row, DeviceSwitch.Status.OFFLINE);
            }
        }, DeviceSwitch.PROBE_MS);
    }

    private void probeRelay(Row row) {
        if (relay == null) {
            set(row, DeviceSwitch.Status.OFFLINE);
            return;
        }
        RelayLink link = relay.warm(row.server);
        if (link == null) {
            set(row, DeviceSwitch.Status.BLOCKED);
            return;
        }
        link.setListener(status -> main.post(() -> {
            if (closed) return;
            // Connecting is no answer yet: the 6 s bound decides it.
            if (!DeviceSwitch.answered(status.kind) && row.status == DeviceSwitch.Status.CHECKING) return;
            set(row, DeviceSwitch.of(status.kind));
        }));
    }

    private void probeDirect(Row row) {
        String cookies = row.server.url == null ? null : CookieManager.getInstance().getCookie(row.server.url);
        String id = row.server.id;
        probes.execute(() -> {
            HealthAnswer answer;
            try {
                answer = connector.health(id, cookies);
            } catch (RuntimeException e) {
                answer = null;
            }
            DeviceSwitch.Status next = answer == null ? DeviceSwitch.Status.OFFLINE : DeviceSwitch.of(answer.kind);
            main.post(() -> {
                if (!closed) set(row, next);
            });
        });
    }

    private void set(Row row, DeviceSwitch.Status status) {
        if (row.status == DeviceSwitch.Status.SWITCHING) return;
        row.status = status;
        boolean spin = status == DeviceSwitch.Status.SWITCHING;
        row.spinner.setVisibility(spin ? View.VISIBLE : View.GONE);
        row.dot.setVisibility(spin ? View.GONE : View.VISIBLE);
        ((GradientDrawable) row.dot.getBackground()).setColor(color(status));
        row.view.setContentDescription(DeviceSwitch.spoken(row.server.label, status, row.server.id.equals(currentId)));
    }

    private static int color(DeviceSwitch.Status status) {
        switch (status) {
            case CONNECTED:
                return 0xFF34C759;
            case ATTENTION:
                return 0xFFFFB020;
            case BLOCKED:
                return 0xFFFF453A;
            default:
                return 0xFF6B6B6B;
        }
    }

    private void tapped(Row row) {
        if (switching != null) return;
        if (row.server.id.equals(currentId)) {
            dismiss();
            return;
        }
        // The row keeps its spinner until the next view covers this one.
        set(row, DeviceSwitch.Status.SWITCHING);
        switching = row.server.id;
        host.switchTo(row.server);
    }

    private View content(List<ServerRecord> servers, DeviceSwitch.Status current) {
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

        TextView title = text("Devices", 20, FG);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(dp(20), dp(4), dp(20), dp(8));
        title.setAccessibilityHeading(true);
        column.addView(title);

        LinearLayout list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);
        for (ServerRecord server : servers) {
            Row row = row(server);
            rows.put(server.id, row);
            list.addView(row.view);
            set(row, server.id.equals(currentId) ? current : DeviceSwitch.Status.OFFLINE);
        }
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
        column.addView(action("+", "Add a device", () -> leave(ShellConnector.ADD)));
        column.addView(action("☰", "Manage devices", () -> leave(ShellConnector.LIST)));

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
        view.setPadding(dp(20), dp(8), dp(16), dp(8));
        view.setBackground(ripple());
        view.setClickable(true);
        view.setFocusable(true);

        FrameLayout marker = new FrameLayout(activity);
        View dot = new View(activity);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        dot.setBackground(circle);
        marker.addView(dot, new FrameLayout.LayoutParams(dp(10), dp(10), Gravity.CENTER));
        ProgressBar spinner = new ProgressBar(activity);
        spinner.setIndeterminate(true);
        spinner.getIndeterminateDrawable().setTint(FG);
        spinner.setVisibility(View.GONE);
        marker.addView(spinner, new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER));
        LinearLayout.LayoutParams markerSize = new LinearLayout.LayoutParams(dp(20), dp(20));
        markerSize.rightMargin = dp(14);
        view.addView(marker, markerSize);

        LinearLayout texts = new LinearLayout(activity);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView label = text(server.label, 16, FG);
        label.setSingleLine(true);
        label.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(label);
        TextView detail = text(DeviceSwitch.detail(server), 13, MUTED);
        detail.setSingleLine(true);
        detail.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(detail);
        view.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        TextView tick = text("✓", 18, ACCENT);
        tick.setTypeface(Typeface.DEFAULT_BOLD);
        tick.setVisibility(server.id.equals(currentId) ? View.VISIBLE : View.INVISIBLE);
        tick.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams tickSize = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tickSize.leftMargin = dp(12);
        view.addView(tick, tickSize);
        // The row speaks for its children.
        texts.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        marker.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);

        Row row = new Row(server, view, dot, spinner);
        view.setOnClickListener(unused -> tapped(row));
        return row;
    }

    private View action(String glyph, String label, Runnable then) {
        LinearLayout view = new LinearLayout(activity);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinimumHeight(dp(52));
        view.setPadding(dp(20), dp(6), dp(16), dp(6));
        view.setBackground(ripple());
        view.setClickable(true);
        view.setFocusable(true);
        view.setContentDescription(label);
        TextView icon = text(glyph, 18, ACCENT);
        icon.setGravity(Gravity.CENTER);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams iconSize = new LinearLayout.LayoutParams(dp(20), ViewGroup.LayoutParams.WRAP_CONTENT);
        iconSize.rightMargin = dp(14);
        view.addView(icon, iconSize);
        TextView text = text(label, 16, ACCENT);
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
