package com.openmercato.cezar.mobile.shell;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;

/**
 * Ends the app process and opens the server list again. The webview's auth cache has no API and
 * lives in that process, so this is what Forget server needs (spec M2 item 9). It runs in a process
 * of its own, because an activity started from the dying process dies with it.
 */
public final class RestartActivity extends Activity {
    public static final String EXTRA_SHOW_LIST = "showList";
    private static final String EXTRA_PID = "pid";

    public static void restart(Activity from) {
        from.startActivity(new Intent(from, RestartActivity.class).putExtra(EXTRA_PID, Process.myPid()));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Process.killProcess(getIntent().getIntExtra(EXTRA_PID, -1));
        Context context = getApplicationContext();
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        intent.putExtra(EXTRA_SHOW_LIST, true);
        startActivity(intent);
        finish();
        Runtime.getRuntime().exit(0);
    }
}
