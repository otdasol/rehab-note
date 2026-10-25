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
