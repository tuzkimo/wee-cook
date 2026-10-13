# 菜谱增删改查 · 本轮状态与遗留项

2026-10-13 · 对应设计 `docs/superpowers/specs/2026-10-13-recipe-crud-design.md`、实施计划 `docs/superpowers/plans/2026-10-13-recipe-crud.md`

这份文档只记两件事：**怎么验的**、**已知的取舍**。功能清单与用法见 `README.md`，实现细节见计划与代码。

---

## 1. 真机验证：拍照、相册、图片显示

**结论：拍照唤起相机、相册选图、asset protocol 显示图片三条路都已在真机（小米 HyperOS / Android 16，arm64-v8a）上跑通。**

- 拍照走 webview 的 `<input type="file" accept="image/*" capture="environment">`，**零额外依赖**，不必引入相机插件（设计 §12 风险 1 关闭）。
- 图片显示依赖 `convertFileSrc()` + asset protocol（`tauri.conf.json` 的 `assetProtocol` scope 与 CSP 的 `img-src`），真机上正常渲染（设计 §12 风险 2 关闭）。
- 顺带确认：`initDb()` 在 mount 之前 await 不会造成白屏（设计 §12 风险 3 关闭）；安卓首次建表可用。

后续如需重装调试：`npm run tauri -- android build --apk --debug`，产物在 `src-tauri/gen/android/app/build/outputs/apk/<abi>/debug/`。若 `adb install` 报 `INSTALL_FAILED_USER_RESTRICTED`（小米/澎湃的默认拦截），在开发者选项里打开「通过 USB 安装」，或把 APK 拷到手机上用文件管理器装。

---

## 2. 已知取舍：子表写入没有事务

`src/stores/recipe.ts` 的 `update()` 上方有一条 `shortcut:` 注释：`plugin-sql` 用连接池，不保证 `BEGIN` 与后续语句落在同一条连接上，所以子表更新走「**先插新行、再软删旧行**」，而不是事务。

- 方向是安全的：中途崩溃最坏留下重复行（可见、可再保存一次修掉），不会丢数据。
- `create()` 是同一形状：先插父行、再插步骤与食材，同样没有事务。中途失败会留下一条没有子行的菜谱（详情页能打开、能再编辑保存）。
- 真需要原子性时改走 Rust 侧命令；在这之前，异常中断后的残留行需要人工重新保存一次。
