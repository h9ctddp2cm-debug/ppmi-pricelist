-- Department-only link/price/note changes must also stay out of supplier history.
create or replace function _changes_json(p_supplier_id bigint, p_limit int)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.changed_at desc, t.id desc), '[]'::jsonb)
  from (
    select c.*, s.name as supplier_name from changes c left join suppliers s on s.id = c.supplier_id
    where (p_supplier_id is null or c.supplier_id = p_supplier_id)
      and (p_supplier_id is null or c.field not in ('url', 'web_price', 'notes'))
    order by c.changed_at desc, c.id desc limit p_limit
  ) t;
$$;
revoke all on function _changes_json(bigint,int) from public, anon, authenticated;
