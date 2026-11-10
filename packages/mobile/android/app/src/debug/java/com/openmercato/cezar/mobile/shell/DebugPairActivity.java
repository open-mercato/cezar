package com.openmercato.cezar.mobile.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** `adb shell am start -n …/.shell.DebugPairActivity --es qr '<string>'`. Absent from release builds. */
public final class DebugPairActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ShellRoute.set("debug-qr", getIntent().getStringExtra("qr"));
        Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }
}
