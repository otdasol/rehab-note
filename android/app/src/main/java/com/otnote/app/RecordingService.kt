package com.otnote.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File

/** 화면이 꺼지거나 다른 앱으로 넘어가도 치료 세션 녹음을 이어가는 포그라운드 서비스 */
class RecordingService : Service() {
    private var recorder: MediaRecorder? = null
    private var part: File? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> begin(intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY, intent.getStringExtra(EXTRA_NAME) ?: "")
            ACTION_STOP -> finish()
        }
        return START_NOT_STICKY
    }

    private fun begin(sessionId: String, name: String) {
        finish() // 다른 세션을 녹음 중이었다면 먼저 마무리한다
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification(name),
            if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
        )
        part = AudioInbox.partFile(this, sessionId).also { recorder = startVoiceRecorder(this, it) }
    }

    private fun finish() {
        val r = recorder ?: return
        val stopped = runCatching { r.stop() }.isSuccess
        r.release()
        recorder = null
        part?.let { file ->
            // 1초도 안 되는 녹음은 파일이 비어 있다. 버리고 화면에 알려야 "처리 중"에 멈추지 않는다.
            if (stopped && file.length() > MIN_BYTES) {
                AudioInbox.publish(this, file)
            } else {
                file.delete()
                AudioInbox.onFailed?.invoke(file.name.removeSuffix(".part"))
            }
        }
        part = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        finish()
        super.onDestroy()
    }

    private fun notification(name: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "세션 녹음", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("$name 녹음 중")
            .setContentText("세션이 끝나면 앱에서 녹음을 끝내 주세요")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val ACTION_START = "start"
        private const val ACTION_STOP = "stop"
        private const val EXTRA_ID = "id"
        private const val EXTRA_NAME = "name"
        private const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 1
        private const val MIN_BYTES = 2_000L

        fun start(ctx: Context, sessionId: String, name: String): Intent =
            Intent(ctx, RecordingService::class.java).setAction(ACTION_START)
                .putExtra(EXTRA_ID, sessionId).putExtra(EXTRA_NAME, name)

        fun stop(ctx: Context): Intent = Intent(ctx, RecordingService::class.java).setAction(ACTION_STOP)
    }
}
