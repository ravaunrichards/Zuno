-- ZUNO economy database functions (migration 0003).
-- The authoritative double-entry gift transaction, executed atomically inside
-- Postgres. Mirrors packages/shared/src/ledger.js invariants:
--   * user accounts cannot go negative,
--   * mint/sink accounts may go negative,
--   * idempotent on idempotency_key.

create or replace function post_gift(
  p_sender_account uuid,
  p_recipient_account uuid,
  p_price bigint,
  p_idempotency_key text
) returns uuid
language plpgsql security definer as $$
declare
  v_entry uuid;
  v_sender_kind text;
  v_sender_balance bigint;
begin
  -- idempotent replay
  select id into v_entry from ledger_entries where idempotency_key = p_idempotency_key;
  if found then return v_entry; end if;

  select kind into v_sender_kind from wallet_accounts where id = p_sender_account for update;
  if v_sender_kind is null then raise exception 'NO_ACCOUNT'; end if;

  select coalesce(sum(delta),0) into v_sender_balance
    from ledger_postings where account_id = p_sender_account and unit = 'coins';

  if v_sender_kind = 'user' and (v_sender_balance - p_price) < 0 then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  insert into ledger_entries(idempotency_key, unit, type) values (p_idempotency_key, 'coins', 'gift')
    returning id into v_entry;
  insert into ledger_postings(entry_id, account_id, delta, unit)
    values (v_entry, p_sender_account, -p_price, 'coins'),
           (v_entry, p_recipient_account, p_price, 'coins');
  return v_entry;
end;
$$;

-- Reload PostgREST schema cache after applying schema changes:
--   notify pgrst, 'reload schema';
