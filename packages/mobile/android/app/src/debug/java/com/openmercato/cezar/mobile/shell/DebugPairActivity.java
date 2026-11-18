package com.openmercato.cezar.mobile.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * `adb shell am start -n …/.shell.DebugPairActivity --es qr '<string>'`, or `--es switcher <serverId>`
 * to open that server's view with the device switcher up. Absent from release builds.
 */
public final class DebugPairActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String switcher = getIntent().getStringExtra("switcher");
        if (switcher != null) {
            ServerRecord server = ShellServices.connector(this).server(switcher);
            if (server != null) {
                Intent view = new Intent(this, ServerActivity.class);
                view.putExtra(ServerActivity.EXTRA_SERVER_ID, server.id);
                view.putExtra(ServerActivity.EXTRA_URL, server.relay != null ? DeviceSwitch.TASKS : server.origin().url(DeviceSwitch.TASKS));
                view.putExtra(ServerActivity.EXTRA_DEBUG_SWITCHER, true);
                startActivity(view);
            }
            finish();
            return;
        }
        ShellRoute.set("debug-qr", getIntent().getStringExtra("qr"));
        Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }
}
