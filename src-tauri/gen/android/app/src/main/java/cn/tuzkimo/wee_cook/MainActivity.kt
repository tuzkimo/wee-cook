package cn.tuzkimo.wee_cook

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 应用主 Activity。除 Tauri 的启动骨架外，还负责接住系统分享进来的截图：
 * 把字节拷进 App 私有 inbox（`cacheDir/share-inbox/`），供前端拉取。
 *
 * 契约：
 *  - `<uuid>.bin` 原图字节（不做任何格式判定，准入判据只有字节头，判定在前端）
 *  - `pending.json` `{"v":1,"kind":"image","file":"…","count":N}` 或
 *    `{"v":1,"kind":"error","code":"no_stream"|"read_failed"|"source_too_large","id":"<uuid>"}`
 *  - 原子写（tmp + rename）⇒ 前端永远不会读到半截 JSON
 *  - latest wins：写新 payload 之前，先删掉旧 payload 引用的那张图
 *
 * ⚠️ 这里不写任何用户可见中文：错误只出 code，文案在前端。
 * ⚠️ 日志不打图片 URI 与字节，只打数量/字节数/结果。
 */
class MainActivity : TauriActivity() {
  /** 已经投递过的分享指纹（跨 Activity 重建保留，见 `onSaveInstanceState`）。 */
  private var handledShare: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    shareDir()
    handledShare = savedInstanceState?.getString(STATE_HANDLED_SHARE)
    // 不能只认 `savedInstanceState == null`：Activity 被系统回收后重建时，**新的**分享意图
    // 也是从 onCreate 进来的（不走 onNewIntent），只认冷启动会静默丢掉这次分享。
    // 也不能无条件投递：重建时 intent 还可能是上一次那份，重复投递会让用户看到一张旧图。
    // ⇒ 按"这次的分享是不是同一份"判（见 shareFingerprint）。
    if (shareFingerprint(intent) != handledShare) dispatchSharedImage(intent)
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putString(STATE_HANDLED_SHARE, handledShare)
  }

  override fun onNewIntent(intent: Intent) {
    // 签名与生成代码逐字一致；super 负责转发给 PluginManager
    super.onNewIntent(intent)
    setIntent(intent)
    // singleTask 复用实例走这条 ⇒ 一定是新的一次分享，不需要比对指纹
    dispatchSharedImage(intent)
  }

  /**
   * 把拷贝丢到后台单线程去跑。
   *
   * 不在主线程拷：`content://` 背后的云端 provider（相册、网盘）会在 `openInputStream` /
   * `read` 上阻塞数秒 ⇒ 冷启动白屏、热启动卡住输入分发（ANR）。
   */
  private fun dispatchSharedImage(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    handledShare = shareFingerprint(intent)
    inboxExecutor.execute { captureSharedImage(intent) }
  }

  /**
   * 分享意图的指纹：动作 + 类型 + 第一张图的 URI。
   *
   * 唯一用途是判断"Activity 重建时拿到的 intent 是不是上次已经处理过的那一份"。
   * 按内容比而不是按对象比：系统重建时重新 parcel 出来的是另一个对象。
   * 代价是"紧接着重建 + 又分享同一张图"会被当成重复跳过 —— 用户再分享一次即可，
   * 比"新的分享被静默丢掉"或"同一张图被处理两遍"都轻。
   */
  private fun shareFingerprint(intent: Intent?): String? {
    val action = intent?.action ?: return null
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
    val first = streamUris(intent).firstOrNull()
    return "$action|${intent.type}|${first ?: ""}"
  }

  /**
   * 分享意图里的图片 URI 列表，两处（指纹与拷贝）共用，且**绝不抛**。
   *
   * 为什么必须兜：`IntentCompat.getParcelableArrayListExtra` 在 API<34 是**未检查转换**，
   * 发送方把单个 `Uri` 或 `Parcelable[]` 放进 `ACTION_SEND_MULTIPLE` 的 `EXTRA_STREAM` 时，
   * 调用点会抛 `ClassCastException` —— 指纹发生在 `onCreate`（主线程），拷贝在后台线程，
   * 任一线程的未捕获异常都会直接杀进程。畸形 extra 一律按“没有 stream”处理。
   */
  private fun streamUris(rawIntent: Intent?): List<Uri> {
    val intent = rawIntent ?: return emptyList()
    return runCatching {
      when (intent.action) {
        Intent.ACTION_SEND_MULTIPLE ->
          IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            ?.filterNotNull()
        Intent.ACTION_SEND ->
          listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        else -> null
      }
    }.getOrNull().orEmpty()
  }

  /** 把分享进来的图片拷进 inbox（在后台线程执行）。 */
  private fun captureSharedImage(intent: Intent) {
    val uris = streamUris(intent)
    if (uris.isEmpty()) {
      Log.w(TAG, "分享里没有 stream ⇒ no_stream")
      writeErrorPayload(CODE_NO_STREAM)
      return
    }

    val dir = shareDir()
    val target = File(dir, "${UUID.randomUUID()}.bin")
    var tooLarge = false
    var total = 0L

    val copied = try {
      contentResolver.openInputStream(uris.first())?.use { input ->
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          while (!tooLarge) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > SHARE_SOURCE_MAX_BYTES) {
              tooLarge = true
              break
            }
            output.write(buffer, 0, read)
          }
          !tooLarge
        }
      } ?: false
    } catch (e: Exception) {
      // 只打异常类型：异常的 message 里可能带 URI
      Log.w(TAG, "读分享的图片失败（${e.javaClass.simpleName}）⇒ read_failed")
      false
    }

    if (!copied) {
      target.delete()
      writeErrorPayload(if (tooLarge) CODE_SOURCE_TOO_LARGE else CODE_READ_FAILED)
      return
    }

    Log.i(TAG, "已落盘 ${total}B，本次分享 ${uris.size} 张（取第一张）")
    // 多图只取第一张，把总数带上让前端出一行提示
    sweepOrphanBinaries(target)
    writeAtomicJson("""{"v":1,"kind":"image","file":"${target.name}","count":${uris.size}}""")
  }

  /**
   * 清掉不再被引用的 `.bin`。
   *
   * "目录里最多两个文件"建立在"删除一定成功"上，而前端 compare-and-delete 会故意不删
   * （那是保护用户刚分享的那次）、进程也可能在两次删除之间被杀 ⇒ 会留下没人引用的孤儿
   * （每个上限 8 MiB）。每次成功落盘后扫一遍即可：一次 `listFiles`，且只删 `.bin`。
   */
  private fun sweepOrphanBinaries(keep: File) {
    runCatching {
      shareDir().listFiles()?.forEach { file ->
        if (file.name.endsWith(".bin") && file.name != keep.name) {
          runCatching { file.delete() }
        }
      }
    }.onFailure { Log.w(TAG, "清理 inbox 孤儿失败（${it.javaClass.simpleName}）") }
  }

  private fun writeErrorPayload(code: String) {
    // 带上唯一 id：同一个 code 两次写出的 JSON 若逐字节相同，前端按原文去重会把第二次
    // 当成"这次没有分享" —— 用户看到的是"分享进来没反应"。前端只挑已知键，多的 id 不参与解析。
    writeAtomicJson("""{"v":1,"kind":"error","code":"$code","id":"${UUID.randomUUID()}"}""")
  }

  /** 原子写 `pending.json`，并先让旧 payload 引用的图片让位（latest wins）。 */
  private fun writeAtomicJson(json: String) {
    // 写盘也必须兜异常：cacheDir 不可写 / 磁盘满时 writeText 抛 IOException，逃出去会打崩
    // onCreate / onNewIntent。写不进去时前端把"没有 pending.json"当"没有分享"。
    runCatching {
      val dir = shareDir()
      oldInboxFile(dir)?.let { old -> runCatching { old.delete() } }
      val pending = File(dir, PENDING)
      val tmp = File(dir, "$PENDING.tmp")
      tmp.writeText(json)
      if (!tmp.renameTo(pending)) {
        // rename 失败（极罕见）⇒ 退化成直接写：宁可让前端读到内容，也不要静默丢掉这次分享
        pending.writeText(json)
        tmp.delete()
      }
    }.onFailure { Log.w(TAG, "写 inbox 失败（${it.javaClass.simpleName}）") }
  }

  /** 旧 payload 引用的图片文件；名字由我们生成，这里仍然拒绝任何路径分隔符（防御性）。 */
  private fun oldInboxFile(dir: File): File? {
    val pending = File(dir, PENDING)
    if (!pending.exists()) return null
    return runCatching {
      val name = org.json.JSONObject(pending.readText()).optString("file")
      if (name.isEmpty() || name.contains('/') || name.contains("..")) null else File(dir, name)
    }.getOrNull()
  }

  private fun shareDir(): File = File(cacheDir, SHARE_DIR).apply { mkdirs() }

  private companion object {
    /**
     * 分享的拷贝串行执行：多次分享按顺序写盘 ⇒ latest wins 语义不变。
     * 必须放在 companion（进程级）而不是实例字段：Activity 重建（旋转/深色模式/分屏/字体
     * 变化，`TauriActivity` 未声明 `configChanges`）时旧实例的线程还在跑，两个池就是两个线程
     * 同时写同一份 `pending.json.tmp`（`writeText` 会截断，rename 可能发布出半截内容）。
     * 全局一个池同时让旧实例不再泄漏、线程不会滞留。
     */
    val inboxExecutor = Executors.newSingleThreadExecutor()

    /** Logcat tag：本任务无单测，真机验收靠它定位。 */
    const val TAG = "WeeCook/Share"

    /** inbox 子目录与 payload 文件名（契约见任务 13 的前端消费方） */
    const val SHARE_DIR = "share-inbox"
    const val PENDING = "pending.json"

    /** `onSaveInstanceState` 里保存"已投递过的分享指纹"用的键。 */
    const val STATE_HANDLED_SHARE = "weeCook.handledShare"

    /**
     * 源字节上限：**必须大于**压缩后上限 1 MiB。
     * 这是本链路上唯一没有单测的常量 ⇒ 真机验收项。前端不复制这个数值（复制就是两份真相）。
     */
    const val SHARE_SOURCE_MAX_BYTES = 8L * 1024 * 1024
    const val COPY_BUFFER_BYTES = 64 * 1024

    const val CODE_NO_STREAM = "no_stream"
    const val CODE_READ_FAILED = "read_failed"
    const val CODE_SOURCE_TOO_LARGE = "source_too_large"
  }
}
