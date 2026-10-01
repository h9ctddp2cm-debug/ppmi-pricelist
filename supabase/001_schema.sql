-- PPMI 復康用品價目平台 — Supabase schema & API functions
-- All access from the static site goes through SECURITY DEFINER functions (RPC).
-- Tables have RLS enabled with no policies, so the anon key cannot read/write them directly.

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------
create table if not exists settings (
  key text primary key,
  value text not null
);
create table if not exists suppliers (
  id bigserial primary key,
  name text not null unique,
  token text not null unique,
  contact_name text not null default '',
  tel text not null default '',
  email text not null default '',
  website text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  last_updated_at timestamptz,
  last_confirmed_at timestamptz
);
create table if not exists categories (
  id bigserial primary key,
  team text not null default '',
  name text not null unique,
  sort_order int not null
);
create table if not exists items (
  id bigserial primary key,
  supplier_id bigint not null references suppliers(id) on delete cascade,
  team text not null default '',
  category text not null,
  subcategory text not null default '',
  name text not null,
  model text not null default '',
  spec text not null default '',
  weight text not null default '',
  weight_limit text not null default '',
  price_text text not null default '',
  price numeric,
  sales text not null default '',
  tel text not null default '',
  remarks text not null default '',
  url text not null default '',
  status text not null default 'active' check (status in ('active','discontinued')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  price_updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  discontinued_at timestamptz
);
create index if not exists idx_items_supplier on items(supplier_id);
create table if not exists changes (
  id bigserial primary key,
  item_id bigint,
  supplier_id bigint,
  item_name text not null default '',
  actor text not null,
  action text not null,
  field text not null default '',
  old_value text not null default '',
  new_value text not null default '',
  changed_at timestamptz not null default now()
);
create index if not exists idx_changes_time on changes(changed_at desc);
create table if not exists admin_sessions (
  token text primary key,
  expires_at timestamptz not null
);

alter table settings enable row level security;
alter table suppliers enable row level security;
alter table categories enable row level security;
alter table items enable row level security;
alter table changes enable row level security;
alter table admin_sessions enable row level security;

-- ---------- internal helpers (not callable by anon) ----------
create or replace function _new_token() returns text language sql as $$
  select translate(rtrim(encode(extensions.gen_random_bytes(12), 'base64'), '='), '+/', '-_');
$$;

create or replace function _parse_price(p text) returns numeric language plpgsql immutable as $$
declare s text;
begin
  s := trim(regexp_replace(coalesce(p,''), 'HK\$|\$|,', '', 'g'));
  if s = '' then return null; end if;
  begin
    return s::numeric;
  exception when others then
    return null;
  end;
end $$;

create or replace function _log_change(p_item_id bigint, p_supplier_id bigint, p_item_name text, p_actor text, p_action text, p_field text, p_old text, p_new text)
returns void language sql as $$
  insert into changes(item_id, supplier_id, item_name, actor, action, field, old_value, new_value)
  values (p_item_id, p_supplier_id, coalesce(p_item_name,''), p_actor, p_action, coalesce(p_field,''), coalesce(p_old,''), coalesce(p_new,''));
$$;

create or replace function _require_admin(p_token text) returns void language plpgsql as $$
begin
  delete from admin_sessions where expires_at < now();
  if p_token is null or not exists (select 1 from admin_sessions where token = p_token) then
    raise exception 'UNAUTHORIZED' using errcode = 'PT401';
  end if;
  update admin_sessions set expires_at = now() + interval '12 hours' where token = p_token;
end $$;

create or replace function _supplier_by_token(p_stoken text) returns suppliers language plpgsql as $$
declare s suppliers;
begin
  select * into s from suppliers where token = p_stoken;
  if s.id is null then raise exception '連結無效或已失效，請聯絡部門重新索取。' using errcode = 'PT404'; end if;
  return s;
end $$;

create or replace function _ensure_category(p_name text, p_team text) returns void language plpgsql as $$
begin
  if not exists (select 1 from categories where name = p_name) then
    insert into categories(team, name, sort_order)
    values (coalesce(p_team,''), p_name, (select coalesce(max(sort_order),0)+1 from categories));
  end if;
end $$;

create or replace function _items_json(p_supplier_id bigint default null) returns jsonb language sql as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.category_order nulls last, t.sort_order, t.id), '[]'::jsonb)
  from (
    select i.*, s.name as supplier_name, s.contact_name as supplier_contact, s.tel as supplier_tel,
           s.last_updated_at as supplier_last_updated_at, s.last_confirmed_at as supplier_last_confirmed_at,
           c.sort_order as category_order
    from items i join suppliers s on s.id = i.supplier_id left join categories c on c.name = i.category
    where p_supplier_id is null or i.supplier_id = p_supplier_id
  ) t;
$$;

create or replace function _suppliers_json(p_include_token boolean) returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(t) - (case when p_include_token then '' else 'token' end) order by lower(t.name)), '[]'::jsonb)
  from (
    select s.*,
      (select count(*) from items i where i.supplier_id = s.id and i.status = 'active') as active_count,
      (select count(*) from items i where i.supplier_id = s.id and i.status = 'discontinued') as discontinued_count
    from suppliers s
  ) t;
$$;

create or replace function _categories_json() returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.sort_order), '[]'::jsonb) from categories c;
$$;

create or replace function _subcategories_json() returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.o), '[]'::jsonb)
  from (select category, subcategory, min(sort_order) as o from items where subcategory <> '' group by category, subcategory) t;
$$;

create or replace function _changes_json(p_supplier_id bigint, p_limit int) returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.changed_at desc, t.id desc), '[]'::jsonb)
  from (
    select c.*, s.name as supplier_name from changes c left join suppliers s on s.id = c.supplier_id
    where p_supplier_id is null or c.supplier_id = p_supplier_id
    order by c.changed_at desc, c.id desc limit p_limit
  ) t;
$$;

create or replace function _meta_json() returns jsonb language sql as $$
  select jsonb_build_object(
    'title', (select value from settings where key = 'list_title'),
    'import_date', (select value from settings where key = 'import_date'),
    'stale_months', coalesce((select value::int from settings where key = 'stale_months'), 6));
$$;

create or replace function _update_supplier(p_id bigint, p_data jsonb, p_actor text) returns void language plpgsql as $$
declare cur suppliers; f text; nv text; ov text;
begin
  select * into cur from suppliers where id = p_id;
  if cur.id is null then raise exception 'not found' using errcode = 'PT404'; end if;
  foreach f in array array['name','contact_name','tel','email','website','notes'] loop
    if p_data ? f and not (p_actor = 'supplier' and f = 'name') then
      nv := trim(coalesce(p_data->>f, ''));
      ov := case f when 'name' then cur.name when 'contact_name' then cur.contact_name when 'tel' then cur.tel
                   when 'email' then cur.email when 'website' then cur.website else cur.notes end;
      if nv <> coalesce(ov,'') then
        if f = 'name' and nv = '' then raise exception '公司名稱不能空白'; end if;
        execute format('update suppliers set %I = $1 where id = $2', f) using nv, p_id;
        perform _log_change(null, p_id, cur.name || ' (公司資料)', p_actor, 'update', f, ov, nv);
      end if;
    end if;
  end loop;
  if p_actor = 'supplier' then update suppliers set last_updated_at = now() where id = p_id; end if;
end $$;

create or replace function _confirm_supplier(p_id bigint, p_actor text) returns void language plpgsql as $$
declare n text;
begin
  select name into n from suppliers where id = p_id;
  update suppliers set last_confirmed_at = now(), last_updated_at = now() where id = p_id;
  update items set confirmed_at = now() where supplier_id = p_id and status = 'active';
  perform _log_change(null, p_id, n, p_actor, 'confirm', '', '', '');
end $$;

create or replace function _create_item(p_supplier_id bigint, p_data jsonb, p_actor text) returns bigint language plpgsql as $$
declare s suppliers; cat text; team text; new_id bigint; nm text;
begin
  select * into s from suppliers where id = p_supplier_id;
  if s.id is null then raise exception 'supplier not found' using errcode = 'PT404'; end if;
  cat := trim(coalesce(p_data->>'category',''));
  nm := trim(coalesce(p_data->>'name',''));
  if cat = '' or nm = '' then raise exception '類別及項目名稱為必填'; end if;
  perform _ensure_category(cat, p_data->>'team');
  select coalesce(nullif(p_data->>'team',''), c.team, '') into team from categories c where c.name = cat;
  insert into items(supplier_id, team, category, subcategory, name, model, spec, weight, weight_limit, price_text, price,
                    sales, tel, remarks, url, sort_order, created_by, updated_by)
  values (s.id, team, cat, trim(coalesce(p_data->>'subcategory','')), nm,
          coalesce(p_data->>'model',''), coalesce(p_data->>'spec',''), coalesce(p_data->>'weight',''), coalesce(p_data->>'weight_limit',''),
          coalesce(p_data->>'price_text',''), _parse_price(p_data->>'price_text'),
          coalesce(nullif(p_data->>'sales',''), s.contact_name, ''), coalesce(nullif(p_data->>'tel',''), s.tel, ''),
          coalesce(p_data->>'remarks',''), coalesce(p_data->>'url',''),
          (select coalesce(max(sort_order),0)+1 from items where category = cat), p_actor, p_actor)
  returning id into new_id;
  perform _log_change(new_id, s.id, nm, p_actor, 'create', '', '', coalesce(p_data->>'price_text',''));
  if p_actor = 'supplier' then update suppliers set last_updated_at = now() where id = s.id; end if;
  return new_id;
end $$;

create or replace function _update_item(p_id bigint, p_data jsonb, p_actor text) returns void language plpgsql as $$
declare cur items; f text; nv text; ov text; changed boolean := false; st text;
begin
  select * into cur from items where id = p_id;
  if cur.id is null then raise exception 'not found' using errcode = 'PT404'; end if;
  foreach f in array array['team','category','subcategory','name','model','spec','weight','weight_limit','price_text','sales','tel','remarks','url'] loop
    if p_data ? f then
      nv := trim(coalesce(p_data->>f, ''));
      ov := coalesce(to_jsonb(cur)->>f, '');
      if nv <> ov then
        if f in ('name','category') and nv = '' then raise exception '類別及項目名稱為必填'; end if;
        if f = 'category' then perform _ensure_category(nv, coalesce(p_data->>'team', cur.team)); end if;
        execute format('update items set %I = $1 where id = $2', f) using nv, p_id;
        if f = 'price_text' then update items set price = _parse_price(nv), price_updated_at = now() where id = p_id; end if;
        perform _log_change(p_id, cur.supplier_id, cur.name, p_actor, 'update', f, ov, nv);
        changed := true;
      end if;
    end if;
  end loop;
  st := p_data->>'status';
  if st is not null and st <> cur.status then
    if st not in ('active','discontinued') then raise exception 'invalid status'; end if;
    update items set status = st, discontinued_at = case when st = 'discontinued' then now() else null end where id = p_id;
    perform _log_change(p_id, cur.supplier_id, cur.name, p_actor, case when st = 'discontinued' then 'discontinue' else 'restore' end, 'status', cur.status, st);
    changed := true;
  end if;
  if changed then
    update items set updated_at = now(), updated_by = p_actor, confirmed_at = now() where id = p_id;
    if p_actor = 'supplier' then update suppliers set last_updated_at = now() where id = cur.supplier_id; end if;
  end if;
end $$;

-- ---------- public API: meta ----------
create or replace function api_meta() returns jsonb language sql security definer set search_path = public as $$
  select _meta_json() || jsonb_build_object('categories', _categories_json(), 'subcategories', _subcategories_json());
$$;

-- ---------- public API: admin ----------
create or replace function admin_login(p_password text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text; t text;
begin
  select value into h from settings where key = 'admin_password';
  if h is null or extensions.crypt(coalesce(p_password,''), h) <> h then
    raise exception '密碼錯誤 (Wrong password)' using errcode = 'PT401';
  end if;
  t := _new_token() || _new_token();
  insert into admin_sessions(token, expires_at) values (t, now() + interval '12 hours');
  return jsonb_build_object('token', t);
end $$;

create or replace function admin_logout(p_token text) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from admin_sessions where token = p_token;
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_change_password(p_token text, p_current text, p_next text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  perform _require_admin(p_token);
  select value into h from settings where key = 'admin_password';
  if extensions.crypt(coalesce(p_current,''), h) <> h then raise exception '現有密碼錯誤'; end if;
  if length(coalesce(p_next,'')) < 6 then raise exception '新密碼至少 6 個字元'; end if;
  update settings set value = extensions.crypt(p_next, extensions.gen_salt('bf')) where key = 'admin_password';
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_overview(p_token text) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  return jsonb_build_object(
    'meta', _meta_json(), 'categories', _categories_json(), 'subcategories', _subcategories_json(),
    'suppliers', _suppliers_json(true), 'items', _items_json(null), 'changes', _changes_json(null, 300));
end $$;

create or replace function admin_save_settings(p_token text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  if nullif(p_data->>'stale_months','') is not null then
    insert into settings(key, value) values ('stale_months', greatest(1, (p_data->>'stale_months')::int)::text)
    on conflict (key) do update set value = excluded.value;
  end if;
  if nullif(trim(p_data->>'list_title'),'') is not null then
    insert into settings(key, value) values ('list_title', trim(p_data->>'list_title'))
    on conflict (key) do update set value = excluded.value;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_create_supplier(p_token text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare new_id bigint;
begin
  perform _require_admin(p_token);
  if trim(coalesce(p_data->>'name','')) = '' then raise exception '請輸入公司名稱'; end if;
  insert into suppliers(name, token, contact_name, tel, email, website, notes)
  values (trim(p_data->>'name'), _new_token(), coalesce(p_data->>'contact_name',''), coalesce(p_data->>'tel',''),
          coalesce(p_data->>'email',''), coalesce(p_data->>'website',''), coalesce(p_data->>'notes',''))
  returning id into new_id;
  return jsonb_build_object('id', new_id);
end $$;

create or replace function admin_update_supplier(p_token text, p_id bigint, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  perform _update_supplier(p_id, p_data, 'admin');
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_regenerate_token(p_token text, p_id bigint) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_admin(p_token);
  update suppliers set token = _new_token() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_confirm_supplier(p_token text, p_id bigint) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  perform _confirm_supplier(p_id, 'admin');
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_delete_supplier(p_token text, p_id bigint) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  delete from suppliers where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_create_item(p_token text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  perform _require_admin(p_token);
  if nullif(p_data->>'supplier_id','') is null then raise exception '請選擇供應商'; end if;
  new_id := _create_item((p_data->>'supplier_id')::bigint, p_data, 'admin');
  return jsonb_build_object('id', new_id);
end $$;

create or replace function admin_update_item(p_token text, p_id bigint, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  perform _update_item(p_id, p_data, 'admin');
  return jsonb_build_object('ok', true);
end $$;

create or replace function admin_delete_item(p_token text, p_id bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare cur items;
begin
  perform _require_admin(p_token);
  select * into cur from items where id = p_id;
  if cur.id is not null then
    perform _log_change(p_id, cur.supplier_id, cur.name, 'admin', 'delete', '', cur.price_text, '');
    delete from items where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- public API: supplier portal ----------
create or replace function supplier_get(p_stoken text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s suppliers;
begin
  s := _supplier_by_token(p_stoken);
  return jsonb_build_object(
    'supplier', to_jsonb(s) - 'token',
    'items', _items_json(s.id),
    'categories', _categories_json(), 'subcategories', _subcategories_json(),
    'changes', _changes_json(s.id, 50), 'meta', _meta_json());
end $$;

create or replace function supplier_update_profile(p_stoken text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s suppliers;
begin
  s := _supplier_by_token(p_stoken);
  perform _update_supplier(s.id, p_data, 'supplier');
  return jsonb_build_object('ok', true);
end $$;

create or replace function supplier_confirm(p_stoken text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s suppliers;
begin
  s := _supplier_by_token(p_stoken);
  perform _confirm_supplier(s.id, 'supplier');
  return jsonb_build_object('ok', true);
end $$;

create or replace function supplier_create_item(p_stoken text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s suppliers; new_id bigint;
begin
  s := _supplier_by_token(p_stoken);
  new_id := _create_item(s.id, p_data - 'supplier_id' - 'status', 'supplier');
  return jsonb_build_object('id', new_id);
end $$;

create or replace function supplier_update_item(p_stoken text, p_id bigint, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s suppliers;
begin
  s := _supplier_by_token(p_stoken);
  if not exists (select 1 from items where id = p_id and supplier_id = s.id) then raise exception 'not found' using errcode = 'PT404'; end if;
  perform _update_item(p_id, p_data, 'supplier');
  return jsonb_build_object('ok', true);
end $$;

-- ---------- permissions ----------
-- Internal helpers: not callable by API roles
revoke all on function _new_token(), _parse_price(text), _log_change(bigint,bigint,text,text,text,text,text,text),
  _require_admin(text), _supplier_by_token(text), _ensure_category(text,text), _items_json(bigint), _suppliers_json(boolean),
  _categories_json(), _subcategories_json(), _changes_json(bigint,int), _meta_json(), _update_supplier(bigint,jsonb,text),
  _confirm_supplier(bigint,text), _create_item(bigint,jsonb,text), _update_item(bigint,jsonb,text) from public, anon, authenticated;

-- Public API functions: callable with the anon key
grant execute on function api_meta(), admin_login(text), admin_logout(text), admin_change_password(text,text,text),
  admin_overview(text), admin_save_settings(text,jsonb), admin_create_supplier(text,jsonb), admin_update_supplier(text,bigint,jsonb),
  admin_regenerate_token(text,bigint), admin_confirm_supplier(text,bigint), admin_delete_supplier(text,bigint),
  admin_create_item(text,jsonb), admin_update_item(text,bigint,jsonb), admin_delete_item(text,bigint),
  supplier_get(text), supplier_update_profile(text,jsonb), supplier_confirm(text), supplier_create_item(text,jsonb),
  supplier_update_item(text,bigint,jsonb) to anon, authenticated;

-- Default settings (password set in seed script)
insert into settings(key, value) values ('stale_months', '6') on conflict do nothing;
