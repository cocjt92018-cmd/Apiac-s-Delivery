-- Execute manualmente no SQL Editor como proprietário do banco.
-- public.commerces deve existir com os campos usados pelo app.
-- As políticas destas três tabelas são substituídas pelo conjunto abaixo.
begin;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
alter table public.profiles enable row level security;
alter table public.commerces enable row level security;
alter table public.profiles add column if not exists profile_type text;
alter table public.profiles drop constraint if exists profiles_profile_type_check;
alter table public.profiles add constraint profiles_profile_type_check check (profile_type in ('client', 'commerce', 'cliente', 'comercio', 'admin'));
alter table public.commerces add column if not exists responsible_cpf text;
alter table public.commerces add column if not exists company_cnpj text;
alter table public.commerces add column if not exists registration_status text not null default 'nao_consultada';
create unique index if not exists commerces_company_cnpj_unique on public.commerces (company_cnpj) where company_cnpj is not null;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Atribuição de administradores somente pelo SQL Editor, nunca pelo app.
revoke all on public.admin_users from public, anon, authenticated;
revoke all on public.profiles from public, anon, authenticated;
revoke all on public.commerces from public, anon, authenticated;
-- Remove também concessões antigas por coluna, que REVOKE de tabela não remove.
do $$
declare item record;
begin
  for item in
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and table_name in ('admin_users', 'profiles', 'commerces')
  loop
    execute format('revoke all privileges (%I) on public.%I from public, anon, authenticated', item.column_name, item.table_name);
  end loop;
  for item in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('admin_users', 'profiles', 'commerces')
  loop
    execute format('drop policy %I on public.%I', item.policyname, item.tablename);
  end loop;
end;
$$;

grant usage on schema public to authenticated;
grant select on public.profiles, public.commerces to authenticated;
grant insert (owner_id, name, responsible_name, document, phone, email,
  category, street, number, neighborhood, complement, opening_time,
  closing_time, is_open, status, registration_status, responsible_cpf, company_cnpj, delivery_fee)
  on public.commerces to authenticated;
grant update (name, responsible_name, document, phone, email, category,
  street, number, neighborhood, complement, opening_time, closing_time,
  is_open, status, registration_status, responsible_cpf, company_cnpj, delivery_fee) on public.commerces to authenticated;

create policy commerces_select_own on public.commerces
  for select to authenticated using (owner_id = (select auth.uid()));
create policy commerces_select_admin on public.commerces
  for select to authenticated using ((select public.is_admin()));
create policy commerces_insert_own on public.commerces
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'pendente_aprovacao' and registration_status = 'nao_consultada');
create policy commerces_update_own on public.commerces
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy commerces_update_admin on public.commerces
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Os proprietários continuam limitados aos campos editáveis no painel comercial.
-- A concessão de UPDATE ampliada acima não autoriza alterar status administrativo.
create or replace function public.check_commerce_admin_fields()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    if (to_jsonb(new) - array['phone','email','opening_time','closing_time','is_open'])
       is distinct from
       (to_jsonb(old) - array['phone','email','opening_time','closing_time','is_open']) then
      raise exception 'Alteração de campos administrativos não permitida' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.check_commerce_admin_fields() from public, anon, authenticated;
drop trigger if exists apiacas_check_commerce_admin_fields on public.commerces;
create trigger apiacas_check_commerce_admin_fields before update on public.commerces
  for each row execute function public.check_commerce_admin_fields();

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_select_admin on public.profiles
  for select to authenticated using ((select public.is_admin()));

-- Metadados são apenas dados de perfil: nunca são usados para autorizar admin.
create or replace function public.sync_apiacas_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.profiles (id, name, phone, email, created_at, profile_type)
  values (new.id, new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'phone', new.email, new.created_at,
      new.raw_user_meta_data ->> 'profile_type')
  on conflict (id) do update set
    name = excluded.name, phone = excluded.phone, email = excluded.email,
    profile_type = coalesce(public.profiles.profile_type, excluded.profile_type);
  return new;
end;
$$;
revoke all on function public.sync_apiacas_profile() from public, anon, authenticated;
drop trigger if exists apiacas_sync_profile on auth.users;
create trigger apiacas_sync_profile
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.sync_apiacas_profile();

insert into public.profiles (id, name, phone, email, created_at, profile_type)
select id, raw_user_meta_data ->> 'name', raw_user_meta_data ->> 'phone', email, created_at,
       raw_user_meta_data ->> 'profile_type'
from auth.users
on conflict (id) do update set
  name = excluded.name, phone = excluded.phone, email = excluded.email,
  profile_type = coalesce(public.profiles.profile_type, excluded.profile_type);

commit;
