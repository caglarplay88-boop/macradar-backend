
package com.macradar.macradar

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.security.MessageDigest

class MainActivity : FlutterActivity() {
    private val saveRequest = 7606
    private var pendingResult: MethodChannel.Result? = null
    private var pendingBytes: ByteArray? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,
            "com.macradar.macradar/match_files").setMethodCallHandler { call, result ->
            when (call.method) {
                "savePackage" -> {
                    if (pendingResult != null) {
                        result.error("BUSY", "Bir dosya işlemi zaten sürüyor.", null)
                    } else {
                        val bytes = call.argument<ByteArray>("bytes")
                        val expected = call.argument<String>("sha256")
                        val filename = call.argument<String>("filename")
                        if (bytes == null || bytes.size > 128 * 1024 * 1024 ||
                            filename == null || expected == null) {
                            result.error("INVALID_FILE", "Dosya bilgileri geçersiz.", null)
                        } else {
                            val hash = MessageDigest.getInstance("SHA-256")
                                .digest(bytes).joinToString("") {
                                    "%02x".format(it.toInt() and 0xff)
                                }
                            if (hash != expected) {
                                result.error("HASH_MISMATCH", "Dosya bütünlük kontrolü başarısız.", null)
                            } else {
                                pendingResult = result
                                pendingBytes = bytes
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                    saveToDownloads(bytes, filename, result)
                                    return@setMethodCallHandler
                                }
                                try {
                                    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                        addCategory(Intent.CATEGORY_OPENABLE)
                                        type = "application/zip"
                                        putExtra(Intent.EXTRA_TITLE, filename)
                                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                                            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                                    }
                                    startActivityForResult(intent, saveRequest)
                                } catch (error: Exception) {
                                    pendingResult = null
                                    pendingBytes = null
                                    result.error("SAVE_FAILED", "Kayıt ekranı açılamadı.", null)
                                }
                            }
                        }
                    }
                }
                "sharePackage" -> {
                    try {
                        val uri = Uri.parse(call.argument<String>("uri")
                            ?: throw IllegalArgumentException("URI missing"))
                        if (uri.scheme != "content")
                            throw IllegalArgumentException("Invalid URI")
                        val intent = Intent(Intent.ACTION_SEND).apply {
                            type = "application/zip"
                            putExtra(Intent.EXTRA_STREAM, uri)
                            clipData = ClipData.newUri(contentResolver, "Maç kartı", uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        startActivity(Intent.createChooser(intent, "Maç kartını paylaş"))
                        result.success(null)
                    } catch (error: Exception) {
                        result.error("SHARE_FAILED", "Paylaşım menüsü açılamadı.", null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun saveToDownloads(bytes: ByteArray, filename: String, result: MethodChannel.Result) {
        Thread {
            var uri: Uri? = null
            try {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
                    put(MediaStore.MediaColumns.MIME_TYPE, "application/zip")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val created = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("Download entry unavailable")
                uri = created
                contentResolver.openOutputStream(created, "wt")?.use {
                    it.write(bytes)
                    it.flush()
                } ?: throw IllegalStateException("Download stream unavailable")
                contentResolver.update(created, ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }, null, null)
                runOnUiThread {
                    pendingResult = null
                    pendingBytes = null
                    result.success(mapOf("uri" to created.toString(), "directory" to "Download", "filename" to filename))
                }
            } catch (_: Exception) {
                uri?.let { try { contentResolver.delete(it, null, null) } catch (_: Exception) { } }
                runOnUiThread {
                    pendingResult = null
                    pendingBytes = null
                    result.error("WRITE_FAILED", "Download klasörüne dosya kaydedilemedi.", null)
                }
            }
        }.start()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != saveRequest) return
        val result = pendingResult ?: return
        val bytes = pendingBytes
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null || bytes == null) {
            pendingResult = null
            pendingBytes = null
            result.success(null)
            return
        }
        try {
            val grants = ((data?.flags ?: 0) and
                (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            contentResolver.takePersistableUriPermission(uri, grants)
        } catch (_: Exception) { }
        Thread {
            try {
                contentResolver.openOutputStream(uri, "wt")?.use { stream ->
                    stream.write(bytes)
                    stream.flush()
                } ?: throw IllegalStateException("Output stream unavailable")
                runOnUiThread {
                    pendingResult = null
                    pendingBytes = null
                    result.success(mapOf("uri" to uri.toString()))
                }
            } catch (error: Exception) {
                runOnUiThread {
                    pendingResult = null
                    pendingBytes = null
                    result.error("WRITE_FAILED", "Dosya kaydedilemedi.", null)
                }
            }
        }.start()
    }
}
