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
- **주 판매 대상은 물리치료사·병원 구독** (2026-10-26 결정: "메인 판매 대상자는 물리치료라고 해도 과언이 아니다. 개인보다는 병원 구독 위주"). PT 기능은 OT와 같은 수준으로 유지하고 새 기능은 PT를 먼저 생각한다. AI는 치료사가 치료하며 성장하게 돕는 방향(중재마다 **입각한 이론·원리 한 줄** `theory`).
- 평가도구는 **치료실에 실제로 있는 것만** (설문지·연구용·의사가 매기는 척도는 뺀다). 2026-10 정리: PT에서 ABC·TIS·PASS·SPADI·LEFS·K-WOMAC·FGA 제외, 5xSTS·TCT 추가; OT에서 CDR·GDS 제외.

## 구조

- `ot-note.html`: 앱 화면 전체(한 파일). 안드로이드 WebView에 넣고 Kotlin 브리지 `OTNative`로 연결. 데이터는 기기 IndexedDB `rehabnote`/`kv`/`otnote.v1`.
- 판 구분: `const EDITION` 줄. 빌드가 이 줄을 바꾸고, 개인판은 `RELAY_URL`·`RELAY_KEY`·`SB_URL`을 비우고 `cdn.jsdelivr` 줄을 지운다 (`android/app/build.gradle.kts`의 `webUi`). JS에서는 `PERSONAL`일 때 `inst()`·`instOrg()`는 null, `aiOn()`은 false.
- `android/app/src/personal/AndroidManifest.xml`: INTERNET·RECORD_AUDIO·알림·녹음 서비스 권한 제거. 남는 건 생체인증뿐.
- 개인정보처리방침: 개인판 `privacy-personal.html`, 병원판 `privacy.html`.
- 서버: Supabase 프로젝트 `orlabcbhnarulribebvy`. AI 중계 edge function `ai` = `server/functions/ai/index.ts` (현재 v18, 2026-10-26: ideas/supervise에 `theory`, PT 규칙에 FITT·WB). DB 기록은 `server/migrations/README.md`.
- `src/<flavor>/assets`는 빌드 때 만들어지므로 git에 없다.

## 빌드·설치 (안드로이드 SDK가 있는 집 PC에서)

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
& "C:\Users\user\.gradle\wrapper\dists\gradle-9.6.0-bin\42k10rwplmzkhuboz9kdazi7s\gradle-9.6.0\bin\gradle.bat" -p android assemblePersonalDebug assembleHospitalDebug
adb install -r --user 0 android\app\build\outputs\apk\personal\debug\app-personal-debug.apk
adb install -r --user 0 android\app\build\outputs\apk\hospital\debug\app-hospital-debug.apk
```

- 설치는 항상 `--user 0` (듀얼 앱 프로필 user 95에 깔리면 권한·데이터가 따로라 혼란).
- 버전은 `build.gradle.kts`의 versionCode/versionName을 올린다 (현재 24 / 0.24). UTF-8(BOM 없음)로 저장.
- 학교 PC 등 SDK 없는 곳: 브라우저 미리보기만. `serve.ps1` 실행 → `http://localhost:8791/ot-note.html` (병원판은 `?edition=hospital`).

## 친구 테스트 배포 (2026-10 결정: 병원판만 테스트)

- **아이폰 → 웹판**: `main`에 푸시하면 `.github/workflows/pages.yml`이 `https://otdasol.github.io/rehab-note/`에 **병원판만** 올린다 (EDITION을 hospital로 고정한 `index.html`, 선택 화면 없음). 올라가는 것: index.html + `privacy.html` + `design/` 그림 4개 + `icon.png`에서 만든 `icon-180.png`. 개인판·`android/`·`server/`는 올리지 않는다.
- 카톡 안 브라우저에는 "홈 화면에 추가"가 없다. 아이폰은 카톡 링크 → 오른쪽 아래 메뉴 → **Safari로 열기** → 공유 → 홈 화면에 추가.
- **안드로이드 → 설치형 APK**: `.github/workflows/release-apk.yml`이 GitHub Actions에서 서명해 Releases에 올린다. 서명 키는 저장소 Secrets(`KEYSTORE_BASE64`·`KEYSTORE_PASSWORD`·`KEY_ALIAS`·`KEY_PASSWORD`)에 있다 — 2026-10-26 Claude 세션에서 만든 키, 사용자가 jks·비밀번호를 따로 보관.

```powershell
# 1) build.gradle.kts의 versionCode/versionName 올리기  2) 같은 번호로 태그
git tag v0.23; git push origin v0.23
# 받는 링크: https://github.com/otdasol/rehab-note/releases/latest  → 폰 브라우저로 열어 apk 내려받기 → "출처를 알 수 없는 앱" 허용 → 설치
# 태그 없이 시험 빌드만: Actions › release-apk › Run workflow (Artifacts에 14일 보관). 개인판도 올리려면 personal 체크.
```

- 태그 번호와 versionName이 다르면 워크플로가 멈춘다(의도). 카톡 apk 첨부는 막힐 수 있으니 Releases 링크로 보낸다.

- 테스터는 앱 안에서 가입(이메일) → 메일 확인 → 로그인 → **초대 코드 10자리** 입력해야 기관에 들어간다. 초대 코드는 관리자(교수)가 설정 › 기관판 › 관리자에서 만든다. 코드 하나 = 한 사람, 7일.
- iOS 앱(TestFlight·App Store)은 사업화 단계에서 한다.

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

## 국내 처리 전환 (2026-10-26 결정: 판매 전 AI 처리를 국내로)

- Supabase(DB·edge function)는 이미 서울 리전. 국외로 가는 건 AI 호출뿐.
- edge function에 `AI_PROVIDER=bedrock` 경로를 넣어 둠(`askJsonBedrock`): AWS Bedrock 서울(ap-northeast-2)에서 Claude를 돌리고, 구조화 출력 대신 도구 호출 강제로 같은 스키마를 받는다. 비밀값 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`(+선택 `BEDROCK_MODEL_*`)가 들어오고 `AI_PROVIDER=bedrock`을 켜면 전환. 서울엔 Sonnet 5·Opus 5만 있어 cheap 몫도 Sonnet 5. **아직 실제 호출 테스트 전** — 키 들어오면 먼저 workflow 없이 한 번 호출해 모델 ID·도구 호출이 되는지 확인할 것.
- 음성 받아쓰기(OpenAI, 미국)는 아직 그대로. 후보: AWS Transcribe 서울(S3 경유, 약 1일 작업) 또는 네이버 클로바 스피치. 사용자 결정 대기.
- 사용자 판단: 대학병원처럼 망분리·깐깐한 곳은 초기 고객에서 제외. 재활병원·요양병원·의원 우선.

## PC 받기함 (0.24, 카카오톡 PC판 방식)

- 문제: 폰에 쓴 기록을 병원 PC 전자차트에 넣으려면 다시 쳐야 했다. 해결: PC 브라우저에서 `web/pc.html`(배포 주소 `otdasol.github.io/rehab-note/pc`)을 열면 12자 코드가 뜨고, 폰 설정 › 기관판 › PC 받기함에 넣으면 이후 **폰에서 복사할 때마다** 같은 글이 PC 화면에 뜬다(`copy()`가 `pcSend()`를 같이 부름, 초대 코드 복사는 제외).
- 보안: 코드에서 양쪽이 PBKDF2(20만 회)로 AES-GCM 키와 pair_id(SHA-256 앞 16바이트)를 각자 유도. 서버 `pc_relay` 표에는 암호문만, PC가 받으면 삭제·늦어도 10분 뒤 cron 삭제. anon은 읽기·삭제만, 쓰기는 로그인 사용자만(마이그레이션 `pc_relay`, `pc_relay_insert_policy`). 방침 2절에 한 줄 추가함.
- PC 페이지는 받은 글을 메모리에만 둔다("이 PC 기억하기"는 코드만 localStorage). 망분리 병원에서는 안 된다(알고 있는 한계).
- 카메라·QR은 아직 없다(안드로이드 WebView 카메라 권한 작업이 필요해 코드 입력만). 병원판 전용.

## 기관판 진행 상황

- 1단계(서버 표·권한·자동 파기), 2단계(로그인·초대·환자 토큰·동의 화면·해지 시 기기 데이터 삭제·관리자 메뉴) 완료.
- 다음: 3단계 월 집계·대시보드, 4단계 리포트 링크·퇴원 후 설문, 알림톡(사용자가 준비하면), 사용자 지정 SMTP.
- 아직 폰에서 확인 못 한 것: 병원판 보고서 받아쓰기(녹음 → 서버 받아쓰기)와 기기 음성 인식.

## 물리치료 기록 구조 (0.23)

- 평가: `MMT`·`ROM`은 `table: true` → 평가 탭 "+ MMT 부위" → `JOINTS`(관절→동작) 고르면 `"MMT 무릎 신전 (Rt)"`처럼 줄이 생긴다(`jointPick`). 등급은 글자 입력(4+), ROM은 °. 양쪽 넣으면 손상측 줄에 건측 대비(ROM만).
- 해석: `interpret()`가 10MWT(초로 넣으면 m/s 변환·Perry 보행 수준), TUG 13.5초, BBS 45/40/20, 5xSTS 15초, FAC, MAS를 한 줄로 풀어 `calc`에 넣는다. 출처는 문구에 둔 것만 쓴다(확실치 않은 MCID는 넣지 않는다).
- 물리치료 상세(`PTD`/`ptOf`): 물리요법 시간·설정(`modMin`·`modSet`), 체중지지 `wb`(NWB~FWB), 보행 보조 수준 `gaitAssist`, 운동별 FITT `exd[name]={load,sets,min}`, 가정운동 `hep`·`hepFreq`, 통증 `painSite`·`painType`·`painWhen`. `vitalFlags()`가 BP≥180/100(보류)·≥220/110(중단)·수축기 10↓·HR≥130·SpO2<90·Borg≥15·NRS +2를 경고하고 기록 끝에 ⚠로 붙인다(참고 기준, 기관 지침 우선).
- 보고서: `ptChange()`가 기준→현재 회기의 보행(WB·보조도구·거리·보조 수준)·NRS·HEP 변화를 [기능 변화]에 넣는다.

## 보고서 기능 (핵심)

- 보고서 탭(`renderReports`): 처음 들어오면 "평가 탭에 기록된 결과가 자동으로 채워집니다" 안내(`settings.rpGuideSeen`).
- `docCard`: ① 기준 평가·현재 평가 고르기(`evalChoice`) ② 자동 채움(`reportAuto`, 평가 날짜 포함) ③ 칸별 작성(`rpWriter`, 단어 고르기 `pbHtml`).
- 병원판만: "AI로 빈 칸 채우기 · 전문가 초안"(`draftReport`), 말로 받아쓰기 → 칸별 정리(`sortReport`).
