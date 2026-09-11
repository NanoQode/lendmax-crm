-- ===========================================================================
-- 0014 — Who a new file belongs to.
--
-- An application arriving from the portal had nobody assigned, which meant
-- nobody was notified when the client uploaded a document, nobody's priority
-- list showed it, and no staleness rule watched it. A file with no owner is a
-- file nobody is watching, and the portal pushes them at 2am.
--
-- The rule is configuration rather than code because brokerages differ: some
-- have one person triaging, some rotate, some route by province. `round_robin`
-- needs its position kept somewhere, which is the only reason this is a table
-- and not another settings key.
-- ===========================================================================

CREATE TABLE assignment_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL
                  CHECK (role IN ('broker','underwriter','manager','compliance')),
  -- unassigned  leave it, and let the unassigned-files alert catch it
  -- fixed       always this person
  -- round_robin rotate through `candidates`
  -- team        the manager of the team the file lands on
  mode            TEXT NOT NULL DEFAULT 'unassigned'
                  CHECK (mode IN ('unassigned','fixed','round_robin','team')),
  fixed_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  candidates      UUID[] NOT NULL DEFAULT '{}',
  -- Where the rotation is up to. A column rather than "count the assignments
  -- and pick the smallest": that is a different rule (load balancing), it is
  -- far more expensive, and it silently stops rotating once somebody is on
  -- holiday.
  rotation_index  INTEGER NOT NULL DEFAULT 0,
  -- Only apply to files matching this, so a brokerage can route by province or
  -- transaction type without a second mechanism.
  applies_when    JSONB NOT NULL DEFAULT '{}'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assignment_rules_idx ON assignment_rules (organization_id, role, position)
  WHERE active;
CREATE TRIGGER assignment_rules_touch BEFORE UPDATE ON assignment_rules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
