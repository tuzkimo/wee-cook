#[cfg(target_os = "android")]
mod keep_awake;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_tts::init());

    // 桌面端不做语音（规格 §3）：stt 的桌面实现要拉整套 whisper.cpp。
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_stt::init());
    // 常亮屏只有 Android 实现，其它平台静默 no-op（keepAwake.ts 吃异常）。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(keep_awake::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
