package com.openmercato.cezar.mobile;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** Framework adapter: hosts the connect page and nothing else. */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConnectionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** The server view sent the user back: the page re-reads the route through launch(). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (bridge != null) bridge.reload();
    }
}
