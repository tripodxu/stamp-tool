package cn.stamptool.pdf

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * 把导出的文件交给系统分享面板。
   *
   * 为什么需要它：本机 System WebView 没有 navigator.share（厂商裁剪），
   * 前端导出的 PDF/ZIP 在 WebView 里也没有下载器——不接原生通道，
   * 「导出」就是点了没反应。前端经 window.AndroidShare.shareFile(base64,…)
   * 调用；走 manifest 里现成的 FileProvider（authorities=$packageName.fileprovider，
   * file_paths.xml 已含 cache-path）。
   */
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(ShareBridge(), "AndroidShare")
  }

  inner class ShareBridge {
    @JavascriptInterface
    fun shareFile(base64: String, fileName: String, mime: String) {
      // JS bridge 运行在专线程：写文件就地做，startActivity 必须回主线程
      val bytes = Base64.decode(base64, Base64.NO_WRAP)
      val dir = File(cacheDir, "shared").apply { mkdirs() }
      val outFile = File(dir, fileName)
      outFile.writeBytes(bytes)
      val uri: Uri =
        FileProvider.getUriForFile(this@MainActivity, "${packageName}.fileprovider", outFile)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      Handler(Looper.getMainLooper()).post {
        startActivity(Intent.createChooser(send, fileName))
      }
    }
  }
}
