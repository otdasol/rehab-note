// 재활노트 AI 중계 함수.
// 앱이 보낸 일지·메모로 회기 치료기록(/record)과 SOAP 초안(/soap)을 만들고(Claude), 말로 남긴 메모를 글로 바꾼다(/stt, Whisper).
// 키는 이 서버에만 있고, 요청·응답 내용은 저장하거나 로그로 남기지 않는다. 기기별 하루 사용 횟수만 센다.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@1.1.0";
import { AnthropicBedrock } from "npm:@anthropic-ai/bedrock-sdk@1.1.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------- AI 처리 위치 ----------
// AI_PROVIDER=bedrock 이면 같은 Claude 모델을 AWS Bedrock 서울 리전(ap-northeast-2)에서 돌린다 → 글이 국내를 벗어나지 않는다.
// 비밀값: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (선택) BEDROCK_MODEL_THINK/WRITE/CHEAP. 기본은 Anthropic 직접 호출(미국).
const AI_PROVIDER = Deno.env.get("AI_PROVIDER") === "bedrock" ? "bedrock" : "anthropic";
const BEDROCK_REGION = Deno.env.get("AWS_REGION") || "ap-northeast-2";
// 서울 리전에 있는 모델 ID (2026-10 기준 Sonnet 5·Opus 5만 있어 Haiku 몫도 Sonnet 5가 맡는다). 바뀌면 비밀값으로 덮어쓴다.
const BEDROCK_MODEL = {
  think: Deno.env.get("BEDROCK_MODEL_THINK") || "anthropic.claude-sonnet-5-v1:0",
  write: Deno.env.get("BEDROCK_MODEL_WRITE") || "anthropic.claude-sonnet-5-v1:0",
  cheap: Deno.env.get("BEDROCK_MODEL_CHEAP") || "anthropic.claude-sonnet-5-v1:0",
};

const LIMITS = { soap: 80, stt: 120, record: 150, ideas: 60, summary: 30, review: 60, report: 30, chart: 60 }; // 기기 하나가 하루에 쓸 수 있는 횟수
const MAX_TEXT = 30_000;
const MAX_AUDIO = 15 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-device-id, x-inst-token, x-org-id, x-patient-ref",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Kind = keyof typeof LIMITS;
async function take(device: string, kind: Kind) {
  const { data, error } = await db.rpc("ai_usage_take", { p_device: device, p_kind: kind, p_limit: LIMITS[kind] });
  if (error) throw new Error("usage");
  return data === true;
}

// ---------- 기관판 확인 ----------
// 기관판 앱은 로그인 토큰·기관·환자 토큰을 함께 보낸다. 활성 구성원인지, 기관 AI가 켜져 있는지,
// 환자별 동의가 필요한 기관이면 AI 처리 동의가 있는지 서버에서 다시 확인한다. 개인판 요청(토큰 없음)은 그대로 둔다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function instGate(req: Request, kind: Kind): Promise<Response | Plan> {
  const token = req.headers.get("x-inst-token");
  if (!token) return "basic";
  const org = req.headers.get("x-org-id") || "";
  const ref = req.headers.get("x-patient-ref") || null;
  if (!UUID.test(org) || (ref && !UUID.test(ref))) return json(400, { error: "inst" });
  const { data: u, error } = await db.auth.getUser(token);
  if (error || !u?.user) return json(401, { error: "session" });
  const { data, error: e2 } = await db.rpc("ai_check", { p_user: u.user.id, p_org: org, p_ref: ref, p_kind: kind });
  if (e2) throw new Error("ai_check");
  if (data !== "ok") return json(403, { error: data });
  const { data: o } = await db.from("organizations").select("ai_tier").eq("id", org).maybeSingle();
  return o?.ai_tier === "pro" ? "pro" : "basic";
}

// ---------- SOAP 초안 ----------
const ROLE_RULES: Record<string, string> = {
  OT: `- 직무: 작업치료(OT).
- 문체: 한국 병원 OT 일지처럼 짧은 개조식, "~함/~보임" 체. 영어 약어(ROM, ADL, A-ROM, min A, mod A 등)는 임상에서 쓰는 대로 씁니다.
- S: 대상자/보호자의 호소·말. O: 실시한 치료 활동(ADL 훈련, 상지 기능, 인지, 연하 등)과 관찰, 수행 수준, 평가 결과. A: 치료사 관점의 변화·문제 요약. P: 다음 계획.`,
  PT: `- 직무: 물리치료(PT).
- 문체: 한국 병원 PT 일지처럼 짧은 개조식, "~함/~보임" 체. 영어 약어(ROM, MMT, A-ROM, P-ROM, WB, PWB, FWB, min A, mod A, AFO, cane, walker, TENS, ICT, FES, HP, US 등)는 임상에서 쓰는 대로 씁니다.
- S: 대상자/보호자의 호소·말(통증 부위·양상·정도 포함). O: 치료 종목과 시간(운동치료, 보행·균형 훈련, 매트·이동 훈련, 전기치료, 온열·한랭, 초음파 등), 체중지지 지시(NWB/PWB/WBAT/FWB), 보행 거리·보조도구·보조 수준, 운동별 강도·세트×반복·시간(FITT), 근력(MMT)·ROM은 관절·동작·좌우별로, 균형 관찰, 운동 전후 활력징후·NRS, 평가 결과. A: 치료사 관점의 변화·문제 요약(점진적 과부하·체중지지 진행 여부 포함). P: 다음 계획과 가정운동(HEP) 처방.`,
  SLPA: `- 직무: 병원 언어치료(언어재활사, 성인). 대상은 뇌졸중·외상성 뇌손상·퇴행성 질환 등 성인(실어증, 마비말장애, 말실행증, 연하장애, 인지-의사소통장애).
- 문체: 한국 병원 언어치료 일지처럼 짧은 개조식, "~함/~보임" 체. 과제는 "- 과제명: 정반응 수/시도 수(단서 수준)" 형식으로 쓰고, 단서(음소·의미·글자·모델링), 반응 지연, 보속, 자가수정, 조음 명료도·발성·호흡·운율, 삼킴(식이 단계·사레·보상전략)을 구체적으로 적습니다. 영어 약어(AQ, MPT, DDK, FOIS, NPO 등)는 임상에서 쓰는 대로 씁니다.
- S: 대상자·보호자의 호소·말(의사소통·삼킴 어려움, 바람). O: 과제·시간, 정반응률, 단서 수준, 말·음성·삼킴 관찰, 평가 결과. A: 언어·말·삼킴 변화와 목표 대비 진행, 의사소통 효율. P: 다음 과제·난이도·단서 수준, 식이 단계 계획, 보호자 의사소통 전략 교육, 재평가.`,
  // 아동발달센터 직무. 둘째 줄까지가 회기 기록 문체로 쓰인다.
  SI: `- 직무: 아동발달센터 감각통합치료(작업치료사). 대상은 영유아·아동.
- 문체: 발달센터 회기 기록처럼 짧은 개조식 "~함/~보임" 체. 활동은 "- 활동명 N분: 반응·수행(촉구 수준)" 형식으로 쓰고, 감각 반응(추구·회피·민감·낮은 등록), 각성·자기조절, 자세·운동계획, 소근육·자조 수행을 구체적으로 적습니다. 아동은 "아동", 보호자는 "보호자"로 씁니다.
- S: 보호자 보고와 아동의 말. O: 활동·시간, 감각 반응, 촉구 수준, 정반응·시도 횟수, 평가 점수. A: 감각처리·참여의 변화와 보호자 목표(COPM) 대비 진행. P: 다음 회기 활동과 가정 연계 활동.`,
  SLP: `- 직무: 아동발달센터 언어치료(언어재활사). 대상은 영유아·아동.
- 문체: 짧은 개조식 "~함/~보임" 체. 활동은 "- 활동명 N분: 목표 언어 반응(정반응 수/시도 수, 촉구 수준)" 형식으로 쓰고, 목표 어휘·문장 길이·조음 정확도·화용(차례, 요구, 대답)을 구체적으로 적습니다. 아동은 "아동", 보호자는 "보호자"로 씁니다.
- S: 보호자 보고와 아동의 발화. O: 활동·시간, 정반응 비율, 자발 발화 예, 촉구 수준, 평가 점수. A: 언어 변화와 보호자 목표 대비 진행. P: 다음 회기 목표와 가정 연계 활동.`,
  PLAY: `- 직무: 아동발달센터 놀이치료(응용행동분석 ABA 포함). 대상은 영유아·아동.
- 문체: 짧은 개조식 "~함/~보임" 체. 활동은 "- 활동명 N분: 놀이 주제·정서·행동 반응" 형식으로 쓰고, ABA는 목표 행동의 빈도·지속시간, 강화·소거·촉구 절차를 구체적으로 적습니다. 놀이 내용의 해석은 단정하지 않습니다. 아동은 "아동", 보호자는 "보호자"로 씁니다.
- S: 보호자 보고와 아동의 말. O: 놀이 주제, 정서 표현, 관계 맺기, 목표 행동 자료. A: 정서·행동 변화와 보호자 목표 대비 진행. P: 다음 회기 계획과 부모 코칭 내용.`,
  ART: `- 직무: 아동발달센터 미술치료. 대상은 영유아·아동.
- 문체: 짧은 개조식 "~함/~보임" 체. 활동은 "- 활동명 N분: 사용 매체, 표현 내용(형태·색·주제), 작품에 대한 아동의 이야기, 정서 반응" 형식으로 씁니다. 그림 해석은 단정하지 않고 관찰한 사실로 적습니다. 아동은 "아동", 보호자는 "보호자"로 씁니다.
- S: 보호자 보고와 아동의 말. O: 매체·과정·표현 내용·태도. A: 정서 표현·자기표현의 변화. P: 다음 회기 매체와 주제.`,
  COG: `- 직무: 아동발달센터 인지치료. 대상은 영유아·아동.
- 문체: 짧은 개조식 "~함/~보임" 체. 활동은 "- 과제명 N분: 정반응 수/시행 수, 주의 지속 시간, 촉구 수준" 형식으로 씁니다. 아동은 "아동", 보호자는 "보호자"로 씁니다.
- S: 보호자 보고와 아동의 말. O: 과제·시간, 정반응 비율, 주의 지속, 촉구 수준, 평가 점수. A: 인지 수행의 변화와 보호자 목표 대비 진행. P: 다음 회기 과제와 난이도, 가정 연계 활동.`,
};
const ROLE_NAME: Record<string, string> = {
  OT: "작업치료", PT: "물리치료", SLPA: "언어치료(성인)", SI: "감각통합(작업치료)", SLP: "언어치료", PLAY: "놀이치료", ART: "미술치료", COG: "인지치료",
};
const KID = new Set(["SI", "SLP", "PLAY", "ART", "COG"]);

const systemPrompt = (role: string) => `당신은 한국 병원의 재활치료 업무일지 작성을 돕는 보조자입니다. 치료사가 세션이 끝난 뒤 남긴 메모와 탭으로 기록한 일지를 읽고 EMR에 옮겨 적을 SOAP 초안을 만듭니다.

입력은 치료사 본인의 기록입니다(환자와의 대화 녹음이 아닙니다):
- [치료사 구술 메모] 머리말이 붙은 글은 말로 남긴 메모를 받아쓴 것이라 받아쓰기 오류가 섞여 있습니다("민에이" → min A 등). 문맥으로 바로잡습니다.
- 머리말이 없는 글은 치료사가 직접 적은 메모입니다.
- 메모와 일지는 사실로 받아들이고 빠짐없이 정리합니다.
- 치료사가 이미 쓴 SOAP가 있으면 그 문장을 살리고, 빈 곳을 채우거나 다듬기만 합니다.

SOAP 작성 원칙 (SOAP는 주로 초기·재평가·퇴원 평가 날에 씁니다):
- S는 해석하지 않고 대상자의 말로 씁니다. 말한 내용이 메모에 있으면 따옴표로 인용합니다. 대상자의 목표·바람(예: 혼자 식사하고 싶다)이 있으면 꼭 넣습니다.
- O는 다른 치료사가 그대로 재현할 수 있는 사실과 숫자(횟수·시간·거리·각도·점수·보조 수준·cue 횟수)로 씁니다. 평가 점수는 도구 이름과 함께 모두 적습니다.
- "좋아짐" 같은 말은 기준과 비교해 씁니다(예: 지난 회기 mod A → 오늘 min A). 비교할 근거가 없으면 쓰지 않습니다.
- A는 S·O를 근거로 해석합니다. ① 평가 점수의 기능적 의미(예: K-MBI 45/100은 일상생활 중등도 의존) ② 작업수행에 영향을 주는 주요 문제(신체기능·인지·환경) ③ 강점과 예후 요인(동기, 보호자 지지 등) ④ 목표 대비 진행. 새로운 사실은 A에 넣지 않습니다.
- P는 이 대상자에게만 해당하는 계획으로 씁니다. 치료 빈도·시간, 다음 회기에 할 구체적 중재, 보호자·가정 교육, 재평가 시기, 그리고 기록에 근거가 있으면 측정 가능한 단기목표 1~2개(기간·조건·수행 기준 포함, 예: "2주 내 두꺼운 손잡이 숟가락으로 식사 시 SBA 수준 달성").

메모 읽기:
- 중재는 회기마다 비슷하게 이어집니다. "지난 회차 중재"가 주어지면 이번 중재의 기본값으로 쓰고, 메모에서 새로 하거나 빠지거나 바뀐 것이 분명할 때만 고칩니다. 지난 회차와 같다고 질문하지 않습니다.
- 메모에 나온 대상자의 컨디션(통증, 수면, 피로, 기분), 재활 동기, 그리고 신체·사회·정서적으로 의미 있는 사건(낙상, 퇴원 일정, 가족 면회·갈등, 복귀 계획, 우울감 표현 등)은 condition과 events에 짧게 남기고, 관련 있으면 S에 반영합니다.
- 치료와 무관한 내용은 기록하지 않습니다.

규칙:
- 기록, 지난 회차, 치료사가 준 정보에 있는 내용만 씁니다. 추측해서 채우지 않습니다.
- 회기 수는 앱이 계산해 주므로 묻지 않습니다.
- 정말 판단할 수 없는 것(새로 나온 평가도구·점수, 보조 수준이 바뀐 것 같은데 불분명한 경우 등)만 본문에 [확인 필요]로 두고 questions에 짧은 질문으로 남깁니다. 메모로 분명한 내용은 묻지 않습니다.
- 메모가 비어 있으면 지난 회차를 바탕으로 초안을 만들고, 오늘 달라진 점이 있는지 하나만 묻습니다.
- options에는 치료사가 탭 한 번으로 고를 수 있는 짧은 보기 2~5개를 넣습니다(예: "indep", "min A", "mod A", "max A"). 숫자를 직접 적어야 하는 질문이면 빈 배열로 둡니다.
- 개인정보 보호: 이름, 등록번호, 연락처, 주소, 가족 이름이 들리면 결과에 절대 쓰지 말고 "대상자", "보호자"로 바꿉니다.
- 저작권: 평가도구의 문항, 지시문, 채점 기준을 옮겨 적지 않습니다. 도구 이름과 총점(또는 측정값)만 씁니다.
${ROLE_RULES[role]}`;

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    soap: {
      type: "object",
      properties: { S: { type: "string" }, O: { type: "string" }, A: { type: "string" }, P: { type: "string" } },
      required: ["S", "O", "A", "P"], additionalProperties: false,
    },
    interventions: { type: "array", items: { type: "string" } },
    assessments: {
      type: "array",
      items: {
        type: "object",
        properties: { tool: { type: "string" }, result: { type: "string" } },
        required: ["tool", "result"], additionalProperties: false,
      },
    },
    session_info: {
      type: "object",
      properties: { session_number: { type: "string" }, duration: { type: "string" } },
      required: ["session_number", "duration"], additionalProperties: false,
    },
    condition: { type: "string" },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { domain: { type: "string", enum: ["신체", "사회", "정서"] }, text: { type: "string" } },
        required: ["domain", "text"], additionalProperties: false,
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
        required: ["id", "question", "options"], additionalProperties: false,
      },
    },
  },
  required: ["soap", "interventions", "assessments", "session_info", "condition", "events", "questions"],
  additionalProperties: false,
};

async function soap(req: Request) {
  const { role, text } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  return askJson(systemPrompt(role), NOTE_SCHEMA, text);
}

// ---------- 회기 치료기록 ----------
// 매 회기 EMR "치료 내용"란에 붙여 넣을 짧은 기록. 치료사가 가장 자주, 가장 귀찮게 쓰는 글이다.
const recordPrompt = (role: string) => `당신은 한국 병원의 재활치료사가 매 회기 남기는 치료기록을 대신 정리하는 보조자입니다.
치료사가 탭으로 남긴 오늘 일지(중재·시간·보조 수준·반응)와 메모를 읽고, EMR의 "치료 내용"란에 그대로 붙여 넣을 회기 기록을 만듭니다.

입력:
- [치료사 구술 메모] 머리말이 붙은 글은 말로 남긴 메모를 받아쓴 것이라 받아쓰기 오류가 섞여 있습니다("민에이" → min A, "에스비에이" → SBA 등). 문맥으로 바로잡습니다.
- 머리말이 없는 글은 치료사가 직접 적은 메모입니다. 일지와 메모는 사실로 받아들입니다.
- 일지와 메모가 다르면 메모를 따릅니다.

record 형식:
- 한 줄씩 "- "로 시작하는 개조식 3~7줄, "~함/~보임" 체.
- 순서: ① 실시한 중재를 구체적으로(어떤 활동을, 어떤 도구로, 몇 회·몇 분) ② 수행 수준(보조 수준, cue 종류·횟수, 좌우 구분) ③ 대상자 반응·호소(대상자가 한 말은 따옴표로 짧게 인용) ④ 특이사항(휴식, 통증, 낙상 위험, 퇴원·가족 관련 이야기 등) ⑤ 다음 회기 계획(메모에 있을 때만)
- 수가 항목, 치료 시간 합계, 평가 점수, 회기 수, 날짜는 앱이 따로 붙이므로 쓰지 않습니다.
- 지난 회차와 같은 중재라고 해서 생략하지 않습니다. 오늘 한 것을 오늘 기록으로 씁니다.

규칙:
- 일지·메모·지난 회차에 있는 내용만 씁니다. 없는 횟수나 수치를 지어내지 않습니다.
- 꼭 필요한 정보가 모호할 때만 questions에 최대 2개 남깁니다(예: 보조 수준이 메모와 일지에서 다를 때). 그 경우 record에는 확인된 내용만 씁니다. options는 탭으로 고를 짧은 보기 2~5개, 숫자를 적어야 하면 빈 배열.
- 치료사 답변이 주어지면 반영하고 questions는 빈 배열로 둡니다.
- 개인정보 보호: 이름, 등록번호, 연락처, 주소, 가족 이름은 쓰지 않고 "대상자", "보호자"로 바꿉니다.
${ROLE_RULES[role].split("\n").slice(0, 2).join("\n")}`;

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    record: { type: "string" },
    questions: NOTE_SCHEMA.properties.questions,
  },
  required: ["record", "questions"],
  additionalProperties: false,
};

// 비용 등급. 비용이 맞아야 계속 운영할 수 있어 Opus는 쓰지 않는다.
// - cheap: 말한 내용 나누기·환자용 안내문처럼 단순 정리
// - write: 매 회기 기록·SOAP처럼 정해진 형식으로 옮겨 쓰기
// - think: 보고서 전문가 초안·중재 추천·슈퍼비전처럼 임상 추론이 필요한 것 (모델은 아래 MODELS 표, 기관 등급별)
type Tier = "cheap" | "write" | "think";
// AI 등급(기관 설정 organizations.ai_tier). basic = 구독료에 포함되는 가성비 구성, pro = 추가 요금을 내는 기관에만 최고급 모델.
// - basic: cheap Haiku 5.5 · write Sonnet 5.5 low · think Sonnet 5.5 low
// - pro:   cheap Sonnet 5.5 low · write Sonnet 5.5 medium · think Opus 5.5 medium (보고서 전문가 초안·코치 노트·케이스 상담)
type Plan = "basic" | "pro";
const MODELS: Record<Plan, Record<Tier, [string, "low" | "medium"]>> = {
  basic: { cheap: ["claude-haiku-5-5", "low"], write: ["claude-sonnet-5-5", "low"], think: ["claude-sonnet-5-5", "low"] },
  pro: { cheap: ["claude-sonnet-5-5", "low"], write: ["claude-sonnet-5-5", "medium"], think: ["claude-opus-5-5", "medium"] },
};
const planCtx = new AsyncLocalStorage<Plan>(); // 요청마다 등급을 들고 다닌다 (askJson이 읽는다)
const planOf = (): Plan => planCtx.getStore() || "basic";
// Bedrock 경로: 구조화 출력(output_config)·effort 대신 도구 호출을 강제해 같은 JSON 스키마로 받는다.
async function askJsonBedrock(system: string, schema: unknown, text: string, tier: Tier) {
  const ak = Deno.env.get("AWS_ACCESS_KEY_ID"), sk = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!ak || !sk) return json(503, { error: "not_configured" });
  if (text.length > MAX_TEXT) return json(413, { error: "too_long" });
  const client = new AnthropicBedrock({ awsAccessKey: ak, awsSecretKey: sk, awsRegion: BEDROCK_REGION });
  const res = await client.messages.create({
    model: planOf() === "pro" && tier === "think" ? (Deno.env.get("BEDROCK_MODEL_PRO_THINK") || "anthropic.claude-opus-5-v1:0") : BEDROCK_MODEL[tier],
    max_tokens: 16000,
    system,
    tools: [{ name: "out", description: "정리한 결과를 이 형식으로 돌려줍니다.", input_schema: schema as Anthropic.Tool["input_schema"] }],
    tool_choice: { type: "tool", name: "out" },
    messages: [{ role: "user", content: text }],
  });
  if (res.stop_reason === "max_tokens") return json(502, { error: "truncated" });
  const call = res.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined;
  if (!call?.input) return json(502, { error: "upstream" });
  return json(200, call.input);
}
async function askJson(system: string, schema: unknown, text: string, tier: Tier = "write") {
  if (AI_PROVIDER === "bedrock") return askJsonBedrock(system, schema, text, tier);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json(503, { error: "not_configured" });
  if (text.length > MAX_TEXT) return json(413, { error: "too_long" });
  const client = new Anthropic({ apiKey: key });
  const [model, effort] = MODELS[planOf()][tier];
  const res = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: text }],
  } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "refusal") return json(422, { error: "refusal" });
  if (res.stop_reason === "max_tokens") return json(502, { error: "truncated" });
  const out = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return json(200, JSON.parse(out));
}

async function record(req: Request) {
  const { role, text } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  return askJson(recordPrompt(role), RECORD_SCHEMA, text);
}

// ---------- 치료 아이디어 ----------
// 초보 치료사도 바로 따라 할 수 있게, 목표와 연결된 중재를 준비물·순서·난이도 조절·관찰 포인트까지 풀어서 제안한다.
// 처방이 아니며, 최종 판단은 치료사가 한다.
// AI 슈퍼바이저의 관점: 해당 직무 30년차 임상가이자 관련 학과 교수 (참고 의견이며 실제 자격을 뜻하지 않는다)
const MENTOR: Record<string, string> = {
  OT: "경력 30년의 작업치료사이자 작업치료학과 교수", PT: "경력 30년의 물리치료사이자 물리치료학과 교수", SLPA: "경력 30년의 성인 신경언어·연하 전문 언어재활사이자 언어치료학과 교수",
  SI: "경력 30년의 아동 감각통합 작업치료사이자 작업치료학과 교수", SLP: "경력 30년의 언어재활사이자 언어치료학과 교수",
  PLAY: "경력 30년의 놀이치료사(응용행동분석 포함)이자 아동상담·놀이치료 전공 교수", ART: "경력 30년의 미술치료사이자 미술치료 전공 교수",
  COG: "경력 30년의 아동 인지치료사이자 특수교육·인지재활 전공 교수",
};
const EVIDENCE_RULE = `- 근거 표기: 근거 수준은 "강"(여러 체계적 문헌고찰·임상진료지침의 일관된 권고), "중"(일부 무작위 연구·지침 조건부 권고), "약"(소규모·관찰 연구), "전문가 합의"(임상 경험·이론 기반) 중 하나로 씁니다. 근거 종류는 "뇌졸중 재활 임상진료지침 권고", "체계적 문헌고찰", "운동학습 이론"처럼 일반적으로 씁니다. 저자·연도·논문 제목·지침 조항 번호는 쓰지 않습니다(지어낼 위험이 있으므로). 확실하지 않으면 "근거 확인 필요"라고 씁니다.`;

const ideasPrompt = (role: string) => `당신은 ${MENTOR[role]}로, 임상 지도자(슈퍼바이저)입니다. 이론과 임상 경험, 근거기반 실무에 근거해 조언합니다. 경력이 짧은 치료사가 오늘 치료를 준비하거나 다음 회기를 계획할 때 바로 따라 할 수 있는 중재 아이디어를 제안합니다.

입력: 대상자의 진단명, 목표, 평가 점수 변화, 오늘 일지(중재·보조 수준·반응·달라진 점), 지난 기록, 주의사항, 메모, 치료사가 고른 초점 영역, 이미 받은 아이디어(제외할 것).

ideas: 3~4개. 서로 다른 접근이 되도록 고릅니다(예: ${role === "PT" ? "과제 지향 보행·이동 훈련, 점진적 저항 근력 강화, 균형·낙상 예방 훈련, 보조도구 적용, 보호자 교육" : role === "SLPA" ? "의미자질분석(SFA)·음운 단서 위계 이름대기, 스크립트 훈련, 제약유도 언어치료(CIAT) 변형, 보완대체의사소통(AAC), 호흡·발성·조음 훈련(LSVT 원리), 삼킴 운동(Shaker·멘델슨·노력 삼킴)과 보상전략, 보호자 의사소통 파트너 훈련" : "과제 지향 훈련, 보상 전략·보조도구, 기능 회복 훈련, 보호자 교육"}). 각 항목은
- title: 활동 이름(짧게)
- theory: 이 중재가 어떤 이론·원리에 입각한 것인지 한 줄(이론 이름 + 핵심 원리 한 구절). 예: "운동학습 이론 · 과제 특이적 반복과 피드백 점감", "신경가소성 원리 · 사용 의존적 재조직(강도·반복·현저성)", "점진적 과부하 원리 · 저항을 단계적으로 올려 근력 적응 유도", "운동 조절(시스템) 이론 · 과제·개인·환경 상호작용", "PNF · 신경생리학적 촉진(저항·신장·구두 지시)", "조직 치유 단계 · 증식기엔 통제된 부하", "통증 신경과학 교육 · 통증 재개념화", "Bobath/NDT · 정상 움직임 패턴 촉진", "운동 발달 이론", "감각통합 이론 · 적응 반응", "응용행동분석 · 강화·촉구 절차", "학습 이론(Bandura) · 모델링". 치료사가 '왜 이 중재인지' 한 줄로 설명할 수 있게 쓴다.
- approach: 접근법 이름 한 단어~한 구절(예: ${role === "PT" ? "과제 지향 보행 훈련, 체중지지 훈련, 점진적 저항 운동, 균형 훈련, 낙상 예방 교육, 유산소 지구력 훈련" : role === "SLPA" ? "의미자질분석, 음운 단서 위계, 스크립트 훈련, 멜로디 억양 치료(MIT), AAC 적용, 삼킴 근력 운동, 보상전략 교육" : "과제 지향 훈련, 강제유도운동치료(CIMT) 변형, 거울치료, 에너지 보존 교육, 보상 전략"})
- goal: 이 활동이 겨냥하는 목표 한 줄. 입력에 목표가 있으면 그 목표와 연결
- why: 이 대상자에게 맞는 이유 한두 문장. 오늘 수행 수준·점수·반응에 근거
- materials: 준비물(병원 치료실에 흔한 것 위주, 쉼표로 구분)
- steps: 진행 순서 3~5단계. 각 단계에 자세·횟수·시간·cue 예시를 구체적으로
- easier: 대상자가 힘들어할 때 난이도 낮추는 법 한 문장
- harder: 쉽게 해낼 때 난이도 올리는 법 한 문장
- observe: 치료 중 관찰하고 기록할 포인트(보조 수준, 시간, 횟수, 보상 동작 등)
- dose: 양과 강도 한 줄(예: 1회 20분, 10회 3세트, 주 5회, 휴식 1분 / 아동은 회기 중 시간). 대상자의 현재 수행 수준에 맞춥니다
- progress: 다음 단계로 넘어갈 기준 한 줄(예: 2회기 연속 verbal cue 1회 이하로 수행하면 보조도구 없이 진행)
- record_example: 이 활동을 했을 때 치료기록에 쓸 문장 예시 한 줄("~함" 체, 수치는 [ ]로 비워 둠)
- evidence: 근거 수준과 근거 종류 한 줄(예: "강 · 뇌졸중 재활 임상진료지침 권고"). 아래 근거 표기 규칙을 따름
caution: 이 대상자에게 공통으로 지켜야 할 안전 주의점 1~2문장. 없으면 빈 문자열.
tip: 경력이 짧은 치료사에게 주는 임상 팁 한두 문장(이 대상자 유형에서 흔히 놓치는 점). 없으면 빈 문자열.

원칙:
- 주의사항이 주어지면 반드시 지키고, 위반할 수 있는 활동은 제안하지 않습니다.
- 임상에서 널리 받아들여지는 일반적인 중재만 제안합니다. 근거가 약하거나 위험할 수 있는 방법은 넣지 않습니다.
${KID.has(role) ? "- 아동 대상입니다. 놀이 기반 활동으로 제안하고 title은 활동 이름, steps에는 시간(분)을 넣습니다(예: T스윙 5분, 로션 촉각놀이 10분). 보호자 목표(COPM)가 있으면 우선 반영하고, 가정에서 보호자가 할 수 있는 쉬운 연계 활동을 하나 포함합니다. 감각통합은 감각 조절·각성 단계를 고려하고, 놀이치료의 ABA는 강화·소거·촉구 절차를 구체적으로 적습니다.\n" : ""}${role === "PT" ? "- 운동은 강도(세트·반복·휴식, Borg 목표)와 중단 기준(통증 증가, 어지럼, 숨참, SpO2 저하, 혈압 급변 등)을 steps나 observe에 구체적으로 적습니다. 물리요법 장비는 보조 수단으로만 다루고 운동·기능 훈련을 중심에 둡니다.\n" : ""}- 초점 영역이 주어지면 그 영역 위주로, "자동"이면 목표와 오늘 수행에서 가장 중요한 영역을 고릅니다.
- 이미 받은 아이디어와 같은 활동은 다시 내지 않습니다.
- 진단을 내리거나 예후를 판정하지 않습니다. 약물·의료 처치는 다루지 않습니다.
- 정보가 부족하면 보수적으로, 진단명에서 흔히 쓰는 기본 중재부터 제안합니다.
- 평가도구의 문항이나 채점 기준은 옮기지 않습니다.
- 짧은 한국어, "~하기" 또는 "~함" 체. 임상 약어는 쓰던 대로 씁니다.
- 이름·등록번호 등 개인정보는 쓰지 않습니다.
${EVIDENCE_RULE}`;

// ---------- AI 슈퍼비전 (정체 구간·케이스 상담) ----------
// 기록 흐름을 보고 정체 원인 가설과 중재 변경안을 근거 수준과 함께 제시한다. 참고 의견이며 결정은 치료사가 한다.
const supervisePrompt = (role: string) => `당신은 ${MENTOR[role]}입니다. 후배 치료사가 담당 ${KID.has(role) ? "아동" : "대상자"}의 기록을 들고 케이스 상담(슈퍼비전)을 요청했습니다. 이론(${KID.has(role) ? "감각통합 이론, 발달 이론, 응용행동분석, 놀이 발달" : role === "SLPA" ? "신경가소성 원리, 어휘 접근·음운 처리 모델, 운동학습 원리(말 운동), 삼킴 생리와 보상·재활 전략, 의사소통 파트너 훈련" : "작업수행 모델, 운동학습·운동조절 이론, 신경가소성 원리, 과제 지향 접근"})과 30년 임상 경험, 근거기반 실무에 근거해 조언합니다.

입력: 진단명, 치료 기간·빈도, 목표, 평가 점수 변화, 앱이 찾은 정체 신호, 최근 회기 흐름(중재·보조 수준·특이사항), 최근 회기 기록, 치료사가 고민하는 점.

출력:
- summary: 지금 상황을 2~3문장으로. 정체가 맞는지, 기록상 무엇이 근거인지 판단합니다.
- hypotheses: 정체(또는 고민)의 원인 가설 2~4개 {cause, evidence: 입력 기록 중 근거, check: 가설을 확인할 평가·관찰 방법}. 중재 강도·난이도·과제 특이성·피드백 방식·동기·인지·환경·보호자 요인 등을 고루 검토합니다.
- changes: 중재 변경안 2~4개 {name, theory: 입각한 이론·원리 한 줄(이론 이름 + 핵심 원리), rationale: 왜 이 대상자에게, evidence_level: "강"|"중"|"약"|"전문가 합의", evidence_basis: 근거 종류, how: 빈도·강도·진행 방법을 구체적으로, measure: 효과를 확인할 지표와 시점}.
- reassess: 언제, 무엇으로 재평가할지.
- teaching_point: 이 사례에서 후배가 배울 임상 추론 포인트 한두 문장(교수 관점).
- caution: 안전 주의점(주의사항이 입력에 있으면 반드시 반영). 없으면 빈 문자열.

규칙:
- 입력 기록에 근거해 말합니다. 기록에 없는 사실·점수를 지어내지 않습니다.
- 진단을 새로 내리거나 예후를 단정하지 않습니다. 약물·의학적 처치는 다루지 않습니다.
- 임상에서 널리 받아들여지는 안전한 중재만 제안합니다.
- 이름·등록번호 등 개인정보는 쓰지 않습니다. 평가도구의 문항·채점 기준은 옮기지 않습니다.
- 짧은 한국어, "~해 보세요/~입니다" 체. 임상 약어는 쓰던 대로 씁니다.
${EVIDENCE_RULE}`;

const SUPERVISE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    hypotheses: { type: "array", items: { type: "object", properties: { cause: { type: "string" }, evidence: { type: "string" }, check: { type: "string" } }, required: ["cause", "evidence", "check"], additionalProperties: false } },
    changes: { type: "array", items: { type: "object", properties: { name: { type: "string" }, theory: { type: "string" }, rationale: { type: "string" }, evidence_level: { type: "string", enum: ["강", "중", "약", "전문가 합의"] }, evidence_basis: { type: "string" }, how: { type: "string" }, measure: { type: "string" } }, required: ["name", "theory", "rationale", "evidence_level", "evidence_basis", "how", "measure"], additionalProperties: false } },
    reassess: { type: "string" },
    teaching_point: { type: "string" },
    caution: { type: "string" },
  },
  required: ["summary", "hypotheses", "changes", "reassess", "teaching_point", "caution"],
  additionalProperties: false,
};

const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" }, theory: { type: "string" }, approach: { type: "string" }, goal: { type: "string" }, why: { type: "string" },
          materials: { type: "string" }, steps: { type: "array", items: { type: "string" } },
          easier: { type: "string" }, harder: { type: "string" }, observe: { type: "string" }, record_example: { type: "string" },
          evidence: { type: "string" }, dose: { type: "string" }, progress: { type: "string" },
        },
        required: ["title", "theory", "approach", "goal", "why", "materials", "steps", "easier", "harder", "observe", "record_example", "evidence", "dose", "progress"],
        additionalProperties: false,
      },
    },
    caution: { type: "string" },
    tip: { type: "string" },
  },
  required: ["ideas", "caution", "tip"],
  additionalProperties: false,
};

async function ideas(req: Request) {
  const { role, text, mode } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  if (mode === "supervise") return askJson(supervisePrompt(role), SUPERVISE_SCHEMA, text, "think");
  return askJson(ideasPrompt(role), IDEAS_SCHEMA, text, "think");
}

// ---------- 실습생 기록 점검 ----------
// 실습생·신규 치료사가 쓴 회기 기록을 지도 치료사 눈으로 점검하고 고칠 점을 알려 준다. 기록을 대신 확정하지 않는다.
const reviewPrompt = (role: string) => `당신은 ${ROLE_NAME[role]} 실습생을 지도하는 임상 슈퍼바이저입니다. 실습생이 쓴 회기 치료기록을 읽고 짧고 친절하게 피드백합니다.

점검 기준: ① 실시한 중재가 구체적인가(활동·도구·횟수·시간) ② 수행 수준이 객관적인가(보조 수준, cue 종류·횟수, 수치) ③ 대상자 반응·특이사항이 있는가 ④ 목표와 연결되는가 ⑤ 다음 계획이 있는가 ⑥ 주관적 표현("잘함", "좋아짐")을 근거 없이 썼는가 ⑦ 개인정보(이름 등)가 들어갔는가.

출력:
- good: 잘한 점 1~2개
- fix: 고칠 점 1~4개. 각 항목은 무엇이 부족한지와 어떻게 쓰면 되는지
- questions: 실습생이 스스로 생각해 볼 임상 질문 1~2개(예: 왜 이 보조 수준이라고 판단했나?)
- improved: 같은 내용을 더 나은 기록으로 고쳐 쓴 예시. 기록에 없는 수치는 지어내지 말고 [ ]로 비워 둡니다.

규칙: 기록에 없는 사실을 만들지 않습니다. 이름·등록번호는 쓰지 않습니다. "~함" 체, 짧은 한국어.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    good: { type: "array", items: { type: "string" } },
    fix: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    improved: { type: "string" },
  },
  required: ["good", "fix", "questions", "improved"],
  additionalProperties: false,
};

async function review(req: Request) {
  const { role, text } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  return askJson(reviewPrompt(role), REVIEW_SCHEMA, text);
}

// ---------- 퇴원(중간) 요약 ----------
// 입원부터 지금까지의 회기 기록·평가 점수·목표를 한 장으로 정리한다. 치료사가 EMR 퇴원 요약란에 옮겨 적는다.
const summaryPrompt = (role: string) => `당신은 한국 병원의 ${ROLE_NAME[role]}사가 퇴원(또는 중간) 요약을 쓰도록 돕는 보조자입니다.
입력: 대상자 정보, 치료 기간, 회기 수, 목표와 달성 여부, 평가 점수 변화, 날짜별 회기 기록.

summary 형식 (항목 제목은 그대로, 각 항목은 "- "로 시작하는 개조식 1~4줄, "~함/~보임" 체):
[치료 기간] 시작일~종료일, 총 회기 수
[주요 중재] 주로 시행한 중재와 방식
[평가 변화] 도구 이름과 점수 변화(처음 → 마지막). 평가가 없으면 "평가 기록 없음"
[목표 달성] 목표별 달성/부분 달성/미달성. 목표가 없으면 "설정된 목표 없음"
[기능 변화] 보조 수준·수행 능력의 변화. 기록에 근거한 것만
[권고 사항] 가정·다음 기관에서 이어갈 활동과 주의점. 기록에 근거가 있을 때만, 없으면 "치료사 확인 필요"

규칙:
- 입력에 있는 내용만 씁니다. 수치·날짜·회기 수를 지어내지 않습니다.
- 진단을 새로 내리거나 예후를 판정하지 않습니다.
- 이름·등록번호 등 개인정보는 쓰지 않고 "대상자", "보호자"로 씁니다.
- 평가도구의 문항이나 채점 기준은 옮기지 않고 도구 이름과 점수만 씁니다.`;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

// ---------- 평가 차트 (초기 · 중간 · 종결) ----------
// 입원(초기)·중간·퇴원 전(종결) 평가를 한 뒤 쓰는 차트 초안. 치료사가 가장 오래 붙잡는 글이라,
// 점수·소견·목표·기록을 항목별로 채워 주고 직접 확인할 곳은 [확인 필요]와 check 목록으로 알려 준다.
const CHART_SECTIONS: Record<string, { adult: string; kid: string }> = {
  초기: {
    adult: `[진단 및 의뢰] 진단명, 발병일·수술일·의뢰 사유(입력에 있을 때)
[주호소] 대상자·보호자의 호소와 바람. 들은 말은 따옴표로
[평가 결과] 도구별 총점(만점)과 치료사 소견. 점수의 기능적 의미는 널리 쓰이는 일반 범주로만 짧게(예: 일상생활 중등도 의존). 확실하지 않으면 해석하지 않음
[관찰 소견] {OBS}. 입력에 근거한 것만
[문제점] 기능 문제 2~5개
[강점] 동기, 보호자 지지, 남은 기능 등(근거 있을 때)
[목표] 장기·단기. 입력에 목표가 있으면 그대로 쓰고, 없으면 평가 결과에 근거해 기간·조건·수행 기준이 있는 목표를 1~3개 쓰고 끝에 "(제안)"
[치료 계획] 중재 방향, 빈도(입력의 주 N회 기준), 보호자 교육, 재평가 시기`,
    kid: `[의뢰 사유 및 주호소] 보호자의 걱정과 바람. 들은 말은 따옴표로
[배경 정보] 발달력·기관(어린이집·학교)·가정 상황(입력에 있을 때만)
[평가 결과] 도구별 총점(만점)과 치료사 소견. 해석은 일반적인 범주로만 짧게, 확실하지 않으면 해석하지 않음
[관찰 소견] {OBS}. 입력에 근거한 것만
[강점] 좋아하는 활동, 잘하는 것, 보호자 참여 등(근거 있을 때)
[문제점] 발달·참여 문제 2~5개
[목표] 보호자 목표(COPM 점수가 있으면 함께)와 단기·장기 목표. 입력에 없으면 평가에 근거해 1~3개 쓰고 끝에 "(제안)"
[치료 계획] 중재 방향, 빈도(입력의 주 N회, 회기 시간), 가정 연계 활동, 재평가 시기`,
  },
  중간: {
    adult: `[치료 경과] 치료 시작일~현재, 회기 수
[평가 비교] 도구별 초기 → 현재 점수와 변화량. 평가가 한 번뿐이면 그 점수만
[목표 진행] 목표별 달성/진행 중/미달성과 근거
[기능 변화] 보조 수준·수행 능력의 변화. 기록에 근거한 것만
[문제점 및 목표 수정] 남은 문제와 수정이 필요한 목표(새로 제안하는 것은 끝에 "(제안)")
[향후 계획] 중재 조정, 빈도, 보호자 교육, 다음 재평가`,
    kid: `[치료 경과] 치료 시작일~현재, 회기 수, 출석·보강
[평가 비교] 도구별 초기 → 현재 점수와 변화량. 평가가 한 번뿐이면 그 점수만
[목표 진행] 보호자 목표(COPM 변화 포함)와 단기 목표별 진행
[관찰된 변화] 촉구 수준·정반응·지속 시간 등 기록에 근거한 변화
[목표 수정] 남은 문제와 수정이 필요한 목표(새로 제안하는 것은 끝에 "(제안)")
[향후 계획] 중점 활동, 빈도, 가정 연계 활동, 다음 재평가`,
  },
  종결: {
    adult: `[치료 기간] 시작일~종료일, 총 회기 수
[평가 비교] 도구별 초기 → 종결 점수와 변화량
[목표 달성] 목표별 달성/부분 달성/미달성
[종결 시 기능 상태] 보조 수준·수행 능력. 초기와 비교
[권고 사항] 가정 프로그램, 보조도구, 안전 주의점, 보호자 교육. 근거가 있는 것만, 없으면 "[확인 필요]"
[추후 계획] 퇴원 후 계획(자택·요양·외래 등, 입력에 있을 때), 연계 기관`,
    kid: `[치료 기간] 시작일~종료일, 총 회기 수
[평가 비교] 도구별 초기 → 종결 점수와 변화량
[목표 달성] 보호자 목표(COPM 초기 → 종결)와 단기·장기 목표별 달성 정도
[종결 시 상태] 초기와 비교한 참여·수행의 변화
[가정·기관 연계 권고] 가정에서 이어 갈 활동, 어린이집·학교에 전할 점. 근거가 있는 것만
[종결 사유 및 추후 계획] 입력에 있을 때만, 없으면 "[확인 필요]"`,
  },
};
const OBS: Record<string, string> = {
  OT: "상지 기능, ADL 수행, 인지·지각, 연하 등",
  PT: "ROM, 근력, 균형, 보행·이동, 통증 등",
  SLPA: "청각적 이해, 이름대기, 따라말하기, 자발화, 조음 명료도·발성·호흡, 삼킴(식이 단계·사레) 등",
  SI: "감각 반응(추구·회피·민감·낮은 등록), 각성·자기조절, 자세·운동계획, 소근육·자조",
  SLP: "수용·표현 언어, 조음, 화용(차례·요구·대답)",
  PLAY: "놀이 수준, 정서 표현, 관계 맺기, 목표 행동",
  ART: "매체 사용, 표현 내용, 정서 반응",
  COG: "주의 지속, 기억, 문제 해결, 과제 수행",
};
const chartPrompt = (role: string, type: string) => `당신은 경력 15년의 ${ROLE_NAME[role]} 임상가입니다. ${KID.has(role) ? "아동발달센터" : "한국 병원"} 치료사가 ${type} 평가 차트를 쓰도록 초안을 만듭니다. 치료사가 검토·수정한 뒤 ${KID.has(role) ? "센터 기록지" : "EMR"}에 붙여 넣습니다.

입력: 대상자 정보(진단명, 치료 빈도), 목표, 평가 날짜별 도구 점수와 치료사가 적은 소견(괄호 안), 점수 변화, 평가 날 기록, 회기 기록, 치료사가 차트용으로 더 적은 정보.

chart 형식: 아래 항목 제목([ ])을 그대로 쓰고, 각 항목은 "- "로 시작하는 개조식 1~5줄, "~함/~보임" 체.
${CHART_SECTIONS[type][KID.has(role) ? "kid" : "adult"].replace("{OBS}", OBS[role])}

check: 치료사가 차트를 마무리하기 전에 직접 채우거나 확인할 것 0~5개, 각각 짧은 한 줄(예: "발병일이 입력에 없음", "목표 기간 확인"). 본문의 그 자리에는 [확인 필요]를 둡니다.

규칙:
- 입력에 있는 내용만 씁니다. 점수·날짜·회기 수·빈도를 지어내지 않습니다. 근거가 없는 항목은 "[확인 필요]"로 둡니다.
- 진단을 새로 내리거나 예후를 단정하지 않습니다.
- 이름·등록번호 등 개인정보는 쓰지 않고 "대상자"${KID.has(role) ? ', "아동"' : ""}, "보호자"로 씁니다.
- 저작권: 평가도구의 문항, 지시문, 채점 기준을 옮겨 적지 않습니다. 도구 이름, 총점(측정값), 치료사가 적은 소견만 씁니다. 치료사 소견에 없는 하위 항목을 만들지 않습니다.
${ROLE_RULES[role].split("\n").slice(0, 2).join("\n")}`;

const CHART_SCHEMA = {
  type: "object",
  properties: { chart: { type: "string" }, check: { type: "array", items: { type: "string" } } },
  required: ["chart", "check"],
  additionalProperties: false,
};

// ---------- 퇴원 안내문 (환자·보호자용) ----------
// 치료 마지막 날 보여 드리는 "치료 전후 변화"와 "퇴원 후 생활 안내". 쉬운 말로, A4 2쪽 이내. 점수 숫자 표는 앱이 그린다.
const handoutWho = (role: string) => (KID.has(role)
  ? "읽는 사람은 아동의 보호자입니다. 아동은 \"아이\" 또는 \"아동\"으로 씁니다."
  : "읽는 사람은 대상자(어르신일 수 있음)와 보호자입니다. 대상자에게 직접 말하듯 씁니다.");
const HANDOUT_COMMON = (role: string) => `- ${handoutWho(role)}
- 쉬운 존댓말("~하셨어요", "~할 수 있어요")과 짧은 문장으로 씁니다. 전문 용어와 영어 약어는 쓰지 않고 풀어 씁니다(예: min A → "조금만 도와드리면", SBA → "옆에서 지켜보면 혼자").
- 입력(기록·점수·목표·치료사가 적은 정보)에 있는 내용만 씁니다. 수치·날짜·횟수를 새로 만들지 않습니다.
- 진단이나 예후를 단정하지 않고 "완치" 같은 말을 쓰지 않습니다. 약 복용이나 의학적 처치는 지시하지 않고, 필요하면 "의사와 상의하세요"라고 씁니다.
- 이름·등록번호 등 개인정보는 쓰지 않습니다.
- 평가도구의 문항이나 채점 기준은 옮기지 않습니다.
- 전체 분량은 A4 2쪽 이내(본문 글자 수 합계 약 1200자 이내)로 합니다.`;

const comparePrompt = (role: string) => `당신은 경력 15년의 ${ROLE_NAME[role]} 임상가입니다. ${KID.has(role) ? "치료를 마치는(종결) 아동의 보호자" : "퇴원하는 대상자와 보호자"}에게 치료 마지막 날 보여 드릴 "치료 전후 변화 안내"를 씁니다. 처음과 비교해 무엇이 어떻게 달라졌는지 눈으로 확인하고 뿌듯함을 느끼게 하는 자료입니다.

출력:
- headline: 가장 의미 있는 변화를 한 문장으로(예: "혼자 숟가락으로 식사하실 수 있게 되었어요"). 기록에 근거합니다.
- summary: 치료 기간 동안의 변화를 2~3문장으로.
- score_notes: 입력에 있는 평가 도구마다 {tool: 입력의 도구 이름 그대로, note: 점수 변화가 생활에서 무엇을 뜻하는지 쉬운 말 한 문장}. 숫자는 앱이 따로 보여 주므로 note에 숫자를 반복하지 않아도 됩니다. 평가가 없으면 빈 배열.
- changes: 입력의 <같은 중재 비교>에 있는 중재마다 {area: 중재를 쉬운 말로(예: "식사 연습"), before: 처음 했을 때 모습, after: 마지막에 했을 때 모습}. 처음과 마지막에 같은 중재를 했을 때만 비교합니다. 비교가 없으면 빈 배열로 두고, 다른 중재끼리 비교하거나 기록에 없는 변화를 만들지 않습니다.
- goals: 입력의 목표마다 {goal: 쉬운 말로 바꾼 목표, result: "이루었어요" | "거의 다 왔어요" | "계속 연습해요" 중 하나, note: 한 문장}. 목표가 없으면 빈 배열.
- keep_doing: 집에서 이어 가면 좋은 것 2~4개(짧은 한 줄씩).
- cheer: 대상자${KID.has(role) ? "와 보호자" : ""}에게 건네는 따뜻한 한두 문장. 과장하지 않습니다.

규칙:
${HANDOUT_COMMON(role)}
- 변화가 적거나 나빠진 부분은 낙인 없이 사실대로 부드럽게 씁니다(예: "조금 더 연습이 필요해요").`;

const carePrompt = (role: string) => `당신은 경력 15년의 ${ROLE_NAME[role]} 임상가입니다. ${KID.has(role) ? "치료를 마치는(종결) 아동의 보호자에게 가정에서 이어 갈 활동과 주의할 점" : "퇴원하는 대상자와 보호자에게 퇴원 후 집에서 지켜야 할 주의사항과 생활 방법"}을 안내하는 자료를 씁니다. ${ROLE_NAME[role]}사가 ${KID.has(role) ? "종결 상담" : "퇴원 교육"} 때 드리는 안내문입니다.

출력:
- summary: 지금 상태와 이 안내문의 목적을 한두 문장으로.
- sections: 이 대상자에게 해당하는 것만 3~5개 {title: 짧은 제목, items: 짧은 문장 2~5개}. 예시 제목: ${KID.has(role) ? "\"집에서 이렇게 놀아 주세요\", \"일상에서 연습하기\", \"이런 모습이 보이면 칭찬해 주세요\", \"주의할 점\"" : "\"넘어지지 않게\", \"식사하실 때\"(연하 기록이 있을 때만: 자세, 한 입 양, 식사 형태·물 농도는 기록에 있는 그대로), \"옷 입기·씻기\", \"보조도구 사용\", \"통증·부기 관리\", \"보호자께서 도와주실 때\""}.
- home_program: 집에서 하는 ${KID.has(role) ? "놀이·활동" : "운동·활동"} 2~4개 {name, how: 자세·방법 1~2문장, amount: 횟수·시간}. 기록에서 해 오던 것을 우선하고, 무리하지 않는 안전한 양으로 씁니다.
- warning_signs: ${KID.has(role) ? "이럴 때는 센터나 병원에 상담하세요 2~4개(예: 해내던 것을 다시 못 하게 될 때). 진단명과 기록에 맞는 일반적인 것만." : "이럴 때는 바로 병원·치료실에 연락하세요 2~5개. 진단명과 기록에 맞는 널리 알려진 일반적 경고 증상만 씁니다(예: 뇌졸중이면 갑자기 한쪽 힘이 빠지거나 말이 어눌해지면 바로 119)."}
- note: 마무리 한 문장(예: "궁금한 점은 언제든 치료실에 물어보세요").

규칙:
${HANDOUT_COMMON(role)}
- 입력의 주의사항은 반드시 반영합니다(예: 고관절 굽힘 제한).
- 기록에 없는 식사 단계나 활동 제한을 새로 정하지 않습니다.`;

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    score_notes: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, note: { type: "string" } }, required: ["tool", "note"], additionalProperties: false } },
    changes: { type: "array", items: { type: "object", properties: { area: { type: "string" }, before: { type: "string" }, after: { type: "string" } }, required: ["area", "before", "after"], additionalProperties: false } },
    goals: { type: "array", items: { type: "object", properties: { goal: { type: "string" }, result: { type: "string", enum: ["이루었어요", "거의 다 왔어요", "계속 연습해요"] }, note: { type: "string" } }, required: ["goal", "result", "note"], additionalProperties: false } },
    keep_doing: { type: "array", items: { type: "string" } },
    cheer: { type: "string" },
  },
  required: ["headline", "summary", "score_notes", "changes", "goals", "keep_doing", "cheer"],
  additionalProperties: false,
};
const CARE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sections: { type: "array", items: { type: "object", properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } }, required: ["title", "items"], additionalProperties: false } },
    home_program: { type: "array", items: { type: "object", properties: { name: { type: "string" }, how: { type: "string" }, amount: { type: "string" } }, required: ["name", "how", "amount"], additionalProperties: false } },
    warning_signs: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["summary", "sections", "home_program", "warning_signs", "note"],
  additionalProperties: false,
};

// ---------- 말로 한꺼번에 남긴 보고서 내용을 칸별로 나누기 (병원판) ----------
// 치료사가 평가 뒤 말로 쭉 남긴 내용을 입원·중간·퇴원 보고서 칸(주호소·소견·문제점·목표·계획 등)에 나눠 개조식으로 정리한다.
// 말한 내용만 옮기는 단순 정리라 값싼 모델을 쓴다.
const SORT_KEYS = ["chief", "opinion", "problem", "goal", "plan", "achieve", "advice"] as const;
const sortPrompt = (role: string, type: string, want: string[]) => `당신은 ${KID.has(role) ? "아동발달센터" : "한국 병원"} ${ROLE_NAME[role]}사의 ${type} 보고서 작성을 돕는 보조자입니다.
치료사가 평가를 마친 뒤 말로 쭉 남긴 내용을 받아, 보고서의 칸별로 나눠 정리합니다.

이번 보고서의 칸(키: 제목):
${want.map((x) => `- ${x}`).join("\n")}

규칙:
- <치료사가 말한 내용>에 있는 것만 옮깁니다. 말하지 않은 사실·수치·기간을 만들지 않습니다.
- 각 칸은 "- "로 시작하는 짧은 개조식 줄, "~함/~보임/~필요함/~예정임" 체로 씁니다. 영어 약어(min A, SBA, ROM 등)는 임상에서 쓰는 대로 둡니다.
- 받아쓰기 오류는 문맥으로 바로잡습니다("민에이" → min A, "에스비에이" → SBA).
- <참고>는 앱이 기록에서 옮긴 내용으로, 용어·점수를 바로잡을 때만 참고하고 칸에 다시 옮겨 적지 않습니다.
- 위 목록에 없는 칸, 말한 내용이 없는 칸은 빈 문자열로 둡니다.
- 진단을 새로 내리거나 예후를 단정하지 않습니다. 이름·등록번호 등 개인정보는 쓰지 않습니다.
- 평가도구의 문항·채점 기준은 옮기지 않습니다.
${ROLE_RULES[role].split("\n").slice(0, 2).join("\n")}`;
const draftPrompt = (role: string, type: string, want: string[]) => `당신은 ${MENTOR[role]}입니다. ${KID.has(role) ? "아동발달센터" : "한국 병원"} 치료사가 ${type} 보고서를 쓰는데, 가진 정보가 적어도 경력 많은 임상가가 쓴 것 같은 초안을 칸별로 만들어 줍니다.

입력: 진단명, 치료 빈도, 평가 날짜별 점수와 의미 있는 변화 판정, 보조 수준, 회기 기록 요약, 목표, 치료사가 이미 칸에 적은 내용(<치료사가 쓴 칸>).

이번 보고서의 칸(키: 제목):
${want.map((x) => `- ${x}`).join("\n")}

작성 원칙:
- 사실(점수, 날짜, 병력, 발병일, 대상자의 말, 회기 수)은 입력에 있는 것만 씁니다. 없는 사실이 필요하면 "[확인 필요: 무엇]"으로 둡니다.
- 판단은 적극적으로 씁니다. 점수와 보조 수준의 기능적 의미, 진단에서 흔히 동반되는 수행 문제, 근거기반 목표와 중재는 전문가로서 추론해 쓰고, 입력에 직접 근거가 없는 판단 문장 끝에는 "(제안)"을 붙입니다.
- 문제점: 활동·참여 수준의 문제를 먼저(예: 식사 시 min A 필요), 그 원인이 되는 신체기능·인지 문제를 뒤에 씁니다.
- 목표: 단기·장기를 나눠 기간·조건·수행 기준이 있는 측정 가능한 목표로 씁니다(예: "단기: 2주 내 두꺼운 손잡이 숟가락 사용하여 식사 SBA 수준으로 수행").
- 계획: 빈도(입력의 주 N회), 구체적 중재 이름과 방법, 보호자 교육, 재평가 시기를 씁니다. 근거 수준이 높은 중재를 우선합니다.
- 각 칸은 "- "로 시작하는 개조식, "~함/~보임/~필요함/~예정임" 체. 임상 약어는 쓰던 대로 씁니다.
- <치료사가 쓴 칸>에 이미 있는 문장은 다시 쓰지 말고, 그 칸에 더할 줄만 돌려줍니다. 더할 것이 없으면 빈 문자열.
- 위 목록에 없는 칸은 빈 문자열로 둡니다. 진단을 새로 내리거나 예후를 단정하지 않습니다.
- 이름·등록번호 등 개인정보는 쓰지 않습니다. 평가도구의 문항·채점 기준은 옮기지 않습니다.
${EVIDENCE_RULE}
${ROLE_RULES[role].split("\n").slice(0, 2).join("\n")}`;
const SORT_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(SORT_KEYS.map((k) => [k, { type: "string" }])),
  required: [...SORT_KEYS],
  additionalProperties: false,
};

async function summary(req: Request) {
  const { role, text, chart, handout, report_sort, report_mode, parts } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  if (report_sort !== undefined) {
    if (typeof report_sort !== "string" || !Object.hasOwn(CHART_SECTIONS, report_sort) || !Array.isArray(parts)) return json(400, { error: "bad_request" });
    const want = parts.map(String).filter((x) => (SORT_KEYS as readonly string[]).includes(x.split(":")[0])).slice(0, 7).map((x) => x.slice(0, 40));
    if (!want.length) return json(400, { error: "bad_request" });
    return askJson(report_mode === "draft" ? draftPrompt(role, report_sort, want) : sortPrompt(role, report_sort, want), SORT_SCHEMA, text, report_mode === "draft" ? "think" : "cheap");
  }
  if (handout !== undefined) {
    if (handout === "compare") return askJson(comparePrompt(role), COMPARE_SCHEMA, text, "cheap");
    if (handout === "care") return askJson(carePrompt(role), CARE_SCHEMA, text, "cheap");
    return json(400, { error: "bad_request" });
  }
  if (chart !== undefined) {
    if (typeof chart !== "string" || !Object.hasOwn(CHART_SECTIONS, chart)) return json(400, { error: "bad_request" });
    return askJson(chartPrompt(role, chart), CHART_SCHEMA, text, "think");
  }
  return askJson(summaryPrompt(role), SUMMARY_SCHEMA, text);
}


// ---------- 아동 월간 경과 보고서 ----------
// 한 달 동안의 회기 기록·목표·평가를 보호자와 센터에 드릴 보고서 초안으로 정리한다.
const reportPrompt = (role: string) => `당신은 아동발달센터의 경력 많은 ${ROLE_NAME[role]} 선생님입니다. 한 달 동안의 회기 기록으로 보호자와 센터에 드릴 월간 경과 보고서 초안을 씁니다.

report 형식 (항목 제목은 그대로, 각 항목은 2~4문장 또는 "- " 개조식):
[이번 달 치료 개요] 회기 수, 출석·보강, 주로 한 활동
[목표별 진행] 보호자 목표(COPM)와 단기 목표마다 이번 달 변화. COPM 점수 변화가 있으면 함께
[관찰된 변화] 기록에 근거한 구체적 행동 변화(예: 촉구 수준, 정반응, 지속 시간)
[가정에서 함께해 주세요] 보호자가 집에서 쉽게 할 수 있는 활동 2~3개
[다음 달 계획] 다음 달 중점 목표와 활동

규칙:
- 보호자가 읽기 쉬운 존댓말("~했습니다", "~보였습니다")로, 전문 약어는 풀어서 씁니다.
- 기록에 있는 내용만 씁니다. 수치·날짜·회기 수를 지어내지 않습니다. 근거가 부족하면 "관찰 중입니다"라고 씁니다.
- 진단을 내리거나 예후를 단정하지 않습니다. 아동을 비교하거나 부정적으로 낙인찍는 표현을 쓰지 않습니다.
- 이름·등록번호 등 개인정보는 쓰지 않고 "아동", "보호자"로 씁니다.
- 평가도구의 문항이나 채점 기준은 옮기지 않고 도구 이름과 점수만 씁니다.`;

const REPORT_SCHEMA = {
  type: "object",
  properties: { report: { type: "string" } },
  required: ["report"],
  additionalProperties: false,
};

async function report(req: Request) {
  const { role, text } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  return askJson(reportPrompt(role), REPORT_SCHEMA, text);
}

// ---------- 말 → 글 ----------
const STT_HINT = "재활치료사의 치료·평가 메모입니다. 자주 쓰는 말: min A, mod A, max A, SBA, CGA, indep, mod I, dep, verbal cue, tactile cue, ROM, MMT, ADL, K-MBI, FIM, FMA, MoCA, BBS, TUG, COPM, SOAP, 편마비, 상지, 하지, 연하, 보행, 이동, 전이, 재평가.";
async function stt(req: Request) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json(503, { error: "not_configured" });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) return json(400, { error: "bad_request" });
  if (file.size > MAX_AUDIO) return json(413, { error: "too_long" });

  // 빠르게 말해도 잘 받도록 gpt-4o-mini-transcribe(분당 약 $0.003, whisper-1의 절반)를 먼저 쓰고, 실패하면 whisper-1로 다시 한다.
  // 임상 약어를 미리 알려 주면 "민에이"처럼 받아 적는 일이 줄어든다.
  const send = (model: string) => {
    const fd = new FormData();
    fd.append("file", file, file.name || "memo.m4a");
    fd.append("model", model);
    fd.append("language", "ko");
    fd.append("prompt", STT_HINT);
    return fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  };
  let r = await send("gpt-4o-mini-transcribe");
  if (!r.ok) r = await send("whisper-1");
  if (!r.ok) return json(502, { error: "stt_failed", status: r.status });
  const { text } = await r.json();
  return json(200, { text });
}

// ---------- 차트 사진 글(OCR) → 진단명·주호소·S/O (병원판) ----------
// 앱이 폰 안에서 간호 차트·의뢰지 사진을 글로 바꾸고(OCR), 이름·등록번호를 지운 뒤 보낸다. 사진 자체는 서버로 오지 않는다.
// 글에 있는 것만 칸별로 옮기는 단순 정리라 값싼 모델을 쓴다.
const chartOcrPrompt = (role: string) => `당신은 한국 병원 ${ROLE_NAME[role]}사의 기록 보조자입니다. 간호 차트·의뢰지·처방지를 사진으로 찍어 글로 바꾼 내용(OCR, 오타·줄바꿈 오류 있음)을 받아, 치료 기록에 쓸 칸으로 나눕니다.

칸:
- dx: 진단명(영문 약어와 한글 병기, 여러 개면 " / "로). 수술명·발병일이 있으면 괄호에.
- onset: 발병일·수술일 (YYYY-MM-DD 또는 원문 표기). 없으면 빈 문자열.
- cc: 주호소·의뢰 사유 (환자·보호자 호소, 의뢰 목적). "- " 개조식.
- s: 주관적 정보 S에 넣을 내용(호소·병력 중 환자가 말한 것). "- " 개조식.
- o: 객관적 정보 O에 넣을 내용(진단 검사 결과, 수술, 처방, 활력징후, 금기, 보조기, 기왕력 등 관찰·기록된 사실). "- " 개조식.
- precaution: 치료 시 주의사항(금기 자세, 체중지지 제한, 낙상 위험, 알레르기, 격리, 혈압 기준, 절대안정 등). 한 줄, 없으면 빈 문자열.
- meds: 치료와 관련 있는 약(항응고제, 항경련제, 혈압약, 진통제 등 이름만). 없으면 빈 문자열.
- unclear: OCR이 흐려 확신 못 하는 항목을 "[확인 필요: 무엇]" 형식으로 나열. 없으면 빈 문자열.

규칙:
- 글에 있는 것만 옮깁니다. 없는 사실을 만들지 않습니다. OCR 오타는 임상 문맥으로 바로잡되(예: "Rt hemiplegla" → "Rt. hemiplegia"), 확신이 없으면 unclear에 적습니다.
- 이름·등록번호·주민번호·연락처·주소·보호자 이름은 어떤 칸에도 쓰지 않습니다. 나이·성별은 dx 괄호 안에 "70대 남" 수준으로만.
- 약어는 임상에서 쓰는 대로("Lt. hemiplegia", "s/p THR"). "~함/~있음" 개조식.
- 치료 계획·목표·평가 점수는 만들지 않습니다(여기서는 차트 사실만).`;
const CHART_OCR_SCHEMA = {
  type: "object",
  properties: { dx: { type: "string" }, onset: { type: "string" }, cc: { type: "string" }, s: { type: "string" }, o: { type: "string" }, precaution: { type: "string" }, meds: { type: "string" }, unclear: { type: "string" } },
  required: ["dx", "onset", "cc", "s", "o", "precaution", "meds", "unclear"],
  additionalProperties: false,
};
async function chartOcr(req: Request) {
  const { role, text } = await req.json().catch(() => ({}));
  if (!ROLE_RULES[role] || typeof text !== "string" || !text.trim()) return json(400, { error: "bad_request" });
  if (text.length > 6000) return json(413, { error: "too_long" });
  return askJson(chartOcrPrompt(role), CHART_OCR_SCHEMA, text, "cheap");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  const device = req.headers.get("x-device-id") || "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return json(400, { error: "device" });
  const last = new URL(req.url).pathname.split("/").pop() as Kind;
  const kind: Kind = last in LIMITS ? last : "soap";
  try {
    const gate = await instGate(req, kind);
    if (gate instanceof Response) return gate;
    if (!(await take(device, kind))) return json(429, { error: "daily_limit", limit: LIMITS[kind] });
    return await planCtx.run(gate, async () => {
      if (kind === "stt") return await stt(req);
      if (kind === "record") return await record(req);
      if (kind === "ideas") return await ideas(req);
      if (kind === "summary") return await summary(req);
      if (kind === "review") return await review(req);
      if (kind === "report") return await report(req);
      if (kind === "chart") return await chartOcr(req);
      return await soap(req);
    });
  } catch (e) {
    // 내용은 남기지 않고 오류 종류만 기록한다
    console.error(kind, e instanceof Anthropic.APIError ? `anthropic ${e.status}` : (e as Error).name);
    return json(502, { error: "upstream" });
  }
});
