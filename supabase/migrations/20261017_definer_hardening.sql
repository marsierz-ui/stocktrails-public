-- 1. profiles_guard_admin was SECURITY DEFINER, so current_user inside it was the
--    owner (postgres), never anon/authenticated, and its is_admin check could not
--    fire. As invoker, current_user is the role running the UPDATE.
-- 2. is_admin() and handle_new_user() were the only SECURITY DEFINER functions
--    without a pinned search_path.
alter function public.profiles_guard_admin() security invoker;
alter function public.is_admin() set search_path = public;
alter function public.handle_new_user() set search_path = public;
