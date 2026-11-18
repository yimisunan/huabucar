package local.catcanvas.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

/** Receives Termux's explicit command-result PendingIntent, including startup failures. */
public final class CommandResultReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String requestId = intent.getStringExtra("requestId");
        Bundle result = intent.getBundleExtra("result");
        if (requestId == null || result == null) return;
        int exitCode = result.getInt("exitCode", -1);
        int error = result.getInt("err", 0);
        String detail = result.getString("errmsg", "");
        if (detail.isEmpty()) detail = result.getString("stderr", "");
        if (detail.isEmpty()) detail = result.getString("stdout", "");
        detail = detail.trim();
        if (detail.length() > 1800) detail = detail.substring(detail.length() - 1800);
        String message = "Termux 启动命令已退出（" + exitCode + "）。";
        if (!detail.isEmpty()) message += "\n" + detail;
        context.getSharedPreferences("command-results", Context.MODE_PRIVATE).edit()
                .putString("requestId", requestId).putString("error", message).apply();
        Log.i("CatCanvasLauncher", "Termux command completed: exit=" + exitCode + " err=" + error);
    }
}
