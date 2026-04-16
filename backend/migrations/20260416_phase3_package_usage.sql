-- =============================================
-- PHASE 3: PACKAGE & USAGE
-- Hybrid schema aligned to the solo tracker
-- while preserving the existing UUID-based core.
-- =============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Packages: tracker fields plus compatibility columns.
CREATE TABLE IF NOT EXISTS packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tenant_code TEXT,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    quota_mb BIGINT NOT NULL CHECK (quota_mb >= 0),
    validity_days INT,
    price_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    speed_limit_kbps INT,
    duration_days INT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, code)
);

ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS tenant_code TEXT;
ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS validity_days INT;
ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS price_usd NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE packages p
SET
    tenant_code = COALESCE(p.tenant_code, t.code),
    validity_days = COALESCE(p.validity_days, p.duration_days),
    updated_at = NOW()
FROM tenants t
WHERE t.id = p.tenant_id
  AND (p.tenant_code IS NULL OR p.validity_days IS NULL);

CREATE INDEX IF NOT EXISTS idx_packages_tenant_code
    ON packages(tenant_code);

-- Package assignments: tracker fields plus compatibility with existing UUID users/packages.
CREATE TABLE IF NOT EXISTS package_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    vessel_code TEXT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    remaining_mb BIGINT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'suspended')),
    is_active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE package_assignments
    ADD COLUMN IF NOT EXISTS vessel_code TEXT;
ALTER TABLE package_assignments
    ADD COLUMN IF NOT EXISTS remaining_mb BIGINT;
ALTER TABLE package_assignments
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'package_assignments_user_vessel_key'
    ) THEN
        ALTER TABLE package_assignments
            ADD CONSTRAINT package_assignments_user_vessel_key UNIQUE (user_id, vessel_code);
    END IF;
END $$;

-- User usage: tracker fields plus current UUID relations.
CREATE TABLE IF NOT EXISTS user_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vessel_id UUID NOT NULL REFERENCES vessels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_code TEXT,
    vessel_code TEXT,
    username TEXT,
    session_id TEXT,
    package_assignment_id UUID REFERENCES package_assignments(id) ON DELETE SET NULL,
    upload_mb NUMERIC(14,3) NOT NULL DEFAULT 0,
    download_mb NUMERIC(14,3) NOT NULL DEFAULT 0,
    total_mb NUMERIC(14,3) GENERATED ALWAYS AS (upload_mb + download_mb) STORED,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_usage
    ADD COLUMN IF NOT EXISTS tenant_code TEXT;
ALTER TABLE user_usage
    ADD COLUMN IF NOT EXISTS vessel_code TEXT;
ALTER TABLE user_usage
    ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE user_usage
    ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE user_usage
    ADD COLUMN IF NOT EXISTS package_assignment_id UUID REFERENCES package_assignments(id) ON DELETE SET NULL;

UPDATE user_usage uu
SET
    tenant_code = COALESCE(uu.tenant_code, t.code),
    vessel_code = COALESCE(uu.vessel_code, v.code),
    username = COALESCE(uu.username, u.username)
FROM tenants t
JOIN vessels v ON v.tenant_id = t.id
JOIN users u ON u.tenant_id = t.id
WHERE uu.tenant_id = t.id
  AND uu.vessel_id = v.id
  AND uu.user_id = u.id;

CREATE INDEX IF NOT EXISTS idx_user_usage_username_time
    ON user_usage(username, observed_at);
CREATE INDEX IF NOT EXISTS idx_user_usage_vessel_code_time
    ON user_usage(vessel_code, observed_at);

-- Alerts: new tracker table.
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_code TEXT,
    vessel_code TEXT,
    username TEXT,
    alert_type TEXT CHECK (alert_type IN ('quota_80', 'quota_90', 'quota_exhausted')),
    message TEXT,
    remaining_mb BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_username
    ON alerts(username, created_at DESC);

-- Package audit trail for CRUD, assign, and unassign actions.
CREATE TABLE IF NOT EXISTS package_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_code TEXT,
    package_id UUID REFERENCES packages(id) ON DELETE SET NULL,
    package_code TEXT,
    vessel_code TEXT,
    username TEXT,
    action_type TEXT NOT NULL,
    actor_user_id UUID,
    actor_username TEXT,
    actor_role TEXT,
    before_payload JSONB,
    after_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_package_audit_events_created_at
    ON package_audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_package_audit_events_scope
    ON package_audit_events(tenant_code, package_code, vessel_code, username, created_at DESC);
