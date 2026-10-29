-- ZUNO marketplace, ads, appeals, privacy requests and search/recommendation feedback.
create table if not exists marketplace_listings (
 id uuid primary key default gen_random_uuid(),
 seller_id uuid not null references profiles(id) on delete restrict,
 title text not null check(length(trim(title)) between 2 and 160),
 description text,
 category text not null,
 currency char(3) not null default 'USD',
 price_minor bigint not null check(price_minor>0),
 status text not null default 'draft' check(status in ('draft','active','paused','sold_out','removed')),
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists marketplace_listings_active_idx on marketplace_listings(category,created_at desc) where status='active';
create table if not exists listing_inventory (
 listing_id uuid primary key references marketplace_listings(id) on delete cascade,
 quantity_available integer not null check(quantity_available>=0),
 quantity_reserved integer not null default 0 check(quantity_reserved>=0),
 updated_at timestamptz not null default now(),
 check(quantity_reserved<=quantity_available)
);
create table if not exists commerce_orders (
 id uuid primary key default gen_random_uuid(),
 buyer_id uuid not null references profiles(id) on delete restrict,
 currency char(3) not null default 'USD',
 subtotal_minor bigint not null check(subtotal_minor>=0),
 tax_minor bigint not null default 0 check(tax_minor>=0),
 shipping_minor bigint not null default 0 check(shipping_minor>=0),
 total_minor bigint not null check(total_minor>=0),
 status text not null default 'created' check(status in ('created','pending_payment','paid','processing','fulfilled','cancelled','refunded','partially_refunded')),
 idempotency_key text not null unique,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists commerce_order_items (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references commerce_orders(id) on delete cascade,
 listing_id uuid not null references marketplace_listings(id) on delete restrict,
 seller_id uuid not null references profiles(id) on delete restrict,
 quantity integer not null check(quantity>0),
 unit_price_minor bigint not null check(unit_price_minor>0),
 line_total_minor bigint not null check(line_total_minor=quantity*unit_price_minor),
 created_at timestamptz not null default now()
);
create table if not exists commerce_shipments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references commerce_orders(id) on delete cascade,
 carrier text,
 tracking_reference text,
 state text not null default 'pending' check(state in ('pending','label_created','in_transit','delivered','lost','returned')),
 shipped_at timestamptz,
 delivered_at timestamptz,
 created_at timestamptz not null default now()
);
create table if not exists commerce_refunds (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references commerce_orders(id) on delete restrict,
 requested_by uuid not null references profiles(id) on delete restrict,
 amount_minor bigint not null check(amount_minor>0),
 reason_code text not null,
 state text not null default 'requested' check(state in ('requested','approved','processing','refunded','rejected','failed')),
 provider_refund_id text unique,
 idempotency_key text not null unique,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists ad_campaigns (
 id uuid primary key default gen_random_uuid(),
 advertiser_id uuid not null references profiles(id) on delete restrict,
 name text not null,
 objective text not null check(objective in ('awareness','traffic','engagement','conversions')),
 budget_minor bigint not null check(budget_minor>0),
 currency char(3) not null default 'USD',
 state text not null default 'draft' check(state in ('draft','review','scheduled','active','paused','ended','rejected')),
 starts_at timestamptz,
 ends_at timestamptz,
 targeting jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(ends_at is null or starts_at is null or ends_at>starts_at)
);
create table if not exists ad_creatives (
 id uuid primary key default gen_random_uuid(),
 campaign_id uuid not null references ad_campaigns(id) on delete cascade,
 media_asset_id uuid references media_assets(id) on delete set null,
 headline text not null,
 destination_url text,
 disclosure text not null default 'Sponsored',
 review_state text not null default 'pending' check(review_state in ('pending','approved','rejected')),
 created_at timestamptz not null default now()
);
create table if not exists ad_placements (
 id uuid primary key default gen_random_uuid(),
 placement_key text not null unique,
 description text not null,
 enabled boolean not null default false,
 placement_config jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create table if not exists ad_impressions (
 id uuid primary key default gen_random_uuid(),
 campaign_id uuid not null references ad_campaigns(id) on delete restrict,
 creative_id uuid not null references ad_creatives(id) on delete restrict,
 profile_id uuid references profiles(id) on delete set null,
 placement_key text not null,
 event_key text not null unique,
 occurred_at timestamptz not null default now()
);
create table if not exists ad_clicks (
 id uuid primary key default gen_random_uuid(),
 impression_id uuid not null references ad_impressions(id) on delete cascade,
 event_key text not null unique,
 occurred_at timestamptz not null default now()
);

create table if not exists moderation_appeals (
 id uuid primary key default gen_random_uuid(),
 report_id uuid references reports(id) on delete set null,
 appellant_id uuid not null references profiles(id) on delete cascade,
 target_type text not null,
 target_id text not null,
 reason text not null check(length(trim(reason)) between 1 and 4000),
 state text not null default 'submitted' check(state in ('submitted','reviewing','upheld','reversed','withdrawn')),
 reviewer_id uuid references profiles(id) on delete set null,
 resolution_note text,
 created_at timestamptz not null default now(),
 resolved_at timestamptz
);
create table if not exists privacy_consents (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references profiles(id) on delete cascade,
 purpose text not null,
 status text not null check(status in ('granted','denied','withdrawn')),
 policy_version text not null,
 recorded_at timestamptz not null default now(),
 unique(profile_id,purpose,policy_version)
);
create table if not exists data_requests (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references profiles(id) on delete cascade,
 request_type text not null check(request_type in ('export','deletion','correction','restriction')),
 state text not null default 'submitted' check(state in ('submitted','reviewing','processing','completed','rejected','failed')),
 requested_at timestamptz not null default now(),
 completed_at timestamptz,
 result_storage_path text,
 resolution_code text
);
create table if not exists search_events (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid references profiles(id) on delete set null,
 query_hash text not null,
 result_count integer not null default 0 check(result_count>=0),
 selected_result_type text,
 selected_result_id text,
 created_at timestamptz not null default now()
);
create table if not exists recommendation_feedback (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references profiles(id) on delete cascade,
 item_type text not null,
 item_id text not null,
 feedback text not null check(feedback in ('not_interested','hide','show_more','report')),
 created_at timestamptz not null default now(),
 unique(profile_id,item_type,item_id,feedback)
);

alter table marketplace_listings enable row level security;
alter table listing_inventory enable row level security;
alter table commerce_orders enable row level security;
alter table commerce_order_items enable row level security;
alter table commerce_shipments enable row level security;
alter table commerce_refunds enable row level security;
alter table ad_campaigns enable row level security;
alter table ad_creatives enable row level security;
alter table ad_placements enable row level security;
alter table ad_impressions enable row level security;
alter table ad_clicks enable row level security;
alter table moderation_appeals enable row level security;
alter table privacy_consents enable row level security;
alter table data_requests enable row level security;
alter table search_events enable row level security;
alter table recommendation_feedback enable row level security;

create policy marketplace_listings_read on marketplace_listings for select using(status='active' or seller_id=current_profile_id());
create policy marketplace_listings_insert_draft on marketplace_listings for insert with check(seller_id=current_profile_id() and status='draft');
create policy marketplace_listings_owner_pause on marketplace_listings for update using(seller_id=current_profile_id()) with check(seller_id=current_profile_id() and status in ('draft','paused'));
create policy marketplace_listings_owner_delete_draft on marketplace_listings for delete using(seller_id=current_profile_id() and status='draft');
create policy listing_inventory_public_read on listing_inventory for select using(exists(select 1 from marketplace_listings l where l.id=listing_id and l.status='active'));
create policy commerce_orders_buyer_read on commerce_orders for select using(buyer_id=current_profile_id());
create policy commerce_order_items_party_read on commerce_order_items for select using(seller_id=current_profile_id() or exists(select 1 from commerce_orders o where o.id=order_id and o.buyer_id=current_profile_id()));
create policy commerce_shipments_buyer_read on commerce_shipments for select using(exists(select 1 from commerce_orders o where o.id=order_id and o.buyer_id=current_profile_id()));
create policy commerce_refunds_party_read on commerce_refunds for select using(requested_by=current_profile_id() or exists(select 1 from commerce_orders o where o.id=order_id and o.buyer_id=current_profile_id()));
create policy ad_campaigns_advertiser_read on ad_campaigns for select using(advertiser_id=current_profile_id());
create policy ad_campaigns_advertiser_insert on ad_campaigns for insert with check(advertiser_id=current_profile_id() and state='draft');
create policy ad_campaigns_advertiser_update_draft on ad_campaigns for update using(advertiser_id=current_profile_id() and state in ('draft','paused')) with check(advertiser_id=current_profile_id() and state in ('draft','paused'));
create policy ad_creatives_advertiser_read on ad_creatives for select using(exists(select 1 from ad_campaigns c where c.id=campaign_id and c.advertiser_id=current_profile_id()));
create policy ad_placements_enabled_read on ad_placements for select using(enabled=true);
create policy moderation_appeals_appellant_read on moderation_appeals for select using(appellant_id=current_profile_id() or is_moderator_or_admin());
create policy moderation_appeals_self_insert on moderation_appeals for insert with check(appellant_id=current_profile_id());
create policy privacy_consents_owner_read on privacy_consents for select using(profile_id=current_profile_id());
create policy privacy_consents_owner_insert on privacy_consents for insert with check(profile_id=current_profile_id());
create policy data_requests_owner_read on data_requests for select using(profile_id=current_profile_id());
create policy data_requests_owner_insert on data_requests for insert with check(profile_id=current_profile_id());
create policy recommendation_feedback_owner on recommendation_feedback for all using(profile_id=current_profile_id()) with check(profile_id=current_profile_id());
-- Checkout/order mutations, shipping, ad delivery events, search events and data request processing stay server-managed.
