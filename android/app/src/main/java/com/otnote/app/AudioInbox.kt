package com.otnote.app

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * 웹 화면으로 넘기기 전 잠깐 머무는 음성 파일 보관함.
 * 휴대폰에서 말로 남긴 메모가 여기로 들어오고, 웹 화면이 받아가면 바로 지운다.
 * 파일 이름: "<세션 id>__<시각>.m4a". 녹음 중인 파일은 ".part"로 끝난다.
 */
object AudioInbox {
    /** 새 파일이 들어오면 화면에 알린다 (화면이 떠 있을 때만 설정됨) */
    @Volatile var onArrived: (() -> Unit)? = null
    /** 녹음이 너무 짧거나 저장되지 않았을 때 화면에 알린다 */
    @Volatile var onFailed: ((sessionId: String) -> Unit)? = null

    fun dir(ctx: Context): File = File(ctx.filesDir, "pending_audio").apply { mkdirs() }

    fun partFile(ctx: Context, sessionId: String): File =
        File(dir(ctx), "${safe(sessionId)}.part")

    /** 녹음·전송이 끝난 .part 파일을 웹 화면이 받아갈 수 있게 내놓는다 */
    fun publish(ctx: Context, part: File) {
        val id = part.name.removeSuffix(".part")
        part.renameTo(File(dir(ctx), "${id}__${System.currentTimeMillis()}.m4a"))
        onArrived?.invoke()
    }

    fun pending(ctx: Context): List<File> =
        dir(ctx).listFiles { f -> f.name.endsWith(".m4a") && f.length() > 0 }?.sortedBy { it.name } ?: emptyList()

    fun find(ctx: Context, name: String): File? =
        File(dir(ctx), File(name).name).takeIf { it.exists() && it.name.endsWith(".m4a") }

    fun delete(ctx: Context, name: String) {
        find(ctx, name)?.delete()
    }

    private fun safe(id: String) = id.replace(Regex("[^A-Za-z0-9:_-]"), "_")
}

/** Whisper가 받는 m4a(AAC)로, 30분에 5MB 안팎이 되도록 낮은 음질로 녹음한다 */
fun startVoiceRecorder(ctx: Context, out: File): MediaRecorder {
    val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
    recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
    recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
    recorder.setAudioChannels(1)
    recorder.setAudioSamplingRate(16000)
    recorder.setAudioEncodingBitRate(24000)
    recorder.setOutputFile(out.absolutePath)
    recorder.prepare()
    recorder.start()
    return recorder
}
