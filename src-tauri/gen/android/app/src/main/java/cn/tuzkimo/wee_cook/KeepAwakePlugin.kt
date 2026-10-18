package cn.tuzkimo.wee_cook

import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin
class KeepAwakePlugin(private val activity: android.app.Activity) : Plugin(activity) {
    @Command
    fun start(invoke: Invoke) {
        activity.runOnUiThread {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        activity.runOnUiThread {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }
}
