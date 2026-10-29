\set ON_ERROR_STOP on
-- This file intentionally uses deterministic, clearly synthetic test identities.
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
  IF EXISTS(SELECT 1 FROM wallet_accounts WHERE profile_id='10000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'RLS failed: client read protected wallet account';
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
SELECT 'ZUNO PostgreSQL migration + RLS smoke checks passed' AS verification;
