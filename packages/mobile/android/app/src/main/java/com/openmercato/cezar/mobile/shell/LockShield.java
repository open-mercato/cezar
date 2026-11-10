package com.openmercato.cezar.mobile.shell;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

/** The opaque lock screen. Back must not reach the page under it, so it leaves the app instead. */
final class LockShield extends LinearLayout {
    private static final int BACKGROUND = 0xFF0D0D0D;

    private final TextView message;
    private final OnBackPressedCallback back;

    LockShield(ComponentActivity activity, Runnable unlock) {
        super(activity);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setBackgroundColor(BACKGROUND);
        // A touch must never reach what is behind, even for the frame before it hides.
        setClickable(true);
        int pad = dp(activity, 24);
        setPadding(pad, pad, pad, pad);
        addView(text(activity, "Cezar is locked", 22));
        message = text(activity, "", 14);
        message.setPadding(0, pad / 2, 0, pad / 2);
        addView(message);
        Button button = new Button(activity);
        button.setText("Unlock");
        button.setOnClickListener(view -> unlock.run());
        addView(button, new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(activity, 48)));
        back = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                ((Activity) activity).moveTaskToBack(true);
            }
        };
        // Bound, as ServerActivity's is: an unbound one ranks below it after ON_START re-adds it.
        activity.getOnBackPressedDispatcher().addCallback(activity, back);
    }

    void show(String text) {
        message.setText(text);
    }

    void release() {
        back.remove();
    }

    private static TextView text(Context context, String value, int sp) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(Color.WHITE);
        view.setTextSize(sp);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private static int dp(Context context, int value) {
        return (int) (value * context.getResources().getDisplayMetrics().density);
    }
}
