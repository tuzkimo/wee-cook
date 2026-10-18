fn main() {
    // keep-awake 是纯 Kotlin 插件（src-tauri/gen/android/.../KeepAwakePlugin.kt），
    // 没有自己的 crate 就生成不了 ACL 清单，JS 侧 invoke 会被 ACL 直接拒掉。
    // 内联插件声明只补权限清单，不影响任何 Rust 侧注册。
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "keep-awake",
            tauri_build::InlinedPlugin::new()
                .commands(&["start", "stop"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
