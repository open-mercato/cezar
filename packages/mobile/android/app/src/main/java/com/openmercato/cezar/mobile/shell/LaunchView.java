package com.openmercato.cezar.mobile.shell;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.openmercato.cezar.mobile.R;

/** The app's own launch screen over a server page: the splash's logo, what is happening now, or why it stopped. */
final class LaunchView extends FrameLayout {
    private final TextView status;
    private final LinearLayout problem;
    private final TextView reason;

    LaunchView(Context context, Runnable retry, Runnable servers) {
        super(context);
        setBackgroundResource(R.drawable.splash);
        // Touches wait for the page under it.
        setClickable(true);
        int dp = Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 1, getResources().getDisplayMetrics()));

        status = new TextView(context);
        status.setTextColor(0xB3FFFFFF);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        status.setGravity(Gravity.CENTER);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        LayoutParams statusAt = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        statusAt.setMargins(24 * dp, 0, 24 * dp, 72 * dp);
        addView(status, statusAt);

        problem = new LinearLayout(context);
        problem.setOrientation(LinearLayout.VERTICAL);
        problem.setGravity(Gravity.CENTER_HORIZONTAL);
        problem.setVisibility(GONE);
        TextView title = new TextView(context);
        title.setText("Connection problem");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        problem.addView(title);
        reason = new TextView(context);
        reason.setTextColor(0xCCFFFFFF);
        reason.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        reason.setGravity(Gravity.CENTER);
        reason.setPadding(0, 8 * dp, 0, 16 * dp);
        reason.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE);
        problem.addView(reason);
        LinearLayout buttons = new LinearLayout(context);
        buttons.setGravity(Gravity.CENTER);
        Button again = new Button(context);
        again.setText("Retry");
        again.setOnClickListener(view -> retry.run());
        buttons.addView(again);
        Button list = new Button(context);
        list.setText("Servers");
        list.setOnClickListener(view -> servers.run());
        buttons.addView(list);
        problem.addView(buttons);
        LayoutParams problemAt = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        problemAt.setMargins(24 * dp, 0, 24 * dp, 48 * dp);
        addView(problem, problemAt);
    }

    void status(String text) {
        problem.setVisibility(GONE);
        status.setVisibility(VISIBLE);
        if (!text.contentEquals(status.getText())) status.setText(text);
    }

    void problem(String text) {
        status.setVisibility(GONE);
        reason.setText(text);
        problem.setVisibility(VISIBLE);
    }

    boolean showingProblem() {
        return problem.getVisibility() == VISIBLE;
    }
}
