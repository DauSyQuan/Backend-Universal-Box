const { Pool } = require('pg');
require('dotenv').config({ path: './ops/.env' });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://mcu_app:mcu_app_ChangeMe_2026@localhost:5432/mcu_backend'
});

async function seedPhase3() {
    console.log("🌱 Seeding Phase 3 - Package & Usage...");

    const tenantResult = await pool.query(
        `INSERT INTO tenants (code, name)
         VALUES ('tnr13', 'Tenant 13')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, code`
    );
    const tenant = tenantResult.rows[0];

    // Phase 3 tracker schema: package catalog + usage foundations.
    await pool.query(`
        INSERT INTO packages (
          tenant_id,
          tenant_code,
          code,
          name,
          description,
          quota_mb,
          validity_days,
          price_usd,
          is_active,
          speed_limit_kbps,
          duration_days
        )
        VALUES 
        ($1, $2, 'basic-50gb', 'Basic 50GB', 'Starter package for pilot users', 51200, 30, 0, true, 5120, 30),
        ($1, $2, 'standard-100gb', 'Standard 100GB', 'Default package for regular use', 102400, 30, 0, true, 10240, 30),
        ($1, $2, 'premium-200gb', 'Premium 200GB', 'High tier package for heavy usage', 204800, 30, 0, true, 20480, 30)
        ON CONFLICT (tenant_id, code) DO UPDATE
        SET tenant_code = EXCLUDED.tenant_code,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            quota_mb = EXCLUDED.quota_mb,
            validity_days = EXCLUDED.validity_days,
            price_usd = EXCLUDED.price_usd,
            is_active = EXCLUDED.is_active,
            speed_limit_kbps = EXCLUDED.speed_limit_kbps,
            duration_days = EXCLUDED.duration_days,
            updated_at = NOW()
    `, [tenant.id, tenant.code]);

    console.log("✅ Đã seed 3 Packages");
    console.log("🎉 Seed Phase 3 hoàn tất!");
}

seedPhase3().then(() => process.exit(0)).catch(console.error);
