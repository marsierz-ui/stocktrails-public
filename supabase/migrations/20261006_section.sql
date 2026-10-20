-- Research-path tracking: the page section the URL names at capture time
-- (portals.js sectionAfter): "forecast", "financials/balance-sheet", "chart",
-- "overview" for a quote landing page. Finer than research_type, which folds
-- key-statistics, history, metrics, ... all into "overview". Additive and
-- nullable; rows captured before this migration stay null.
--
-- Apply BEFORE the client that sends `section` is loaded: an upsert carrying an
-- unknown column is rejected, which stops sync.

alter table public.events add column if not exists section text;
alter table public.intraday add column if not exists section text;
