-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 · Activity logs — what each person did, for the last 30 days
--
-- Two layers, deliberately separate:
--
--   · audit_log (0001) is the compliance record. Hash-chained, append-only,
--     kept under the retention policies. Nothing here touches it.
--   · activity_logs (this) is the working view: who did what, and which
--     client files they opened, readable by the person themselves and by
--     whoever may see everyone's. It keeps 30 days and deletes the rest.
--
-- Nobody deletes an entry by hand — there is no endpoint for it, and the
-- trigger below refuses to remove anything younger than 30 days or to edit
-- anything at all. Only the daily purge, which removes what has aged out,
-- gets past it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE activity_logs (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No foreign key: an entry outlives nothing it points at by more than 30
  -- days, and a SET NULL would be an UPDATE the trigger refuses.
  actor_user_id   UUID,
  actor_name      TEXT,
  actor_role      TEXT,
  -- 'user' for staff; 'integration' for a connected website or the portal.
  actor_kind      TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'integration')),
  action          TEXT NOT NULL,
  -- The module it happened in, derived from the action (domain/activity.ts),
  -- stored so the filter is an index rather than a string match.
  module          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  -- The client file it concerns, when it concerns one — for the link.
  application_id  UUID,
  summary         TEXT NOT NULL,
  ip              INET,
  -- The compliance entry this mirrors. NULL for file views, which are not
  -- audit events.
  audit_id        BIGINT
);

CREATE INDEX activity_logs_org_at_idx ON activity_logs (organization_id, at DESC, id DESC);
CREATE INDEX activity_logs_actor_idx ON activity_logs (organization_id, actor_user_id, at DESC);
CREATE INDEX activity_logs_module_idx ON activity_logs (organization_id, module, at DESC);
-- The 30-minute check on file views.
CREATE INDEX activity_logs_view_idx ON activity_logs (actor_user_id, application_id, at DESC)
  WHERE action = 'customer.opened';

CREATE OR REPLACE FUNCTION activity_logs_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'activity_logs entries cannot be edited.';
  END IF;
  IF OLD.at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'activity_logs entries cannot be deleted by hand; they are removed automatically after 30 days.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_logs_no_update BEFORE UPDATE ON activity_logs
  FOR EACH ROW EXECUTE FUNCTION activity_logs_guard();
CREATE TRIGGER activity_logs_no_early_delete BEFORE DELETE ON activity_logs
  FOR EACH ROW EXECUTE FUNCTION activity_logs_guard();

-- The last 30 days of what is already in the audit log, so the screen is not
-- empty on the day this ships. System and client entries are not staff
-- activity and stay out.
INSERT INTO activity_logs (organization_id, at, actor_user_id, actor_name, actor_role,
                           actor_kind, action, module, entity_type, entity_id,
                           application_id, summary, ip, audit_id)
SELECT a.organization_id, a.at, a.actor_user_id, a.actor_name, a.actor_role,
       a.actor_kind, a.action,
       CASE split_part(a.action, '.', 1)
         WHEN 'auth' THEN 'account'
         WHEN 'user' THEN CASE WHEN a.action IN ('user.profile_updated', 'user.password_changed',
                                                 'user.signature_updated', 'user.activated')
                               THEN 'account' ELSE 'staff' END
         WHEN 'customer' THEN 'customers' WHEN 'application' THEN 'customers'
         WHEN 'assignment' THEN 'pipeline' WHEN 'renewal' THEN 'customers'
         WHEN 'calculator' THEN 'customers'
         WHEN 'pipeline' THEN 'pipeline' WHEN 'stage' THEN 'pipeline'
         WHEN 'document' THEN 'documents'
         WHEN 'required_document' THEN 'required_documents'
         WHEN 'message' THEN 'messages' WHEN 'template' THEN 'messages' WHEN 'consent' THEN 'messages'
         WHEN 'task' THEN 'tasks' WHEN 'note' THEN 'tasks'
         WHEN 'appointment' THEN 'calendar'
         WHEN 'automation' THEN 'automations'
         WHEN 'campaign' THEN 'campaigns'
         WHEN 'scarlett' THEN 'underwriting' WHEN 'underwriting' THEN 'underwriting'
         WHEN 'funding' THEN 'funding' WHEN 'commission' THEN 'funding'
         WHEN 'compliance' THEN 'compliance'
         WHEN 'report' THEN 'reports'
         WHEN 'settings' THEN 'settings' WHEN 'integration' THEN 'settings' WHEN 'api_key' THEN 'settings'
         WHEN 'audit' THEN 'system'
         ELSE 'other'
       END,
       a.entity_type, a.entity_id,
       CASE WHEN a.entity_type = 'application'
                 AND a.entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN a.entity_id::uuid END,
       a.summary, a.ip, a.id
  FROM audit_log a
 WHERE a.at > now() - interval '30 days'
   AND (a.actor_kind = 'integration' OR (a.actor_kind = 'user' AND a.actor_user_id IS NOT NULL));
