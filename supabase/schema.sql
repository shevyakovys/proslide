-- Hosted ProSlide storage. Only the Edge Function's service_role can access it.
-- Browser publishable/anon keys grant no direct access to tables or RPCs.
create table public.proslide_users (
 id uuid primary key default gen_random_uuid(), email text unique not null,
 name text not null, password text not null, created timestamptz not null default now()
);
create table public.proslide_auth (
 token_hash text primary key, user_id uuid not null references public.proslide_users(id) on delete cascade,
 expires timestamptz not null
);
create index proslide_auth_user on public.proslide_auth(user_id);
create index proslide_auth_expires on public.proslide_auth(expires);
create table public.proslide_decks (
 id uuid primary key default gen_random_uuid(), owner uuid not null references public.proslide_users(id) on delete cascade,
 data jsonb not null, updated bigint not null
);
create index proslide_decks_owner on public.proslide_decks(owner, updated desc);
create table public.proslide_rooms (
 code text primary key check(code ~ '^[0-9]{6}$'), owner uuid not null references public.proslide_users(id) on delete cascade,
 deck_id uuid not null, snapshot jsonb not null, slide integer not null default 0 check(slide >= 0),
 status text not null default 'live' check(status in ('live','ended')), accepting boolean not null default true,
 show_results boolean not null default true, created bigint not null
);
create index proslide_rooms_owner on public.proslide_rooms(owner, created desc);
create table public.proslide_participants (
 room text not null references public.proslide_rooms(code) on delete cascade, token_hash text not null,
 primary key(room,token_hash)
);
create table public.proslide_answers (
 room text not null, slide_id text not null, participant_hash text not null, value jsonb not null,
 created bigint not null, primary key(room,slide_id,participant_hash),
 foreign key(room,participant_hash) references public.proslide_participants(room,token_hash) on delete cascade
);
create index proslide_answers_participant on public.proslide_answers(room,participant_hash);
create table public.proslide_limits (
 bucket text primary key, hits integer not null, expires timestamptz not null
);
create index proslide_limits_expires on public.proslide_limits(expires);

alter table public.proslide_users enable row level security;
alter table public.proslide_auth enable row level security;
alter table public.proslide_decks enable row level security;
alter table public.proslide_rooms enable row level security;
alter table public.proslide_participants enable row level security;
alter table public.proslide_answers enable row level security;
alter table public.proslide_limits enable row level security;
revoke all on public.proslide_users, public.proslide_auth, public.proslide_decks, public.proslide_rooms,
 public.proslide_participants, public.proslide_answers, public.proslide_limits from public, anon, authenticated;
grant all on public.proslide_users, public.proslide_auth, public.proslide_decks, public.proslide_rooms,
 public.proslide_participants, public.proslide_answers, public.proslide_limits to service_role;

-- Atomic rate limit shared by all Edge isolates. Never exposed to browser roles.
create function public.proslide_rate(p_bucket text,p_limit integer,p_seconds integer) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
 delete from public.proslide_limits where expires < now();
 insert into public.proslide_limits(bucket,hits,expires) values(p_bucket,1,now()+make_interval(secs=>p_seconds))
 on conflict(bucket) do update set hits=public.proslide_limits.hits+1
 returning hits into n;
 return n<=p_limit;
end $$;

-- Lock the room against host updates until the vote commits, preventing a vote
-- from slipping through after pause, slide change or finish. Concurrent votes
-- use shared locks and the primary key guarantees at-most-one answer.
create function public.proslide_vote(p_room text,p_slide text,p_participant text,p_value jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare r public.proslide_rooms;
begin
 select * into r from public.proslide_rooms where code=p_room for share;
 if not found then raise exception 'Сессия не найдена'; end if;
 if r.status <> 'live' or not r.accepting then raise exception 'Приём ответов остановлен'; end if;
 if r.snapshot->'slides'->r.slide->>'id' <> p_slide then raise exception 'Ведущий уже переключил слайд'; end if;
 if not exists(select 1 from public.proslide_participants where room=p_room and token_hash=p_participant) then
   raise exception 'Сначала подключитесь к сессии';
 end if;
 insert into public.proslide_answers values(p_room,p_slide,p_participant,p_value,(extract(epoch from clock_timestamp())*1000)::bigint);
end $$;

create function public.proslide_join(p_room text,p_token text) returns void
language plpgsql security invoker set search_path = '' as $$
declare r public.proslide_rooms;
begin
 select * into r from public.proslide_rooms where code=p_room for share;
 if not found then raise exception 'Сессия не найдена. Проверьте код.'; end if;
 if exists(select 1 from public.proslide_participants where room=p_room and token_hash=p_token) then return; end if;
 if r.status <> 'live' then raise exception 'Эта сессия уже завершена'; end if;
 insert into public.proslide_participants values(p_room,p_token) on conflict do nothing;
end $$;
revoke all on function public.proslide_rate(text,integer,integer), public.proslide_vote(text,text,text,jsonb), public.proslide_join(text,text) from public, anon, authenticated;
grant execute on function public.proslide_rate(text,integer,integer), public.proslide_vote(text,text,text,jsonb), public.proslide_join(text,text) to service_role;
