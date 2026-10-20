-- Optional prediction horizon: how many days the user gives the stock to reach
-- the target price they set alongside a Positive/Negative label. Captured in the
-- popup + in-page widget; the deadline is derived as ts + horizon_days.
-- Drives the dashboard Predictions view (pace, on-time hit rate, calibration).
alter table public.events add column if not exists horizon_days integer;
alter table public.intraday add column if not exists horizon_days integer;
