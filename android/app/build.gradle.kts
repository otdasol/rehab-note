import java.util.Properties

plugins {
    id("com.android.application")
}

// 릴리즈 서명 키 정보는 android/keystore.properties(git에 올리지 않음)에서 읽는다.
// 파일이 없으면 릴리즈 빌드는 서명 없이 만들어지므로(설치 불가) 먼저 키를 만들어야 한다. 방법은 CLAUDE.md "릴리즈 서명".
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.otnote.app"
    compileSdk = 35

    defaultConfig {
        minSdk = 28
        targetSdk = 35
        versionCode = 22
        versionName = "0.22"
    }

    // 앱 두 개: 개인판(Rehab노트)은 인터넷·마이크 권한이 없고 AI가 전혀 없다.
    // 병원판(AI Rehab노트)은 기관 계약·환자 동의를 거쳐 AI를 쓴다. 저장 공간도 서로 따로다.
    // applicationId는 Play 스토어에 올린 뒤 바꿀 수 없다. 개인판은 지금까지 쓰던 com.rehabnote.app을 그대로 쓴다.
    flavorDimensions += "edition"
    productFlavors {
        create("personal") {
            dimension = "edition"
            applicationId = "com.rehabnote.app"
            resValue("string", "app_name", "Rehab노트")
        }
        create("hospital") {
            dimension = "edition"
            applicationId = "com.rehabnote.ai"
            resValue("string", "app_name", "AI Rehab노트")
        }
    }

    buildFeatures { resValues = true } // 판마다 앱 이름을 다르게

    // 두 앱 모두 같은 키로 서명한다. 한 번 Play에 올린 뒤에는 이 키로만 업데이트할 수 있으니 절대 잃어버리지 말 것.
    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            // 화면이 WebView 안의 HTML이라 코드 축소로 얻는 게 거의 없다. 켜면 OTNative 브리지가 깎여 나갈 위험만 있다.
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (keystoreProps.isNotEmpty()) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// 화면은 웹과 같은 ot-note.html 하나를 판마다 고쳐서 앱 안에 넣는다.
// 개인판: 서버 주소와 키를 지워 코드가 남아 있어도 어디에도 연결할 수 없게 한다(인터넷 권한도 없다).
// 병원판: 판 표시만 "hospital"로 바꾼다.
fun webUi(edition: String) = tasks.registering(Copy::class) {
    val personal = edition == "personal"
    from(rootProject.file("../ot-note.html")) {
        rename { "index.html" }
        filter { line ->
            when {
                line.startsWith("const EDITION = ") -> if (personal) "const EDITION = \"personal\";" else "const EDITION = \"hospital\";"
                personal && line.startsWith("const RELAY_URL = ") -> "const RELAY_URL = \"\"; // 개인판: 연결할 서버 없음"
                personal && line.startsWith("const RELAY_KEY = ") -> "const RELAY_KEY = \"\";"
                personal && line.startsWith("const SB_URL = ") -> "const SB_URL = \"\";"
                personal && line.contains("cdn.jsdelivr.net") -> "" // 외부 글꼴도 받지 않는다 (폰 기본 글꼴)
                else -> line
            }
        }
    }
    from(rootProject.file(if (personal) "../privacy-personal.html" else "../privacy.html")) { rename { "privacy.html" } }
    from(rootProject.file("../design")) { include("splash.webp", "logo.png", "mascot.webp", "mascot-desk.webp"); into("design") }
    into(layout.projectDirectory.dir("src/$edition/assets"))
}
val webUiPersonal by webUi("personal")
val webUiHospital by webUi("hospital")
tasks.named("preBuild") { dependsOn(webUiPersonal, webUiHospital) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.biometric:biometric:1.1.0")
}
