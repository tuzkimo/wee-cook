//! 常亮屏插件：Kotlin 侧是 `gen/android/.../KeepAwakePlugin.kt`（`FLAG_KEEP_SCREEN_ON`）。
//!
//! 纯 Kotlin 插件没有自己的 crate，JS 侧的 `plugin:keep-awake|*` 命令必须由 Rust 侧
//! 把 Kotlin 类实例注册进 PluginManager 才存在（Tauri 2 没有 `MainActivity.registerPlugin`）。
//! ACL 清单在 `build.rs` 里用 InlinedPlugin 生成。

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new("keep-awake")
        .setup(|_app, api| {
            api.register_android_plugin("cn.tuzkimo.wee_cook", "KeepAwakePlugin")?;
            Ok(())
        })
        .build()
}
