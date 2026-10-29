\set ON_ERROR_STOP on
-- This file intentionally uses deterministic, clearly synthetic test identities.

-- Auth user creation trigger provisions a default ZUNO profile and least-privilege role.
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
('20000000-0000-4000-8000-000000000003','zuno_trigger_test@example.invalid','{"username":"trigger_test","display_name":"Trigger Test"}'::jsonb)
ON CONFLICT(id) DO NOTHING;
DO $auth_trigger_check$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE auth_user_id='20000000-0000-4000-8000-000000000003' AND username='trigger_test') THEN RAISE EXCEPTION 'auth trigger did not provision profile'; END IF;
 IF NOT EXISTS(SELECT 1 FROM roles r JOIN profiles p ON p.id=r.profile_id WHERE p.auth_user_id='20000000-0000-4000-8000-000000000003' AND r.role='user') THEN RAISE EXCEPTION 'auth trigger did not assign default user role'; END IF;
END
$auth_trigger_check$;

INSERT INTO profiles (id, auth_user_id, username, display_name, visibility) VALUES
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','zuno_test_owner','Test owner','private'),
('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','zuno_test_viewer','Test viewer','private')
ON CONFLICT (id) DO NOTHING;

INSERT INTO posts (id,author_id,kind,caption,audience) VALUES
('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','text','private test content','private'),
('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','text','public but blocked test content','public')
ON CONFLICT(id) DO NOTHING;

INSERT INTO blocks(blocker_id,blocked_id)
VALUES('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO conversations(id,is_group) VALUES('40000000-0000-4000-8000-000000000001',false) ON CONFLICT(id) DO NOTHING;
INSERT INTO conversation_members(conversation_id,profile_id) VALUES
('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;
INSERT INTO messages(id,conversation_id,sender_id,body) VALUES
('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','private test message')
ON CONFLICT(id) DO NOTHING;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false);
DO $viewer_checks$
BEGIN
  IF EXISTS(SELECT 1 FROM posts WHERE id='30000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RLS failed: viewer read another account private post';
  END IF;
  IF EXISTS(SELECT 1 FROM posts WHERE id='30000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'RLS failed: blocked viewer read blocked creator content';
  END IF;
  IF EXISTS(SELECT 1 FROM profiles WHERE id='10000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RLS failed: viewer read private profile';
  END IF;
  IF EXISTS(SELECT 1 FROM messages WHERE id='50000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RLS failed: non-member read private conversation message';
  END IF;
  IF has_table_privilege(current_user,'public.wallet_accounts','SELECT') THEN
    RAISE EXCEPTION 'RLS failed: authenticated role has direct SELECT privilege on protected wallet accounts';
  END IF;
END
$viewer_checks$;

SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false);
DO $owner_checks$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM posts WHERE id='30000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RLS failed: owner cannot read own private post';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id='10000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RLS failed: owner cannot read own private profile';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM messages WHERE id='50000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'RLS failed: conversation member cannot read own message';
  END IF;
END
$owner_checks$;
RESET ROLE;

-- Money-moving integration smoke tests use synthetic CI fixtures and PostgreSQL transactions only.
DO $economy_checks$
DECLARE
  v_sender uuid := '10000000-0000-4000-8000-000000000001';
  v_receiver uuid := '10000000-0000-4000-8000-000000000002';
  v_sender_account uuid;
  v_receiver_account uuid;
  v_mint_account uuid;
  v_funding_entry uuid;
  v_delivery_one uuid;
  v_delivery_two uuid;
  v_credit_one uuid;
  v_credit_replay uuid;
  v_credit_two uuid;
  v_refund_one uuid;
  v_refund_two uuid;
  v_balance bigint;
  v_balance_before bigint;
  v_gifter_total bigint;
  v_order_state text;
BEGIN
  INSERT INTO gift_definitions(id,name,category,tier,price_coins,unlock_rule,model_path,audio_status,asset_version,license)
  VALUES('zuno_ci_atomic_gift','CI Atomic Gift','ci',1,5,'none','ci/geometry.json','not_required','ci-1','CI synthetic fixture only')
  ON CONFLICT(id) DO UPDATE SET price_coins=excluded.price_coins,unlock_rule='none';

  INSERT INTO wallet_accounts(profile_id,kind) VALUES(v_sender,'user'),(v_receiver,'user')
  ON CONFLICT(profile_id) DO NOTHING;
  SELECT id INTO v_sender_account FROM wallet_accounts WHERE profile_id=v_sender AND kind='user';
  SELECT id INTO v_receiver_account FROM wallet_accounts WHERE profile_id=v_receiver AND kind='user';
  SELECT id INTO v_mint_account FROM wallet_accounts WHERE kind='mint' ORDER BY id LIMIT 1;
  IF v_sender_account IS NULL OR v_receiver_account IS NULL OR v_mint_account IS NULL THEN
    RAISE EXCEPTION 'CI fixture wallet accounts were not provisioned';
  END IF;

  INSERT INTO ledger_entries(idempotency_key,unit,type)
  VALUES('zuno-ci-funding-entry-00000001','coins','ci_fixture_funding')
  ON CONFLICT(idempotency_key) DO NOTHING;
  SELECT id INTO v_funding_entry FROM ledger_entries WHERE idempotency_key='zuno-ci-funding-entry-00000001';
  IF NOT EXISTS(SELECT 1 FROM ledger_postings WHERE entry_id=v_funding_entry) THEN
    INSERT INTO ledger_postings(entry_id,account_id,delta,unit)
    VALUES(v_funding_entry,v_mint_account,-20,'coins'),(v_funding_entry,v_sender_account,20,'coins');
  END IF;

  SELECT public.deliver_gift(v_sender,v_receiver,'zuno_ci_atomic_gift',NULL,'CI smoke test','zuno-ci-gift-idempotency-key-0001')
    INTO v_delivery_one;
  SELECT public.deliver_gift(v_sender,v_receiver,'zuno_ci_atomic_gift',NULL,'CI smoke test','zuno-ci-gift-idempotency-key-0001')
    INTO v_delivery_two;
  IF v_delivery_one IS DISTINCT FROM v_delivery_two THEN
    RAISE EXCEPTION 'Gift idempotent retry returned different delivery IDs';
  END IF;
  SELECT coalesce(sum(delta),0)::bigint INTO v_balance FROM ledger_postings
    WHERE account_id=v_sender_account AND unit='coins';
  IF v_balance<>15 THEN RAISE EXCEPTION 'Gift retry double-debited or failed: sender balance %',v_balance; END IF;
  IF (SELECT count(*) FROM gift_deliveries WHERE idempotency_key='zuno-ci-gift-idempotency-key-0001')<>1 THEN
    RAISE EXCEPTION 'Gift retry created more than one delivery';
  END IF;
  SELECT eligible_lifetime_coins INTO v_gifter_total FROM gifter_progress WHERE profile_id=v_sender;
  IF v_gifter_total<>5 THEN RAISE EXCEPTION 'Gifter progression did not record exactly 5 eligible coins: %',v_gifter_total; END IF;

  SELECT coalesce(sum(delta),0)::bigint INTO v_balance_before FROM ledger_postings
    WHERE account_id=v_receiver_account AND unit='coins';
  INSERT INTO payment_orders(profile_id,package_id,custom_coins,amount_usd,currency,provider,idempotency_key,state,provider_order_id)
  VALUES(v_receiver,'z_coins_60',NULL,0.99,'USD','paypal','zuno-ci-payment-order-release-0001','created','ZUNO-CI-ORDER-REFUND-RELEASE')
  ON CONFLICT(idempotency_key) DO NOTHING;
  SELECT public.credit_captured_coin_order('ZUNO-CI-ORDER-REFUND-RELEASE','ZUNO-CI-CAPTURE-RELEASE',0.99,'USD')
    INTO v_credit_one;
  SELECT public.credit_captured_coin_order('ZUNO-CI-ORDER-REFUND-RELEASE','ZUNO-CI-CAPTURE-RELEASE',0.99,'USD')
    INTO v_credit_replay;
  IF v_credit_one IS DISTINCT FROM v_credit_replay THEN RAISE EXCEPTION 'Capture retry changed ledger entry ID'; END IF;
  SELECT coalesce(sum(delta),0)::bigint INTO v_balance FROM ledger_postings
    WHERE account_id=v_receiver_account AND unit='coins';
  IF v_balance<>v_balance_before+60 THEN RAISE EXCEPTION 'Capture retry double-credited or failed: expected %, got %',v_balance_before+60,v_balance; END IF;

  SELECT public.reserve_coin_refund(
    (SELECT id FROM payment_orders WHERE provider_order_id='ZUNO-CI-ORDER-REFUND-RELEASE'),
    v_receiver,'zuno-ci-refund-release-idempotency-001','ci_test'
  ) INTO v_refund_one;
  SELECT coalesce(sum(delta),0)::bigint INTO v_balance FROM ledger_postings
    WHERE account_id=v_receiver_account AND unit='coins';
  IF v_balance<>v_balance_before THEN RAISE EXCEPTION 'Refund reservation did not reserve exactly the recharge coin quantity'; END IF;
  IF public.finalize_coin_refund(v_refund_one,NULL,false,'PAYPAL_REFUND_REJECTED')<>'failed' THEN
    RAISE EXCEPTION 'Definitively rejected refund was not finalized as failed';
  END IF;
  SELECT coalesce(sum(delta),0)::bigint INTO v_balance FROM ledger_postings
    WHERE account_id=v_receiver_account AND unit='coins';
  IF v_balance<>v_balance_before+60 THEN RAISE EXCEPTION 'Failed provider refund did not release its coin reservation'; END IF;
  SELECT state INTO v_order_state FROM payment_orders WHERE provider_order_id='ZUNO-CI-ORDER-REFUND-RELEASE';
  IF v_order_state<>'credited' THEN RAISE EXCEPTION 'A rejected refund incorrectly changed captured payment state to %',v_order_state; END IF;

  INSERT INTO payment_orders(profile_id,package_id,custom_coins,amount_usd,currency,provider,idempotency_key,state,provider_order_id)
  VALUES(v_receiver,'z_coins_60',NULL,0.99,'USD','paypal','zuno-ci-payment-order-success-0002','created','ZUNO-CI-ORDER-REFUND-SUCCESS')
  ON CONFLICT(idempotency_key) DO NOTHING;
  SELECT public.credit_captured_coin_order('ZUNO-CI-ORDER-REFUND-SUCCESS','ZUNO-CI-CAPTURE-SUCCESS',0.99,'USD')
    INTO v_credit_two;
  SELECT public.reserve_coin_refund(
    (SELECT id FROM payment_orders WHERE provider_order_id='ZUNO-CI-ORDER-REFUND-SUCCESS'),
    v_receiver,'zuno-ci-refund-success-idempotency-0002','ci_test'
  ) INTO v_refund_two;
  IF public.finalize_coin_refund(v_refund_two,'ZUNO-CI-REFUND-SUCCESS',true,NULL)<>'refunded' THEN
    RAISE EXCEPTION 'Provider-confirmed refund was not finalized as refunded';
  END IF;
  SELECT coalesce(sum(delta),0)::bigint INTO v_balance FROM ledger_postings
    WHERE account_id=v_receiver_account AND unit='coins';
  IF v_balance<>v_balance_before+60 THEN RAISE EXCEPTION 'Completed refund failed to retain the reserved debit'; END IF;
  SELECT state INTO v_order_state FROM payment_orders WHERE provider_order_id='ZUNO-CI-ORDER-REFUND-SUCCESS';
  IF v_order_state<>'refunded' THEN RAISE EXCEPTION 'Completed refund left payment state %',v_order_state; END IF;
END
$economy_checks$;


-- Moderator actions are single-transaction, role-gated and audit logged.
DO $moderation_checks$
DECLARE
  v_moderator uuid := '10000000-0000-4000-8000-000000000001';
  v_report_review uuid := '60000000-0000-4000-8000-000000000001';
  v_report_remove uuid := '60000000-0000-4000-8000-000000000002';
  v_state text;
  v_action uuid;
  v_overview record;
BEGIN
  INSERT INTO roles(profile_id,role) VALUES(v_moderator,'moderator') ON CONFLICT DO NOTHING;
  INSERT INTO reports(id,reporter_id,target_type,target_id,reason,state)
    VALUES(v_report_review,'10000000-0000-4000-8000-000000000002','post','30000000-0000-4000-8000-000000000001','Synthetic review workflow test','open')
    ON CONFLICT(id) DO NOTHING;
  SELECT new_state,moderation_action_id INTO v_state,v_action
    FROM public.resolve_moderation_report(v_report_review,v_moderator,'mark_reviewing','ci_review','Synthetic review note');
  IF v_state<>'reviewing' OR v_action IS NULL THEN
    RAISE EXCEPTION 'Moderator review decision did not return the persisted transition';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM reports WHERE id=v_report_review AND state='reviewing' AND resolution_code='ci_review') THEN
    RAISE EXCEPTION 'Report state or resolution reason was not persisted';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM moderation_actions WHERE id=v_action AND report_id=v_report_review AND moderator_id=v_moderator AND action='mark_reviewing') THEN
    RAISE EXCEPTION 'Moderation action audit row was not persisted';
  END IF;
  SELECT new_state INTO v_state
    FROM public.resolve_moderation_report(v_report_review,v_moderator,'dismiss','ci_dismiss','Synthetic final decision');
  IF v_state<>'dismissed' OR NOT EXISTS(SELECT 1 FROM reports WHERE id=v_report_review AND state='dismissed' AND resolved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Dismiss action did not resolve report';
  END IF;

  INSERT INTO reports(id,reporter_id,target_type,target_id,reason,state)
    VALUES(v_report_remove,'10000000-0000-4000-8000-000000000002','post','30000000-0000-4000-8000-000000000002','Synthetic removal workflow test','open')
    ON CONFLICT(id) DO NOTHING;
  SELECT new_state INTO v_state
    FROM public.resolve_moderation_report(v_report_remove,v_moderator,'remove_content','ci_remove','Synthetic removal action');
  IF v_state<>'actioned' OR NOT EXISTS(SELECT 1 FROM posts WHERE id='30000000-0000-4000-8000-000000000002' AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Post removal decision did not soft-delete target and action report';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_events WHERE actor_id=v_moderator AND action='moderation.report.remove_content' AND detail->>'reportId'=v_report_remove::text) THEN
    RAISE EXCEPTION 'Removal was not written to the append-only audit trail';
  END IF;

  SELECT * INTO v_overview FROM public.get_admin_overview();
  IF v_overview.profile_count<2 OR v_overview.post_count<1 THEN
    RAISE EXCEPTION 'Protected admin overview returned inconsistent fixture counts';
  END IF;
END
$moderation_checks$;

SELECT 'ZUNO PostgreSQL migration + RLS + economy + moderation smoke checks passed' AS verification;
