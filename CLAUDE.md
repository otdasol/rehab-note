# Rehab노트 / AI Rehab노트

작업치료사가 만드는 재활 기록 앱. 답은 항상 한국어로, 바꾼 것은 두 번 확인한다.

## 앱 두 개 (절대 섞지 않는다)

| | 개인판 Rehab노트 | 병원판 AI Rehab노트 |
|---|---|---|
| applicationId | `com.rehabnote.app` | `com.rehabnote.ai` |
| AI·서버·인터넷·마이크 | **전혀 없음** | 있음 (기관 계약·환자 동의 전제) |
| 용도 | 앱 알리기용 | 실제 판매 |

- 사용자 원칙: "개인판에서는 개인정보보호위반이나 동의없이는 법에 위반될만한 사항이 절대 있어서는 안돼." 개인판에 네트워크·AI·마이크를 다시 넣지 말 것. 새 AI 기능은 병원판에만.
- 두 앱의 핵심은 **입원·중간·퇴원 보고서 작성 보조**. 병원판 차별점은 **음성**(말로 한꺼번에 → AI가 칸별 정리, 전문가 초안).

## 구조

- `ot-note.html`: 앱 화면 전체(한 파일). 안드로이드 WebView에 넣고 Kotlin 브리지 `OTNative`로 연결. 데이터는 기기 IndexedDB `rehabnote`/`kv`/`otnote.v1`.
- 판 구분: `const EDITION` 줄. 빌드가 이 줄을 바꾸고, 개인판은 `RELAY_URL`·`RELAY_KEY`·`SB_URL`을 비우고 `cdn.jsdelivr` 줄을 지운다 (`android/app/build.gradle.kts`의 `webUi`). JS에서는 `PERSONAL`일 때 `inst()`·`instOrg()`는 null, `aiOn()`은 false.
- `android/app/src/personal/AndroidManifest.xml`: INTERNET·RECORD_AUDIO·알림·녹음 서비스 권한 제거. 남는 건 생체인증뿐.
- 개인정보처리방침: 개인판 `privacy-personal.html`, 병원판 `privacy.html`.
- 서버: Supabase 프로젝트 `orlabcbhnarulribebvy`. AI 중계 edge function `ai` = `server/functions/ai/index.ts` (현재 v17). DB 기록은 `server/migrations/README.md`.
- `src/<flavor>/assets`는 빌드 때 만들어지므로 git에 없다.

## 빌드·설치 (안드로이드 SDK가 있는 집 PC에서)

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
& "C:\Users\user\.gradle\wrapper\dists\gradle-9.6.0-bin\42k10rwplmzkhuboz9kdazi7s\gradle-9.6.0\bin\gradle.bat" -p android assemblePersonalDebug assembleHospitalDebug
adb install -r --user 0 android\app\build\outputs\apk\personal\debug\app-personal-debug.apk
adb install -r --user 0 android\app\build\outputs\apk\hospital\debug\app-hospital-debug.apk
```

- 설치는 항상 `--user 0` (듀얼 앱 프로필 user 95에 깔리면 권한·데이터가 따로라 혼란).
- 버전은 `build.gradle.kts`의 versionCode/versionName을 올린다 (현재 22 / 0.22). UTF-8(BOM 없음)로 저장.
- 학교 PC 등 SDK 없는 곳: 브라우저 미리보기만. `serve.ps1` 실행 → `http://localhost:8791/ot-note.html` (병원판은 `?edition=hospital`).

## 웹 테스트판 (GitHub Pages)

- 아이폰 등 APK를 못 받는 테스터용. `main`에 푸시하면 `.github/workflows/pages.yml`이 `https://otdasol.github.io/rehab-note/`에 올린다.
- 올라가는 것: `web/index.html`(안내 첫 화면) + `ot-note.html` + 방침 2개 + `design/` 그림 4개 + `icon.png`에서 만든 `icon-180.png`. `android/`·`server/`는 올리지 않는다.
- 판 구분은 주소로: 개인판 `ot-note.html`, 병원판 `ot-note.html?edition=hospital`. 웹판은 빌드 필터를 거치지 않으므로 HTML 안에 서버 주소가 남아 있지만 `PERSONAL`이면 JS가 연결하지 않는다.
- iOS 앱(TestFlight·App Store)은 사업화 단계에서 한다. 지금은 웹판으로만 아이폰 테스트.

## 릴리즈 서명 (친구 테스트·Play 배포용)

- 키는 두 앱 공용, 저장소 루트 `rehabnote-release.jks` (git 제외). 비밀번호는 `android/keystore.properties` (git 제외, 예시 `android/keystore.properties.example`).
- **키를 잃으면 같은 앱으로 다시는 업데이트할 수 없다.** jks와 비밀번호를 클라우드 등 두 군데 이상에 백업한다. Claude는 비밀번호를 대신 정하거나 입력하지 않는다.
- 키 만들기 (처음 한 번, 저장소 루트에서):

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v -keystore rehabnote-release.jks -alias rehabnote -keyalg RSA -keysize 2048 -validity 10000
```

- 릴리즈 APK 빌드 (키·properties가 있을 때만 서명됨):

```powershell
& "...\gradle.bat" -p android assemblePersonalRelease assembleHospitalRelease
# 결과: android\app\build\outputs\apk\personal\release\app-personal-release.apk
#       android\app\build\outputs\apk\hospital\release\app-hospital-release.apk
```

- 테스트용으로 뿌리는 APK도 반드시 릴리즈 키로 서명한다 (debug 키로 깔린 앱 위에는 Play 버전이 설치되지 않는다).
- 폰에 debug 판이 깔려 있으면 먼저 지우고 설치: `adb uninstall com.rehabnote.app` / `adb uninstall com.rehabnote.ai`.
- Play에 올릴 때는 AAB: `bundlePersonalRelease bundleHospitalRelease` → `android\app\build\outputs\bundle\...`.

## AI 비용 원칙 ("수지타산")

- Opus 쓰지 않는다. `cheap`=Haiku 5.5(말한 내용 칸별 나누기·안내문), `write`=Sonnet 5.5 effort low(SOAP·기록·검토), `think`=Sonnet 5.5 effort medium(보고서 전문가 초안 `report_mode=draft`·중재 추천·슈퍼비전).
- AI의 가치: 최소 정보로 전문가 수준 보고서, 질 높은 중재 추천. 입력에 없는 사실은 지어내지 않고 "[확인 필요: …]", 추론은 "(제안)".
- 음성 받아쓰기: `gpt-4o-mini-transcribe` + 임상 약어 힌트, 실패 시 `whisper-1`.
- edge function 배포는 **파일 전체**를 붙여 넣는다 (자리표시 내용으로 배포 금지).
- AI 키는 Supabase 서버 비밀값에만 있다. HTML의 `RELAY_KEY`는 공개용 anon 키.

## 지켜야 할 것

- 환자 세션 녹음 금지. 음성은 치료 끝난 뒤 치료사가 남기는 메모.
- 환자 이름·등록번호 받지 않는다(라벨만). 평가도구는 이름과 점수만(저작권).
- 카카오톡 등으로 환자 내용 보내기 없음. 보호자·외래 일정 안내 기능은 뺐다.
- "EMR에 붙여 넣으세요" 같은 문구 쓰지 않는다(앱 책임). 복사 알림은 "복사했어요".
- 실습생 모드·백업 메뉴·큰 진행률 카드는 뺐다. 다시 넣지 않는다.
- API 키·비밀번호를 대신 입력하지 않는다. 로그인은 사용자가 직접.
- 사용자 개인 파일은 건드리지 않는다(`design/icon.png`, `design/startpage.png`만 예외).
- 출처를 지어내지 않는다. 법적 판단은 법률 검토를 권한다.
- 운영자 이름·연락처는 비공개 테스트 이후 정한다(지금은 자리표시). 방침 URL·수가 코드도 그때.

## 기관판 진행 상황

- 1단계(서버 표·권한·자동 파기), 2단계(로그인·초대·환자 토큰·동의 화면·해지 시 기기 데이터 삭제·관리자 메뉴) 완료.
- 다음: 3단계 월 집계·대시보드, 4단계 리포트 링크·퇴원 후 설문, 알림톡(사용자가 준비하면), 사용자 지정 SMTP.
- 아직 폰에서 확인 못 한 것: 병원판 보고서 받아쓰기(녹음 → 서버 받아쓰기)와 기기 음성 인식.

## 보고서 기능 (핵심)

- 보고서 탭(`renderReports`): 처음 들어오면 "평가 탭에 기록된 결과가 자동으로 채워집니다" 안내(`settings.rpGuideSeen`).
- `docCard`: ① 기준 평가·현재 평가 고르기(`evalChoice`) ② 자동 채움(`reportAuto`, 평가 날짜 포함) ③ 칸별 작성(`rpWriter`, 단어 고르기 `pbHtml`).
- 병원판만: "AI로 빈 칸 채우기 · 전문가 초안"(`draftReport`), 말로 받아쓰기 → 칸별 정리(`sortReport`).
