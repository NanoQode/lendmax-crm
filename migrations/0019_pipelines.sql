-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 · Pipelines — more than one, each with its own stages
--
-- Until now there was one implicit pipeline: the organisation's stages. Now a
-- brokerage can run several (Purchases, Renewals, Private lending…), each
-- with its own stages, each fed by one or more application purposes.
--
-- WHAT DOES NOT CHANGE, deliberately: a stage is still identified by its key,
-- keys stay unique across the whole organisation, and every file, automation,
-- campaign, report and stage-history row keeps referring to stages by key.
-- A file's pipeline is DERIVED from its stage — a trigger below keeps
-- `applications.pipeline_id` in step with `stage_key` — so no code path that
-- sets a stage can ever leave the two disagreeing, and moving a file to
-- another pipeline is simply moving it to a stage in that pipeline.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE pipelines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Stable, never shown to clients; stage keys in a new pipeline start with it.
  key             TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  description     TEXT CHECK (description IS NULL OR length(description) <= 500),
  colour          TEXT,
  -- Where a file goes when its purpose is not claimed by any other pipeline.
  is_default      BOOLEAN NOT NULL DEFAULT false,
  position        INTEGER NOT NULL DEFAULT 0,
  -- Inactive: files already in it stay and can be moved out; nothing new enters.
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deleted. Kept so history that passed through it still has a name.
  archived_at     TIMESTAMPTZ,
  archived_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, key),
  -- The default is where unmatched files land; an inactive default would be
  -- a pipeline nothing is allowed to enter receiving everything.
  CHECK (NOT is_default OR active)
);
CREATE UNIQUE INDEX pipelines_one_default ON pipelines (organization_id)
  WHERE is_default AND archived_at IS NULL;
CREATE UNIQUE INDEX pipelines_name_key ON pipelines (organization_id, lower(btrim(name)))
  WHERE archived_at IS NULL;
CREATE TRIGGER pipelines_touch BEFORE UPDATE ON pipelines
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Which pipeline each application purpose feeds. The primary key is the rule:
-- a purpose goes to exactly one pipeline, or — with no row — to the default.
CREATE TABLE pipeline_purposes (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL
                  CHECK (purpose IN ('purchase', 'renew', 'refinance', 'home_equity_line')),
  pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, purpose)
);

ALTER TABLE pipeline_stages
  ADD COLUMN pipeline_id  UUID REFERENCES pipelines(id) ON DELETE CASCADE,
  ADD COLUMN description  TEXT CHECK (description IS NULL OR length(description) <= 500),
  ADD COLUMN created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Deleted. The row stays because stage history and reports name it by key.
  ADD COLUMN archived_at  TIMESTAMPTZ,
  ADD COLUMN archived_by  UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE applications ADD COLUMN pipeline_id UUID REFERENCES pipelines(id);

-- A move between pipelines is recorded as such.
ALTER TABLE stage_transitions
  ADD COLUMN from_pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,
  ADD COLUMN to_pipeline_id   UUID REFERENCES pipelines(id) ON DELETE SET NULL;

-- ── Everything that exists becomes the default pipeline ────────────────────
INSERT INTO pipelines (organization_id, key, name, description, is_default, position)
SELECT id, 'main', 'Mortgage pipeline',
       'Every application unless another pipeline takes its purpose.', true, 1
  FROM organizations;

UPDATE pipeline_stages s SET pipeline_id = p.id
  FROM pipelines p WHERE p.organization_id = s.organization_id AND p.key = 'main';

UPDATE applications a SET pipeline_id = COALESCE(
  (SELECT s.pipeline_id FROM pipeline_stages s
    WHERE s.organization_id = a.organization_id AND s.key = a.stage_key),
  (SELECT p.id FROM pipelines p WHERE p.organization_id = a.organization_id AND p.key = 'main'));

ALTER TABLE pipeline_stages ALTER COLUMN pipeline_id SET NOT NULL;
ALTER TABLE applications ALTER COLUMN pipeline_id SET NOT NULL;

CREATE INDEX pipeline_stages_pipeline_idx ON pipeline_stages (pipeline_id, position)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX pipeline_stages_label_key ON pipeline_stages (pipeline_id, lower(btrim(label)))
  WHERE archived_at IS NULL;
CREATE INDEX applications_pipeline_idx ON applications (organization_id, pipeline_id, stage_key)
  WHERE archived_at IS NULL;

-- ── Keeping the two in step ────────────────────────────────────────────────

/**
 * The organisation's default pipeline, created if it has none. An
 * organisation always has somewhere for a file to go, including one that has
 * just been created and has never opened the pipelines screen.
 */
CREATE FUNCTION default_pipeline_for(org UUID) RETURNS UUID AS $$
DECLARE
  pid UUID;
BEGIN
  SELECT id INTO pid FROM pipelines
   WHERE organization_id = org AND is_default AND archived_at IS NULL;
  IF pid IS NULL THEN
    INSERT INTO pipelines (organization_id, key, name, is_default, position)
    VALUES (org,
            CASE WHEN EXISTS (SELECT 1 FROM pipelines WHERE organization_id = org AND key = 'main')
                 THEN 'main_' || substr(md5(random()::text), 1, 6) ELSE 'main' END,
            CASE WHEN EXISTS (SELECT 1 FROM pipelines WHERE organization_id = org
                                AND lower(name) = 'mortgage pipeline' AND archived_at IS NULL)
                 THEN 'Mortgage pipeline ' || substr(md5(random()::text), 1, 4)
                 ELSE 'Mortgage pipeline' END,
            true, 1)
    RETURNING id INTO pid;
  END IF;
  RETURN pid;
END;
$$ LANGUAGE plpgsql;

-- A stage added without saying which pipeline joins the default one.
CREATE FUNCTION pipeline_stages_fill_pipeline() RETURNS trigger AS $$
BEGIN
  IF NEW.pipeline_id IS NULL THEN
    NEW.pipeline_id := default_pipeline_for(NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pipeline_stages_pipeline BEFORE INSERT ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION pipeline_stages_fill_pipeline();

-- A file's pipeline is its stage's pipeline; with no stage, the default.
CREATE FUNCTION applications_sync_pipeline() RETURNS trigger AS $$
DECLARE
  from_stage UUID;
BEGIN
  IF NEW.stage_key IS NOT NULL THEN
    SELECT pipeline_id INTO from_stage FROM pipeline_stages
     WHERE organization_id = NEW.organization_id AND key = NEW.stage_key;
    IF from_stage IS NOT NULL THEN
      NEW.pipeline_id := from_stage;
    END IF;
  END IF;
  IF NEW.pipeline_id IS NULL THEN
    NEW.pipeline_id := default_pipeline_for(NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER applications_pipeline BEFORE INSERT OR UPDATE OF stage_key, pipeline_id ON applications
  FOR EACH ROW EXECUTE FUNCTION applications_sync_pipeline();
