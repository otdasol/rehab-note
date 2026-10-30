-- AI 등급: basic(구독 포함, 가성비 모델) / pro(추가 요금, 최고급 모델로 보고서 초안·코치 노트). 관리자가 기관 관리에서 바꾼다.
alter table public.organizations add column if not exists ai_tier text not null default 'basic' check (ai_tier in ('basic','pro'));
grant update (ai_tier) on public.organizations to authenticated;
create or replace function public.audit_org_settings()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
declare d jsonb := '{}'::jsonb;
begin
  if new.ai_enabled is distinct from old.ai_enabled then d := d || jsonb_build_object('ai_enabled', new.ai_enabled); end if;
  if new.ai_basis is distinct from old.ai_basis then d := d || jsonb_build_object('ai_basis', new.ai_basis); end if;
  if new.ai_tier is distinct from old.ai_tier then d := d || jsonb_build_object('ai_tier', new.ai_tier); end if;
  if new.messaging_enabled is distinct from old.messaging_enabled then d := d || jsonb_build_object('messaging_enabled', new.messaging_enabled); end if;
  if new.patient_retention_days is distinct from old.patient_retention_days then d := d || jsonb_build_object('patient_retention_days', new.patient_retention_days); end if;
  if new.show_names is distinct from old.show_names then d := d || jsonb_build_object('show_names', new.show_names); end if;
  if new.name is distinct from old.name then d := d || jsonb_build_object('name', new.name); end if;
  if d <> '{}'::jsonb then
    insert into public.audit_log (org_id, actor, action, target_type, target_id, detail)
    values (new.id, auth.uid(), 'org.settings', 'organization', new.id::text, d);
  end if;
  return new;
end $function$;
