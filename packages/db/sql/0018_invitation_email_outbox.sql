-- 0018_invitation_email_outbox.sql — persist invitation mail before dispatch.
--
-- Invitation creation writes both the invitation and this outbox row in the
-- same transaction. The API dispatches only after COMMIT, so a rollback can
-- never send mail. Pending rows remain visible if dispatch fails or the
-- process stops between COMMIT and delivery.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

CREATE TABLE app.email_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES app.invitations (id) ON DELETE CASCADE,
  recipient     text NOT NULL CHECK (position('@' IN recipient) > 1),
  accept_url    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  last_error    text
);
CREATE INDEX email_outbox_pending_idx
  ON app.email_outbox (created_at, id) WHERE dispatched_at IS NULL;

ALTER TABLE app.email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY email_outbox_manage ON app.email_outbox
  FOR ALL TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

REVOKE ALL ON app.email_outbox FROM PUBLIC;
GRANT SELECT, INSERT ON app.email_outbox TO evstation_app;
GRANT UPDATE (dispatched_at, last_error) ON app.email_outbox TO evstation_app;

RESET ROLE;
