-- 003: department-only fields (product web link + public web price for comparison),
--      editable import_date ("最後更新日期"), supplier portal never sees internal fields.

alter table items add column if not exists web_price text not null default '';

create or replace function _create_item(p_supplier_id bigint, p_data jsonb, p_actor text) returns bigint language plpgsql as $$
declare s suppliers; cat text; team text; new_id bigint; nm text; is_admin boolean := (p_actor = 'admin');
begin
  select * into s from suppliers where id = p_supplier_id;
  if s.id is null then raise exception 'supplier not found' using errcode = 'PT404'; end if;
  cat := trim(coalesce(p_data->>'category',''));
  nm := trim(coalesce(p_data->>'name',''));
  if cat = '' or nm = '' then raise exception '類別及項目名稱為必填'; end if;
  perform _ensure_category(cat, p_data->>'team');
  select coalesce(nullif(p_data->>'team',''), c.team, '') into team from categories c where c.name = cat;
  insert into items(supplier_id, team, category, subcategory, name, model, spec, weight, weight_limit, price_text, price,
                    sales, tel, remarks, url, web_price, sort_order, created_by, updated_by)
  values (s.id, team, cat, trim(coalesce(p_data->>'subcategory','')), nm,
          coalesce(p_data->>'model',''), coalesce(p_data->>'spec',''), coalesce(p_data->>'weight',''), coalesce(p_data->>'weight_limit',''),
          coalesce(p_data->>'price_text',''), _parse_price(p_data->>'price_text'),
          coalesce(nullif(p_data->>'sales',''), s.contact_name, ''), coalesce(nullif(p_data->>'tel',''), s.tel, ''),
          coalesce(p_data->>'remarks',''),
          case when is_admin then coalesce(p_data->>'url','') else '' end,
          case when is_admin then coalesce(p_data->>'web_price','') else '' end,
          (select coalesce(max(sort_order),0)+1 from items where category = cat), p_actor, p_actor)
  returning id into new_id;
  perform _log_change(new_id, s.id, nm, p_actor, 'create', '', '', coalesce(p_data->>'price_text',''));
  if p_actor = 'supplier' then update suppliers set last_updated_at = now() where id = s.id; end if;
  return new_id;
end $$;

create or replace function _update_item(p_id bigint, p_data jsonb, p_actor text) returns void language plpgsql as $$
declare cur items; f text; nv text; ov text; changed boolean := false; st text; fields text[];
begin
  select * into cur from items where id = p_id;
  if cur.id is null then raise exception 'not found' using errcode = 'PT404'; end if;
  fields := array['team','category','subcategory','name','model','spec','weight','weight_limit','price_text','sales','tel','remarks'];
  if p_actor = 'admin' then fields := fields || array['url','web_price']; end if;
  foreach f in array fields loop
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

-- Supplier portal: strip department-only fields
create or replace function supplier_get(p_stoken text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s suppliers;
begin
  s := _supplier_by_token(p_stoken);
  return jsonb_build_object(
    'supplier', to_jsonb(s) - 'token' - 'notes',
    'items', coalesce((select jsonb_agg(e - 'url' - 'web_price') from jsonb_array_elements(_items_json(s.id)) e), '[]'::jsonb),
    'categories', _categories_json(), 'subcategories', _subcategories_json(),
    'changes', _changes_json(s.id, 50), 'meta', _meta_json());
end $$;

-- Settings: allow department to set the "last manual update" date
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
  if nullif(trim(p_data->>'import_date'),'') is not null then
    insert into settings(key, value) values ('import_date', ((p_data->>'import_date')::timestamptz)::text)
    on conflict (key) do update set value = excluded.value;
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function _create_item(bigint, jsonb, text) from public, anon, authenticated;
revoke all on function _update_item(bigint, jsonb, text) from public, anon, authenticated;
