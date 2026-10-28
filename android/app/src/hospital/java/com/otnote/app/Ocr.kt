package com.otnote.app

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions

/** 병원판: 차트 사진을 폰 안에서 글로 바꾼다 (ML Kit 한국어 인식, 앱에 모델이 들어 있어 인터넷 없이 동작). 사진은 어디에도 보내지 않는다. */
object Ocr {
    fun run(bitmap: Bitmap, done: (text: String?, error: String?) -> Unit) {
        val client = TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())
        client.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { done(it.text, null) }
            .addOnFailureListener { done(null, "error") }
            .addOnCompleteListener { client.close() }
    }
}
