# DB 변경 기록

Supabase 프로젝트 `orlabcbhnarulribebvy`에 적용된 마이그레이션 목록 (2026-10-26 기준).
원문 SQL은 Supabase에 그대로 남아 있다. 새 PC에서 Supabase 연결 후 아래로 꺼내 볼 수 있다:

```sql
select version, name, statements from supabase_migrations.schema_migrations order by version;
```

| 버전 | 이름 | 내용 |
|---|---|---|
| 20261024134117 | ai_usage_counter | 기기별 하루 AI 사용 횟수 표 `ai_usage(device_id, day, kind, count)`, `ai_usage_take()` |
| 20261024142856 ~ 20261025054016 | ai_usage_*_kind | kind에 record·ideas·summary·review·report 추가 |
| 20261025014142 | ai_usage_retention_30d | 사용 횟수는 30일만 보관 |
| 20261025115546 | institution_core | 기관·구성원·초대(해시)·기기·감사 기록, RLS, 초대/가입/해지 함수 |
| 20261025115629 | institution_patient_data | 환자 토큰·동의·연락처·리포트·추적·월 집계 표와 RLS, 동의 철회·퇴원 함수 |
| 20261025115648 | institution_audit_fix_and_purge | 감사 트리거, 매일 새벽 3시 자동 파기(pg_cron) |
| 20261025115717 | institution_function_grants | 함수 실행 권한 정리 |
| 20261025120710 | institution_app_hardening | 칸 단위 권한, `ai_check()`(서비스 권한 전용) |
| 20261025121306 | institution_org_settings_audit | 기관 설정 변경 감사 기록 |
| 20261025122529 | audit_log_event_internal_only | `log_event`를 사용자가 직접 못 부르게 |

새 마이그레이션을 적용하면 이 표에도 한 줄 추가한다.
| 20261026 | invite_multi_use | `invites.max_uses`(1~50)·`use_count`. `create_invite(p_org, p_role, p_max_uses=1, p_days=7)`: 관리자 초대는 1명만. `accept_invite`는 횟수 안에서 여러 명 허용, 이미 활동 중인 구성원은 횟수 안 깎음. 앱의 "여러 명 · 30일"은 20명·30일 |
| 20261026 | invite_drop_old_signature | 옛 `create_invite(uuid, member_role)` 삭제 (rpc 모호성 방지) |
| 20261026 | pc_relay | PC 받기함 중계 표 `pc_relay`(pair_id, ciphertext), anon 읽기·삭제/로그인 쓰기, realtime 발행, 5분마다 10분 지난 행 삭제(`purge_pc_relay`) |
| 20261026 | pc_relay_insert_policy | 쓰기 정책을 `auth.uid() is not null`로 단순화 |
