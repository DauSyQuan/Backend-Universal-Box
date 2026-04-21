import cron from "node-cron";
import { pool } from "./db.js";
import { createLogger } from "../../../shared/logger.js";

const console = createLogger("api:traffic");

let cronStarted = false;
let aggregationRunning = false;

function ensurePool() {
  if (!pool) {
    const error = new Error("database_unavailable");
    error.code = "database_unavailable";
    throw error;
  }
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clampDay(year, monthIndex, day) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(Math.max(1, day), lastDay);
}

function startOfUtcMonth(dateLike) {
  const date = dateLike instanceof Date ? new Date(dateLike) : new Date(String(dateLike));
  if (Number.isNaN(date.getTime())) {
    const error = new Error("invalid_month");
    error.code = "bad_request";
    throw error;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function parseMonthRange(monthText) {
  const month = String(monthText ?? "").trim();
  const normalized = month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    const error = new Error("month must be in YYYY-MM format");
    error.code = "bad_request";
    throw error;
  }

  const [yearText, monthIndexText] = normalized.split("-");
  const year = Number.parseInt(yearText, 10);
  const monthIndex = Number.parseInt(monthIndexText, 10) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    const error = new Error("month must be in YYYY-MM format");
    error.code = "bad_request";
    throw error;
  }

  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  return { month: normalized, start, end };
}

function computeCycleRange(now = new Date(), resetDayOfMonth = 1) {
  const current = new Date(now);
  const safeResetDay = Math.min(Math.max(1, toInt(resetDayOfMonth, 1)), 31);
  const year = current.getUTCFullYear();
  const monthIndex = current.getUTCMonth();
  const currentCycleStartDay = clampDay(year, monthIndex, safeResetDay);
  let start = new Date(Date.UTC(year, monthIndex, currentCycleStartDay, 0, 0, 0, 0));

  if (current < start) {
    const prevMonth = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
    const prevYear = prevMonth.getUTCFullYear();
    const prevMonthIndex = prevMonth.getUTCMonth();
    const prevDay = clampDay(prevYear, prevMonthIndex, safeResetDay);
    start = new Date(Date.UTC(prevYear, prevMonthIndex, prevDay, 0, 0, 0, 0));
  }

  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end, resetDayOfMonth: safeResetDay };
}

function kbpsSumToGb(sumKbps) {
  const value = Number(sumKbps ?? 0);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(((value * 5) / 8 / 1024 / 1024).toFixed(3));
}

async function resolveVesselScope({ tenantCode = null, vesselCode = null } = {}) {
  ensurePool();

  const normalizedVesselCode = String(vesselCode ?? "").trim();
  if (!normalizedVesselCode) {
    const error = new Error("vessel_code is required");
    error.code = "bad_request";
    throw error;
  }

  const normalizedTenantCode = String(tenantCode ?? "").trim() || null;
  const params = [normalizedVesselCode];
  const filters = ["v.code = $1"];

  if (normalizedTenantCode) {
    params.push(normalizedTenantCode);
    filters.push(`t.code = $${params.length}`);
  }

  const result = await pool.query(
    `
      select
        t.id as tenant_id,
        t.code as tenant_code,
        v.id as vessel_id,
        v.code as vessel_code
      from vessels v
      join tenants t on t.id = v.tenant_id
      where ${filters.join(" and ")}
      order by t.code asc, v.code asc
      limit 2
    `,
    params
  );

  if (result.rowCount === 0) {
    return null;
  }

  if (result.rowCount > 1 && !normalizedTenantCode) {
    const error = new Error("tenant_code is required for ambiguous vessel_code");
    error.code = "bad_request";
    throw error;
  }

  return result.rows[0];
}

async function sumTrafficWindow({ vesselId, startAt, endAt }) {
  ensurePool();

  const normalizedStart = new Date(startAt);
  const normalizedEnd = new Date(endAt);
  if (Number.isNaN(normalizedStart.getTime()) || Number.isNaN(normalizedEnd.getTime())) {
    const error = new Error("invalid_traffic_window");
    error.code = "bad_request";
    throw error;
  }

  const currentBucketStart = new Date(normalizedEnd);
  currentBucketStart.setUTCMinutes(0, 0, 0);
  const splitAt = currentBucketStart > normalizedStart ? currentBucketStart : normalizedStart;

  const [hourlyResult, realtimeResult] = await Promise.all([
    pool.query(
      `
        select
          coalesce(sum(rx_gb), 0)::numeric(14,3) as rx_gb,
          coalesce(sum(tx_gb), 0)::numeric(14,3) as tx_gb,
          coalesce(sum(total_gb), 0)::numeric(14,3) as total_gb
        from traffic_hourly
        where vessel_id = $1::uuid
          and hour_bucket >= $2::timestamptz
          and hour_bucket < $3::timestamptz
      `,
      [vesselId, normalizedStart.toISOString(), splitAt.toISOString()]
    ),
    pool.query(
      `
        select
          coalesce(sum(coalesce(rx_kbps, 0)), 0) as rx_kbps,
          coalesce(sum(coalesce(tx_kbps, 0)), 0) as tx_kbps
        from telemetry
        where vessel_id = $1::uuid
          and observed_at >= $2::timestamptz
          and observed_at <= $3::timestamptz
      `,
      [vesselId, splitAt.toISOString(), normalizedEnd.toISOString()]
    )
  ]);

  const hourly = hourlyResult.rows[0] ?? {};
  const realtime = realtimeResult.rows[0] ?? {};
  const rxGb = Number((Number(hourly.rx_gb ?? 0) + kbpsSumToGb(realtime.rx_kbps)).toFixed(3));
  const txGb = Number((Number(hourly.tx_gb ?? 0) + kbpsSumToGb(realtime.tx_kbps)).toFixed(3));
  const totalGb = Number((Number(hourly.total_gb ?? 0) + kbpsSumToGb(Number(realtime.rx_kbps ?? 0) + Number(realtime.tx_kbps ?? 0))).toFixed(3));

  return {
    rx_gb: rxGb,
    tx_gb: txGb,
    total_gb: totalGb
  };
}

export async function aggregateTrafficHourly({ lookbackHours = 48 } = {}) {
  ensurePool();

  const safeLookbackHours = Math.max(1, Math.min(168, toInt(lookbackHours, 48)));
  const result = await pool.query(
    `
      with aggregated as (
        select
          t.vessel_id,
          t.edge_box_id,
          date_trunc('hour', t.observed_at) as hour_bucket,
          round(sum(coalesce(t.rx_kbps, 0)) * 5 / 8 / 1024 / 1024, 3)::numeric(14,3) as rx_gb,
          round(sum(coalesce(t.tx_kbps, 0)) * 5 / 8 / 1024 / 1024, 3)::numeric(14,3) as tx_gb,
          round(sum(coalesce(t.rx_kbps, 0) + coalesce(t.tx_kbps, 0)) * 5 / 8 / 1024 / 1024, 3)::numeric(14,3) as total_gb
        from telemetry t
        where t.edge_box_id is not null
          and t.observed_at >= now() - ($1::int || ' hours')::interval
        group by t.vessel_id, t.edge_box_id, date_trunc('hour', t.observed_at)
      ),
      upserted as (
        insert into traffic_hourly (vessel_id, edge_box_id, hour_bucket, rx_gb, tx_gb, total_gb)
        select vessel_id, edge_box_id, hour_bucket, rx_gb, tx_gb, total_gb
        from aggregated
        on conflict (vessel_id, edge_box_id, hour_bucket)
        do update set
          rx_gb = excluded.rx_gb,
          tx_gb = excluded.tx_gb,
          total_gb = excluded.total_gb
        returning 1
      )
      select count(*)::int as rows_upserted from upserted
    `,
    [safeLookbackHours]
  );

  return {
    rows_upserted: Number(result.rows[0]?.rows_upserted ?? 0)
  };
}

export async function ensureTrafficHourlyCron() {
  ensurePool();

  if (cronStarted) {
    return true;
  }
  cronStarted = true;

  const runAggregation = async () => {
    try {
      const result = await aggregateTrafficHourly({ lookbackHours: 48 });
      console.log(`[traffic] aggregated traffic_hourly rows=${result.rows_upserted}`);
    } catch (error) {
      console.error("[traffic] aggregation failed:", error?.message || error);
    }
  };

  runAggregation().catch((error) => {
    console.error("[traffic] initial aggregation failed:", error?.message || error);
  });

  cron.schedule("0 * * * *", runAggregation, { timezone: "UTC" });
  console.log("[traffic] hourly aggregation cron scheduled at minute 0 UTC");
  return true;
}

export async function syncPackageQuotaForAssignment({
  tenantCode = null,
  vesselCode,
  packageId,
  quotaGb,
  resetDayOfMonth = 1
} = {}) {
  ensurePool();

  const scope = await resolveVesselScope({ tenantCode, vesselCode });
  if (!scope || !packageId) {
    return null;
  }

  const safeQuotaGb = Number(quotaGb);
  if (!Number.isFinite(safeQuotaGb) || safeQuotaGb < 0) {
    return null;
  }

  const safeResetDay = Math.min(Math.max(1, toInt(resetDayOfMonth, 1)), 31);
  const result = await pool.query(
    `
      insert into package_quotas (vessel_id, package_id, quota_gb, reset_day_of_month)
      values ($1::uuid, $2::uuid, $3::numeric(14,3), $4::int)
      on conflict (vessel_id, package_id)
      do update set
        quota_gb = excluded.quota_gb,
        reset_day_of_month = excluded.reset_day_of_month
      returning vessel_id, package_id, quota_gb, reset_day_of_month
    `,
    [scope.vessel_id, packageId, safeQuotaGb, safeResetDay]
  );

  return result.rows[0] ?? null;
}

export async function getTrafficSummary({ tenantCode = null, vesselCode, month = null } = {}) {
  ensurePool();

  const scope = await resolveVesselScope({ tenantCode, vesselCode });
  if (!scope) {
    return null;
  }

  const { month: normalizedMonth, start, end } = parseMonthRange(month);
  const now = new Date();
  const monthEnd = end < now ? end : now;
  const totals = await sumTrafficWindow({
    vesselId: scope.vessel_id,
    startAt: start,
    endAt: monthEnd
  });

  return {
    month: normalizedMonth,
    month_start: start.toISOString(),
    month_end: monthEnd.toISOString(),
    vessel_code: scope.vessel_code,
    tenant_code: scope.tenant_code,
    ...totals
  };
}

export async function getQuotaRemaining({ tenantCode = null, vesselCode } = {}) {
  ensurePool();

  const scope = await resolveVesselScope({ tenantCode, vesselCode });
  if (!scope) {
    return null;
  }

  const result = await pool.query(
    `
      select
        pa.id as package_assignment_id,
        pa.assigned_at,
        pa.expires_at,
        pa.status,
        pa.is_active,
        p.id as package_id,
        p.code as package_code,
        p.name as package_name,
        coalesce(pq.quota_gb, p.quota_mb::numeric / 1024) as quota_gb,
        coalesce(pq.reset_day_of_month, 1) as reset_day_of_month
      from package_assignments pa
      join packages p on p.id = pa.package_id
      left join package_quotas pq on pq.vessel_id = $1::uuid and pq.package_id = p.id
      where pa.vessel_code = $2::text
        and pa.status = 'active'
        and pa.is_active = true
      order by pa.assigned_at desc
      limit 1
    `,
    [scope.vessel_id, scope.vessel_code]
  );

  const quotaRow = result.rows[0] ?? null;
  if (!quotaRow) {
    return null;
  }

  const now = new Date();
  const cycle = computeCycleRange(now, quotaRow.reset_day_of_month ?? 1);
  const totals = await sumTrafficWindow({
    vesselId: scope.vessel_id,
    startAt: cycle.start,
    endAt: now
  });

  const quotaGb = Number(quotaRow.quota_gb ?? 0);
  const usedGb = Number(totals.total_gb ?? 0);
  const remainingGb = Number((quotaGb - usedGb).toFixed(3));

  return {
    tenant_code: scope.tenant_code,
    vessel_code: scope.vessel_code,
    package_assignment_id: quotaRow.package_assignment_id,
    package_id: quotaRow.package_id,
    package_code: quotaRow.package_code,
    package_name: quotaRow.package_name,
    quota_gb: Number(quotaGb.toFixed(3)),
    used_gb: usedGb,
    remaining_gb: remainingGb,
    remaining_pct: quotaGb > 0 ? Number(Math.max(0, (remainingGb / quotaGb) * 100).toFixed(2)) : null,
    reset_day_of_month: Number(quotaRow.reset_day_of_month ?? 1),
    cycle_start: cycle.start.toISOString(),
    cycle_end: cycle.end.toISOString(),
    refreshed_at: now.toISOString()
  };
}
