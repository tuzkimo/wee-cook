# 菜谱增删改查 · 本轮状态与未验证项

2026-10-13 · 分支 `feat/recipe-crud` · 对应设计 `docs/superpowers/specs/2026-10-13-recipe-crud-design.md`、实施计划 `docs/superpowers/plans/2026-10-13-recipe-crud.md`

这份文档只记三件事：**没验证过的**、**故意没做的**、**已知的取舍**。功能清单与用法见 `README.md`，实现细节见计划与代码。

---

## 1. 真机未验证：拍照唤起相机、asset protocol 显示图片

**结论：两条路都只有「能在桌面上构建出 APK」这一条证据，设备上的实测为零。**

- 设备：`24091RPADC`（小米 HyperOS / Android 16，arm64-v8a），`adb devices` 可见。
- 拦路的不是代码：`adb install` 报 `INSTALL_FAILED_USER_RESTRICTED`，设备通知原文「应用安装拦截 —— 已拦截通过 USB 安装的一起做饭」；改走文件管理器点 APK 安装，走到「继续安装」时弹的是小米账号登录（`com.xiaomi.account`），装不下来。
- 详细命令、输出与截图见 `.superpowers/sdd/2026-10-13-recipe-crud/task-7-report.md` 的 Step 7 一节；组件源码末尾也留了同一段结论（`src/components/ImagePicker.vue`）。

**已经有的**：debug APK 已构建，路径 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（构建命令 `npm run tauri -- android build --apk --debug`）。注意：APK 是构建产物，源码改过之后要重新构建才能复用。

**要人接手的手工验证（装上去之后）**：

1. 拍照：新建菜谱 → 封面图 → 拍照 → 相机是否被唤起；拍完回页面后是否显示缩略图；杀掉 App 重开，图是否还在。
2. 相册：封面图 → 从相册选 → 选一张 → 缩略图是否显示。
3. asset protocol 显示：给某一步加步骤图，回详情页看图片是否真的显示（Android 上 `convertFileSrc()` 返回 `http://asset.localhost/...`，依赖 CSP 放行与 asset scope 配置）。

装上设备的前置操作二选一：① 开发者选项里打开「通过 USB 安装」（然后 `adb install -r`）；② 手机上登录一次小米账号，再从文件管理器点 APK 安装。

如果第 1 条不通，按设计 §12 风险 1 的预案改走社区相机插件，改动收敛在 `ImagePicker.vue` 内部。第 3 条不通则先查 `src-tauri/tauri.conf.json` 的 `assetProtocol` scope 与 CSP。

---

## 2. 故意没做：列表页卡片长按「编辑 / 删除」

设计 §6.3 写了列表页卡片「长按/滑动出「编辑 / 删除」」，但实施计划的 Task 8 任务文本与测试清单都没有这一条，本轮**没有实现**。

- 现状：编辑与删除都能从详情页右上角到达（点卡片 → 详情 → 编辑/删除），功能不缺，只是多一次点击。
- 这是一条**待决事项**，不是已完成项：要么下一轮补上列表页长按手势，要么从设计 §6.3 里删掉这句，两条路都需要人拍板。

---

## 3. 已知取舍：子表写入没有事务

`src/stores/recipe.ts` 的 `update()` 上方有一条 `shortcut:` 注释：`plugin-sql` 用连接池，不保证 `BEGIN` 与后续语句落在同一条连接上，所以子表更新走「**先插新行、再软删旧行**」，而不是事务。

- 方向是安全的：中途崩溃最坏留下重复行（可见、可再保存一次修掉），不会丢数据。
- `create()` 是同一形状：先插父行、再插步骤与食材，同样没有事务。中途失败会留下一条没有子行的菜谱（详情页能打开、能再编辑保存）。
- 真需要原子性时改走 Rust 侧命令；在这之前，异常中断后的残留行需要人工重新保存一次。
