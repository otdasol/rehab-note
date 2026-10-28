package com.otnote.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import android.graphics.Color
import org.json.JSONObject
import java.io.FileInputStream

/**
 * 화면은 ot-note.html(웹과 같은 코드)을 WebView로 띄우고,
 * 웹이 못 하는 일(백그라운드 녹음, 클립보드, 공유)만 OTNative로 열어준다.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val handedOver = mutableSetOf<String>() // 웹 화면에 이미 넘긴 파일 (받아가며 지운다)
    private var pendingRecording: Pair<String, String>? = null // 권한 허용을 기다리는 녹음 (세션 id, 이름)
    private var pendingSave: String? = null // 저장 위치를 고르는 동안 들고 있는 백업 내용

    // 백업 파일: 사용자가 고른 곳(내 파일, Google Drive 등)에 저장하고, 고른 파일을 읽어 화면에 넘긴다
    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val text = pendingSave; pendingSave = null
        val ok = uri != null && text != null &&
            runCatching { contentResolver.openOutputStream(uri)!!.use { it.write(text.toByteArray()) } }.isSuccess
        js("window.otOnFileSaved && otOnFileSaved($ok)")
    }
    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val text = uri?.let { u -> runCatching { contentResolver.openInputStream(u)!!.use { it.readBytes().toString(Charsets.UTF_8) } }.getOrNull() }
            ?: return@registerForActivityResult
        js("window.otOnFileOpened && otOnFileOpened(${JSONObject.quote(text)})")
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/audio/") { path ->
                AudioInbox.find(this, path)?.let { WebResourceResponse("audio/mp4", null, FileInputStream(it)) }
            }
            .build()

        // 병원판: 화면 캡처·최근 앱 미리보기에 환자 기록이 남지 않게 막는다 (개인판은 사용자 본인 메모라 두지 않는다)
        if (BuildConfig.FLAVOR == "hospital") window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        web = WebView(this)
        setContentView(web)
        // 휴대폰이 다크 모드여도 앱은 늘 흰 배경: 상태표시줄 아이콘을 어둡게, 웹 화면 자동 어둡게 하기를 끈다
        web.setBackgroundColor(Color.parseColor("#F7F9F9"))
        WindowCompat.getInsetsController(window, web).isAppearanceLightStatusBars = true
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                handedOver.clear()
                handOverAudio()
            }
        }
        web.addJavascriptInterface(Bridge(), "OTNative")
        // https 주소로 띄워야 localStorage·모듈이 정상 동작한다
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        // 권한은 앱을 켤 때 묻지 않고, 처음 말로 입력할 때 팝업으로 묻는다

        // 뒤로가기는 화면이 한 단계씩 처리한다(열린 창 닫기 → 세션 닫기 → 오늘 탭). 화면이 "exit"라고 할 때만 앱을 닫는다.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.otBack ? otBack() : 'exit'") { result ->
                    if (result?.trim('"') == "exit") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        AudioInbox.onArrived = { runOnUiThread { handOverAudio() } }
        AudioInbox.onFailed = { id -> runOnUiThread { failed(id, "short") } }
        handOverAudio()
        js("window.otOnResume && otOnResume()") // 오래 나갔다 오면 화면이 앱 잠금을 띄운다
    }

    override fun onPause() {
        if (recognizer != null) { listening = false; recognizer?.cancel(); finishListen(null) } // 화면을 떠나면 듣기를 멈춘다
        js("window.otOnPause && otOnPause()")
        AudioInbox.onArrived = null
        AudioInbox.onFailed = null
        super.onPause()
    }

    private fun startRecordingService(sessionId: String, name: String) {
        ContextCompat.startForegroundService(this, RecordingService.start(this, sessionId, name))
    }

    // ---------- 폰 안 음성 인식 ----------
    // 개인판은 소리를 밖으로 보내지 않는다. 기기 내 인식기(createOnDeviceSpeechRecognizer)만 쓰고 파일도 남기지 않는다.
    // 한 번 말이 끊기면 인식기가 멈추므로, 사용자가 끝을 누를 때까지 다시 듣는다.
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var quiet = 0

    private fun canListen() = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)

    private fun speechIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    }

    private fun startListen() {
        if (!canListen()) { js("window.otOnSpeechEnd && otOnSpeechEnd('unavailable')"); return }
        recognizer?.destroy() // 듣는 중에 다른 칸을 누르면 이전 것은 조용히 끝낸다
        recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this).apply { setRecognitionListener(speechListener) }
        listening = true; quiet = 0
        recognizer?.startListening(speechIntent())
    }

    private fun finishListen(reason: String?) {
        listening = false
        recognizer?.destroy(); recognizer = null
        js("window.otOnSpeechEnd && otOnSpeechEnd(${if (reason == null) "null" else JSONObject.quote(reason)})")
    }

    private fun speak(b: Bundle?, final: Boolean) {
        val text = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
        if (text.isNotEmpty()) js("window.otOnSpeech && otOnSpeech(${JSONObject.quote(text)}, $final)")
    }

    private val speechListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
        override fun onPartialResults(partialResults: Bundle?) = speak(partialResults, false)
        override fun onResults(results: Bundle?) {
            speak(results, true); quiet = 0
            if (listening) recognizer?.startListening(speechIntent()) else finishListen(null)
        }
        override fun onError(error: Int) {
            val silent = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            if (!listening) { finishListen(null); return }
            if (silent && ++quiet < 4) { recognizer?.startListening(speechIntent()); return }
            when (error) {
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> {
                    if (Build.VERSION.SDK_INT >= 33) runCatching { recognizer?.triggerModelDownload(speechIntent()) }
                    finishListen("lang")
                }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> finishListen("permission")
                else -> finishListen(if (silent) null else "error")
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == LISTEN_PERMISSION) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startListen() else finishListen("permission")
            return
        }
        val (id, name) = pendingRecording ?: return
        pendingRecording = null
        val mic = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
        if (mic >= 0 && grantResults.getOrNull(mic) == PackageManager.PERMISSION_GRANTED) startRecordingService(id, name)
        else failed(id, "permission")
    }

    private fun failed(id: String, reason: String) =
        js("window.otOnRecordingFailed && otOnRecordingFailed(${JSONObject.quote(id)}, ${JSONObject.quote(reason)})")

    /** 보관함에 들어온 음성을 웹 화면에 넘긴다. 웹은 받아가자마자 OTNative.deleteAudio로 지운다. */
    private fun handOverAudio() {
        for (f in AudioInbox.pending(this)) {
            if (!handedOver.add(f.name)) continue
            val id = f.name.substringBefore("__")
            val url = "https://appassets.androidplatform.net/audio/${f.name}"
            js("window.otOnAudioFile && otOnAudioFile(${JSONObject.quote(id)}, ${JSONObject.quote(url)}, ${JSONObject.quote(f.name)})")
        }
    }

    private fun js(code: String) = web.evaluateJavascript(code, null)

    inner class Bridge {
        /** 마이크 권한이 없으면 팝업으로 묻고, 허용되면 그때 녹음을 시작한다 */
        @JavascriptInterface
        fun startRecording(sessionId: String, name: String) = runOnUiThread {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                startRecordingService(sessionId, name)
                return@runOnUiThread
            }
            pendingRecording = sessionId to name
            val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS // 초안 완성 알림용
            requestPermissions(perms.toTypedArray(), 1)
        }

        /** 폰 안 음성 인식을 쓸 수 있는 폰인지 (Android 12 이상 + 기기 내 인식기) */
        @JavascriptInterface
        fun canListen(): Boolean = this@MainActivity.canListen()

        /** 폰 안에서만 말을 글로 바꾼다. 결과는 otOnSpeech(글, 완성 여부), 끝나면 otOnSpeechEnd(이유). */
        @JavascriptInterface
        fun listen() = runOnUiThread {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startListen()
            else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), LISTEN_PERMISSION)
        }

        @JavascriptInterface
        fun stopListen() = runOnUiThread {
            if (recognizer == null) return@runOnUiThread
            listening = false
            recognizer?.stopListening() // 마지막 문장을 마저 넘긴 뒤 끝난다
        }

        @JavascriptInterface
        fun stopRecording() {
            startService(RecordingService.stop(this@MainActivity))
        }

        /** 화면이 다 뜬 뒤 다시 요청한다. 글로 못 바꿔서 남겨 둔 녹음도 다시 넘긴다. */
        @JavascriptInterface
        fun resendAudio() = runOnUiThread {
            handedOver.clear()
            handOverAudio()
        }

        @JavascriptInterface
        fun deleteAudio(name: String) {
            AudioInbox.delete(this@MainActivity, name)
        }

        @JavascriptInterface
        fun copy(text: String) {
            runOnUiThread {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("재활 일지", text))
            }
        }

        /** 오늘 일지 글을 공유 창으로 넘긴다. 카카오톡 "나와의 채팅"이나 메모 앱을 고르면 된다. */
        @JavascriptInterface
        fun shareText(title: String, text: String) {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            runOnUiThread { startActivity(Intent.createChooser(send, "오늘 일지 보내기")) }
        }

        /** 암호로 잠근 백업 파일을 사용자가 고른 곳에 저장한다. 결과는 otOnFileSaved로 알린다. */
        @JavascriptInterface
        fun saveFile(name: String, text: String) = runOnUiThread {
            pendingSave = text
            createDoc.launch(name)
        }

        /** 백업 파일을 골라 읽는다. 내용은 otOnFileOpened로 넘긴다. */
        @JavascriptInterface
        fun openFile() = runOnUiThread { openDoc.launch(arrayOf("application/json", "application/octet-stream", "text/plain")) }

        /** 지문·얼굴·화면 잠금으로 앱 잠금을 풀 수 있는 폰인지 */
        @JavascriptInterface
        fun canBiometric(): Boolean =
            BiometricManager.from(this@MainActivity).canAuthenticate(UNLOCK_WITH) == BiometricManager.BIOMETRIC_SUCCESS

        @JavascriptInterface
        fun biometric() = runOnUiThread {
            val prompt = BiometricPrompt(this@MainActivity, ContextCompat.getMainExecutor(this@MainActivity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        js("window.otOnBiometric && otOnBiometric(true)")
                    }
                })
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Rehab노트 잠금 해제")
                    .setSubtitle("지문이나 화면 잠금으로 열어요")
                    .setAllowedAuthenticators(UNLOCK_WITH)
                    .build(),
            )
        }

        /** 초안이 완성되면 알림을 띄운다. 알림에는 "09:30 B환자" 같은 표시만 담긴다. */
        @JavascriptInterface
        fun notify(title: String, text: String) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("notes", "일지 초안", NotificationManager.IMPORTANCE_DEFAULT))
            val open = PendingIntent.getActivity(
                this@MainActivity, 0, Intent(this@MainActivity, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
            )
            val n = NotificationCompat.Builder(this@MainActivity, "notes")
                .setSmallIcon(android.R.drawable.ic_menu_edit)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()
            nm.notify(text.hashCode(), n)
        }
    }

    companion object {
        private const val UNLOCK_WITH = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        private const val LISTEN_PERMISSION = 2
    }
}
