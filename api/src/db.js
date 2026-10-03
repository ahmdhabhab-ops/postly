import pg from 'pg';

export const SCHEMA = `
create table if not exists users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  first_name text not null default '',
  last_name text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);
create table if not exists businesses (
  user_id uuid primary key references users(id) on delete cascade,
  name text not null default '',
  type text not null default '',
  industry text not null default '',
  website text not null default '',
  location text not null default '',
  description text not null default '',
  goal text not null default '',
  customer_age text not null default '',
  customer_type text not null default '',
  customer_location text not null default '',
  interests text not null default '',
  budget text not null default '',
  onboarded boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table businesses add column if not exists country text not null default '';
alter table businesses add column if not exists usp text not null default '';
alter table businesses add column if not exists price_range text not null default '';
alter table businesses add column if not exists site_text text not null default '';
alter table businesses add column if not exists last_discovery_at timestamptz;
alter table businesses add column if not exists site_fetched_at timestamptz;
alter table businesses add column if not exists site_signals text not null default '';
alter table businesses add column if not exists icp text not null default '';
alter table businesses add column if not exists icp_ai boolean not null default false;
alter table businesses add column if not exists last_prospect_at timestamptz;
alter table businesses add column if not exists lead_target text not null default '';
alter table businesses add column if not exists channel_advice text not null default '';
alter table businesses add column if not exists channel_advice_ai boolean not null default false;
alter table businesses add column if not exists channel_advice_at timestamptz;
create table if not exists campaigns (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  platform text not null,
  status text not null default 'pending',
  budget_per_day integer not null default 20,
  duration_days integer not null default 7,
  audience text not null default 'Local, 25-44',
  expected_leads integer not null default 0,
  created_at timestamptz not null default now(),
  launched_at timestamptz
);
create index if not exists campaigns_user_idx on campaigns(user_id, created_at desc);
alter table campaigns add column if not exists brief text not null default '';
create table if not exists chat_messages (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_user_idx on chat_messages(user_id, id);
create table if not exists channels (
  user_id uuid not null references users(id) on delete cascade,
  platform text not null,
  account_label text not null default '',
  connected_at timestamptz not null default now(),
  primary key (user_id, platform)
);
create table if not exists activity (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists activity_user_idx on activity(user_id, id desc);
create table if not exists competitors (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  url text not null,
  analysis text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table competitors add column if not exists reason text not null default '';
alter table competitors add column if not exists source text not null default 'manual';
alter table competitors add column if not exists market text not null default '';
create index if not exists competitors_user_idx on competitors(user_id, created_at);
create table if not exists reports (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  content text not null,
  ai boolean not null default false,
  stats text not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists reports_user_idx on reports(user_id, id desc);
create table if not exists leads (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  name text not null,
  url text not null,
  domain text not null default '',
  market text not null default '',
  why text not null default '',
  evidence text not null default '',
  signals text not null default '{}',
  score integer not null default 0,
  intent text not null default 'low',
  verified boolean not null default false,
  message text not null default '',
  channel text not null default '',
  status text not null default 'new',
  notes text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists leads_user_url_idx on leads(user_id, url);
create index if not exists leads_user_idx on leads(user_id, score desc);
create table if not exists images (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  prompt text not null,
  aspect text not null default '1:1',
  mime text not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists images_user_idx on images(user_id, created_at desc);
create index if not exists images_campaign_idx on images(campaign_id);
create table if not exists whatsapp_log (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  message_id text,
  created_at timestamptz not null default now()
);
`;

export function createPool(url) {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

export async function migrate(pool, { retries = 30, delayMs = 2000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (e) {
      if (i >= retries) throw e;
      console.log(`waiting for database (${e.code || e.message})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
