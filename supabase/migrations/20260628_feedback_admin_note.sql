-- Admin notes on feedback: free-text guidance the maintainer attaches to an item
-- (also passed to the AI agent on dispatch). Additive/nullable.
alter table public.feedback add column if not exists admin_note text;
