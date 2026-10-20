-- Users may insert feedback only as new and without the admin-owned columns.
-- admin_note reaches the feedback agent as maintainer guidance (feedback-agent.yml),
-- so a user-written note must not be possible. Clients insert only user_id, text,
-- url, screenshot and created_at (src/cloud.js); mobile never inserts.
-- After applying: select id, admin_note from public.feedback where admin_note is not null;
-- and clear any note an admin did not write.
drop policy if exists feedback_ins on public.feedback;
create policy feedback_ins on public.feedback for insert with check (
  user_id = auth.uid()
  and admin_note is null and category is null and issue_url is null
  and coalesce(status, 'new') = 'new'
);
