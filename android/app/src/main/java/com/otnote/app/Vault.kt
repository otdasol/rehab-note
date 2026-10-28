package com.otnote.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 폰에 저장하는 기록(IndexedDB의 JSON 한 덩어리)을 안드로이드 키스토어 키(AES-256-GCM)로 잠근다.
 * 키는 하드웨어 보안 영역에 있어 루팅된 폰에서 저장소를 긁어 가도 글을 읽을 수 없다. 앱을 지우면 키도 사라진다.
 * 잠금 해제 인증은 요구하지 않는다(앱 잠금 PIN이 따로 있고, 인증을 걸면 화면 잠금을 바꿀 때 기록을 잃을 수 있다).
 */
object Vault {
    private const val ALIAS = "rehabnote.db.v1"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    /** 글 → "iv:암호문" (둘 다 base64). 실패하면 null. */
    fun seal(text: String): String? = runCatching {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(c.doFinal(text.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }.getOrNull()

    /** "iv:암호문" → 글. 키가 없거나 깨졌으면 null. */
    fun open(blob: String): String? = runCatching {
        val (iv, body) = blob.split(":", limit = 2)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        String(c.doFinal(Base64.decode(body, Base64.NO_WRAP)), Charsets.UTF_8)
    }.getOrNull()
}
