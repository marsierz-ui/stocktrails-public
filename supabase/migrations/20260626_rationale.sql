-- Optional free-text rationale the user can attach to a labelled stock
-- (captured in the popup + in-page widget, gated on a sentiment label).
alter table public.events add column if not exists rationale text;
alter table public.intraday add column if not exists rationale text;
