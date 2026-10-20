-- Single-flight claims for the trending and earnings captures. Both functions are
-- callable by anyone and their freshness gate reads what a run writes only at its
-- end, so overlapping calls each ran a full scrape (and trending appended one raw
-- archive per run). Each run now first inserts (job, 10-minute slot); a duplicate
-- means another run has the slot and this one skips. Service role only.
create table if not exists public.capture_claims (
  job text not null,
  slot bigint not null,
  claimed_at timestamptz not null default now(),
  primary key (job, slot)
);
alter table public.capture_claims enable row level security; -- no policy: service role only
revoke all on public.capture_claims from anon, authenticated;
