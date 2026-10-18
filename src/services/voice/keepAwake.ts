import { invoke } from "@tauri-apps/api/core";

/** Android 常亮屏；其它平台静默 no-op，永不 reject */
export async function keepScreenOn(on: boolean): Promise<void> {
  try {
    await invoke(`plugin:keep-awake|${on ? "start" : "stop"}`);
  } catch {
    // 桌面端没有这个插件，读不到插件是正常的，不该冒到页面
  }
}
