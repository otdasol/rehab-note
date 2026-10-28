package com.otnote.app

import android.graphics.Bitmap

/** 개인판: 차트 사진 읽기는 병원판 기능이라 없다 (AI가 없으니 칸별로 나눌 수도 없다). */
object Ocr {
    fun run(bitmap: Bitmap, done: (text: String?, error: String?) -> Unit) = done(null, "unavailable")
}
