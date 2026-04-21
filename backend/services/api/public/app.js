const state = {
  autoRefreshSeconds: 15,
  detail: null,
  edges: [],
  filters: {
    tenant: "",
    vessel: ""
  },
  commandFeedback: null,
  commandJobs: [],
  commandBusyAction: null,
  commandPollTimer: null,
  health: null,
  packages: [],
  packageBusyId: null,
  packageFormId: "",
  packageSaving: false,
  ready: null,
  reportFilters: {
    bucket: "day",
    dateFrom: "",
    dateTo: "",
    advanced: false
  },
  refreshTimer: null,
  selectedEdgeKey: "",
  selectedAssignmentId: "",
  sse: null,
  streamStatus: "idle",
  packageAudit: [],
  packageAuditLoading: false,
  assignmentDetail: null,
  usageReport: null,
  traffic: null
};

const appRoute = window.location.pathname.startsWith("/package-catalog")
  ? "/package-catalog"
  : "/dashboard";
const isPackageCatalogWorkspace = appRoute === "/package-catalog";

const elements = {
  clearFiltersButton: document.querySelector("#clear-filters-button"),
  detailMeta: document.querySelector("#detail-meta"),
  detailShell: document.querySelector("#detail-shell"),
  detailTitle: document.querySelector("#detail-title"),
  edgeCount: document.querySelector("#edge-count"),
  edgeList: document.querySelector("#edge-list"),
  endpointList: document.querySelector("#endpoint-list"),
  filtersForm: document.querySelector("#filters-form"),
  healthPill: document.querySelector("#health-pill"),
  packageList: document.querySelector("#package-list"),
  packageCount: document.querySelector("#package-count"),
  packageForm: document.querySelector("#package-form"),
  packageFormActive: document.querySelector("#package-form-active"),
  packageFormCode: document.querySelector("#package-form-code"),
  packageFormDescription: document.querySelector("#package-form-description"),
  packageFormFeedback: document.querySelector("#package-form-feedback"),
  packageFormId: document.querySelector("#package-form-id"),
  packageFormName: document.querySelector("#package-form-name"),
  packageFormPrice: document.querySelector("#package-form-price"),
  packageFormQuota: document.querySelector("#package-form-quota"),
  packageFormReset: document.querySelector("#package-form-reset"),
  packageFormSpeed: document.querySelector("#package-form-speed"),
  packageFormSubmit: document.querySelector("#package-form-submit"),
  packageFormTenant: document.querySelector("#package-form-tenant"),
  packageFormTitle: document.querySelector("#package-form-title"),
  packageFormValidity: document.querySelector("#package-form-validity"),
  usageBucketSelect: document.querySelector("#usage-bucket-select"),
  usageDateFrom: document.querySelector("#usage-date-from"),
  usageDateTo: document.querySelector("#usage-date-to"),
  usageExportButton: document.querySelector("#usage-export-button"),
  usageFilterApply: document.querySelector("#usage-filter-apply"),
  usageFilterReset: document.querySelector("#usage-filter-reset"),
  readyPill: document.querySelector("#ready-pill"),
  refreshButton: document.querySelector("#refresh-button"),
  refreshIntervalSelect: document.querySelector("#refresh-interval-select"),
  workspaceAdvancedToggle: document.querySelector("#workspace-advanced-toggle"),
  assignmentDetailShell: document.querySelector("#assignment-detail-shell"),
  assignmentDetailPill: document.querySelector("#assignment-detail-pill"),
  usageAssignmentsTable: document.querySelector("#usage-assignments-table"),
  usagePackagesTable: document.querySelector("#usage-packages-table"),
  usageSummaryCards: document.querySelector("#usage-summary-cards"),
  usageUsersTable: document.querySelector("#usage-users-table"),
  usageTimelineTable: document.querySelector("#usage-timeline-table"),
  usageWindowPill: document.querySelector("#usage-window-pill"),
  usageNavItem: document.querySelector("#usage-nav-item"),
  packageAuditCount: document.querySelector("#package-audit-count"),
  packageAuditSection: document.querySelector("#package-audit-section"),
  packageAuditTable: document.querySelector("#package-audit-table"),
  streamPill: document.querySelector("#stream-pill"),
  summaryCards: document.querySelector("#summary-cards"),
  tenantInput: document.querySelector("#tenant-input"),
  vesselInput: document.querySelector("#vessel-input")
};

function setTextContent(element, value) {
  if (!element) {
    return;
  }
  element.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "No data";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function formatCompactValue(value, maxLength = 140) {
  if (value === null || value === undefined) {
    return "";
  }

  let text;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch (error) {
      text = String(value);
    }
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "No data";
  }
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : Math.min(digits, 1)
  });
}

function formatKbps(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "No data";
  }
  const numeric = Number(value);
  if (numeric >= 1000) {
    return `${formatNumber(numeric / 1000, 2)} Mbps`;
  }
  return `${formatNumber(numeric, 2)} Kbps`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "No data";
  }
  return `${formatNumber(value, 2)}%`;
}

function formatCoordinate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "No data";
  }
  return formatNumber(value, 5);
}

function isRecentTimestamp(value, seconds = 120) {
  if (!value) {
    return false;
  }
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return Date.now() - timestamp <= seconds * 1000;
}

function formatDataVolumeGb(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "No data";
  }
  const numeric = Number(value);
  if (numeric >= 1024) {
    return `${formatNumber(numeric / 1024, 2)} TB`;
  }
  return `${formatNumber(numeric, 2)} GB`;
}

function formatDataVolumeMb(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "No data";
  }
  const numeric = Number(value);
  if (numeric >= 1024) {
    return formatDataVolumeGb(numeric / 1024);
  }
  return `${formatNumber(numeric, 2)} MB`;
}

function formatPackageDuration(days) {
  const numeric = Number(days);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "No expiry";
  }
  return numeric === 1 ? "1 day" : `${numeric} days`;
}

function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "No price";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(numeric);
}

function estimateTrafficTotalGb(traffic) {
  if (!traffic?.summary || typeof traffic.window_minutes !== "number") {
    return null;
  }

  const avgThroughputKbps = Number(traffic.summary.avg_throughput_kbps || 0);
  const windowMinutes = Number(traffic.window_minutes || 0);
  if (!Number.isFinite(avgThroughputKbps) || avgThroughputKbps <= 0 || windowMinutes <= 0) {
    return null;
  }

  // Estimate total volume over the selected traffic window.
  // avg_throughput_kbps is kilobits per second.
  return (avgThroughputKbps * windowMinutes * 60) / 8 / 1024 / 1024;
}

function extractTelemetryTotalGb(telemetry, traffic) {
  const interfaceTotals = [];
  const telemetryInterfaces = Array.isArray(telemetry?.interfaces) ? telemetry.interfaces : [];
  const trafficInterfaces = Array.isArray(traffic?.latest?.interfaces) ? traffic.latest.interfaces : [];

  telemetryInterfaces.forEach((iface) => {
    const total = Number(iface?.total_gb);
    if (Number.isFinite(total)) {
      interfaceTotals.push(total);
    }
  });

  trafficInterfaces.forEach((iface) => {
    const total = Number(iface?.total_gb);
    if (Number.isFinite(total)) {
      interfaceTotals.push(total);
    }
  });

  if (interfaceTotals.length) {
    return Math.max(...interfaceTotals);
  }

  return estimateTrafficTotalGb(traffic);
}

function extractTelemetryInterfaces(telemetry, traffic) {
  const telemetryInterfaces = Array.isArray(telemetry?.interfaces) ? telemetry.interfaces : [];
  if (telemetryInterfaces.length) {
    return telemetryInterfaces;
  }

  const trafficInterfaces = Array.isArray(traffic?.latest?.interfaces) ? traffic.latest.interfaces : [];
  return trafficInterfaces;
}

function normalizeNameKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function classifyUplinkName(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("starlink")) {
    return "starlink";
  }
  if (normalized.includes("vsat")) {
    return "vsat";
  }
  return null;
}

function findInterfaceByLabel(interfaces, label) {
  if (!Array.isArray(interfaces) || !label) {
    return null;
  }

  const requestedKey = normalizeNameKey(label);
  const requestedClass = classifyUplinkName(label);

  const exactMatch = interfaces.find((iface) => normalizeNameKey(iface?.name) === requestedKey);
  if (exactMatch) {
    return exactMatch;
  }

  if (requestedClass) {
    const classMatch = interfaces.find((iface) => classifyUplinkName(iface?.name) === requestedClass);
    if (classMatch) {
      return classMatch;
    }
  }

  return (
    interfaces.find((iface) => {
      const interfaceKey = normalizeNameKey(iface?.name);
      return interfaceKey.includes(requestedKey) || requestedKey.includes(interfaceKey);
    }) || null
  );
}

function resolveUplinkDisplay(reportedLabel, interfaces) {
  const reported = String(reportedLabel ?? "").trim();
  const matched = findInterfaceByLabel(interfaces, reported);
  const matchedName = matched?.name ? String(matched.name).trim() : "";

  return {
    displayName: matchedName || reported || "No data",
    matchedName: matchedName || null,
    rawLabel: reported || null
  };
}

function resolveUplinkPolicy(interfaces, activeUplink, serverPolicy = null) {
  const starlink = findInterfaceByLabel(interfaces, "Starlink") || findInterfaceByClass(interfaces, "starlink");
  const vsat = findInterfaceByLabel(interfaces, "VSAT") || findInterfaceByClass(interfaces, "vsat");
  const activeRole = serverPolicy?.active_role || classifyUplinkName(activeUplink) || null;

  const workInterface = serverPolicy?.work?.interface_name
    ? findInterfaceByLabel(interfaces, serverPolicy.work.interface_name) || vsat || starlink
    : vsat || starlink;
  const entertainmentInterface = serverPolicy?.entertainment?.interface_name
    ? findInterfaceByLabel(interfaces, serverPolicy.entertainment.interface_name) || starlink || vsat
    : starlink || vsat;

  const buildPolicyEntry = (label, preferred, interfaceRow, fallbackRow) => {
    const detected = Boolean(interfaceRow);
    const fallback = !detected && Boolean(fallbackRow);
    const status = detected ? "ready" : fallback ? "fallback" : "missing";

    return {
      label,
      preferred,
      interfaceName: interfaceRow?.name ?? null,
      detected,
      fallback,
      status,
      note: detected
        ? `Detected ${interfaceRow.name}`
        : fallbackRow
          ? `Falling back to ${fallbackRow.name}`
          : `No ${label.toLowerCase()} uplink telemetry yet`
    };
  };

  return {
    activeRole,
    activeInterface: activeUplink || null,
    work: buildPolicyEntry("Work", "VSAT", workInterface, starlink),
    entertainment: buildPolicyEntry("Entertainment", "Starlink", entertainmentInterface, vsat)
  };
}

function findInterfaceByClass(interfaces, className) {
  if (!Array.isArray(interfaces) || !className) {
    return null;
  }

  return interfaces.find((iface) => classifyUplinkName(iface?.name) === className) || null;
}

function findInterfaceTotalGb(interfaces, interfaceName) {
  if (!Array.isArray(interfaces) || !interfaceName) {
    return null;
  }

  const matched = interfaces.find((iface) => String(iface?.name || "").trim() === String(interfaceName).trim());
  if (!matched) {
    return null;
  }

  const total = Number(matched.total_gb);
  return Number.isFinite(total) ? total : null;
}

function renderInterfaceUsage(interfaces, activeInterfaceName) {
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    return `
      <div class="empty-state compact-empty-state">
        <h3>Chua co du lieu tung port</h3>
        <p>MCU chua gui danh sach interfaces kem tong dung luong cho moi cong.</p>
      </div>
    `;
  }

  const rows = [...interfaces]
    .sort((left, right) => String(left?.name || "").localeCompare(String(right?.name || "")))
    .map((iface) => {
      const name = String(iface?.name || "unknown");
      const isActive = activeInterfaceName && name === activeInterfaceName;
      return `
        <tr>
          <td>
            <div class="port-name-cell">
              <strong>${escapeHtml(name)}</strong>
              ${isActive ? '<span class="port-active-chip">Active</span>' : ""}
            </div>
          </td>
          <td>${escapeHtml(formatKbps(iface?.rx_kbps))}</td>
          <td>${escapeHtml(formatKbps(iface?.tx_kbps))}</td>
          <td>${escapeHtml(formatKbps(iface?.throughput_kbps))}</td>
          <td>${escapeHtml(formatDataVolumeGb(iface?.total_gb))}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="port-usage-table-wrap">
      <table class="port-usage-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>RX</th>
            <th>TX</th>
            <th>Throughput</th>
            <th>Total data</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function statusMarkup(online) {
  const label = online ? "Online" : "Offline";
  const statusClass = online ? "status-good" : "status-bad";
  return `<span class="status-pill ${statusClass}">${label}</span>`;
}

function setStatusPill(element, label, kind) {
  const className = {
    bad: "status-bad",
    good: "status-good",
    loading: "status-loading",
    muted: "status-muted",
    warn: "status-warn"
  }[kind] || "status-muted";

  element.className = `status-pill ${className}`;
  element.textContent = label;
}

function createQueryString(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, value);
    }
  });
  return search.toString();
}

function currentApiOrigin() {
  return window.location.origin;
}

function buildAbsoluteUrl(path, query = {}) {
  const url = new URL(path, `${currentApiOrigin()}/`);
  const queryString = createQueryString(query);
  if (queryString) {
    url.search = queryString;
  }
  return url.toString();
}

function currentWorkspacePath() {
  return appRoute;
}

function syncWorkspaceLinks() {
  document.querySelectorAll("[data-app-current-route-link]").forEach((link) => {
    link.setAttribute("href", currentWorkspacePath());
  });
  document.querySelectorAll("[data-app-dashboard-link]").forEach((link) => {
    link.setAttribute("href", "/dashboard");
  });
  document.querySelectorAll("[data-app-package-catalog-link]").forEach((link) => {
    link.setAttribute("href", "/package-catalog");
  });
  document.querySelectorAll('.sidebar-menu a[href="#packages-section"]').forEach((link) => {
    link.setAttribute("href", "/package-catalog#packages-section");
  });
  document.querySelectorAll('.sidebar-menu a[href="/package-catalog#packages-section"]').forEach((link) => {
    link.setAttribute("href", "/package-catalog#packages-section");
  });
}

async function apiFetch(path, options = {}) {
  return fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    }
  });
}

async function fetchJson(path) {
  const response = await apiFetch(path);

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`${response.status} ${payload || response.statusText}`);
  }

  return response.json();
}

function selectedEdge() {
  return state.edges.find((edge) => edgeKey(edge) === state.selectedEdgeKey) || null;
}

function edgeKey(edge) {
  return `${edge.tenant_code}:${edge.vessel_code}:${edge.edge_code}`;
}

function applyQueryFiltersFromLocation() {
  const params = new URLSearchParams(window.location.search);
  state.filters.tenant = params.get("tenant") || "";
  state.filters.vessel = params.get("vessel") || "";
  state.autoRefreshSeconds = Number(params.get("refresh") || "15") || 15;

  elements.tenantInput.value = state.filters.tenant;
  elements.vesselInput.value = state.filters.vessel;
  elements.refreshIntervalSelect.value = String(state.autoRefreshSeconds);
}

function syncLocationQuery() {
  const params = new URLSearchParams();
  if (state.filters.tenant) params.set("tenant", state.filters.tenant);
  if (state.filters.vessel) params.set("vessel", state.filters.vessel);
  if (state.autoRefreshSeconds) params.set("refresh", String(state.autoRefreshSeconds));
  const query = params.toString();
  const hash = window.location.hash || "";
  const nextUrl = query ? `${currentWorkspacePath()}?${query}${hash}` : `${currentWorkspacePath()}${hash}`;
  window.history.replaceState({}, "", nextUrl);
}

async function loadHealth() {
  const [health, ready] = await Promise.all([
    fetchJson("/api/health"),
    fetchJson("/api/ready").catch(() => ({ status: "not_ready", checks: { database: false } }))
  ]);

  state.health = health;
  state.ready = ready;

  setStatusPill(elements.healthPill, health.status === "ok" ? "Healthy" : "Error", health.status === "ok" ? "good" : "bad");
  const dbReady = ready?.checks?.database === true;
  setStatusPill(elements.readyPill, dbReady ? "Ready" : "DB offline", dbReady ? "good" : "warn");
}

async function loadEdges() {
  const query = createQueryString({
    limit: 200,
    online_seconds: 120,
    tenant: state.filters.tenant,
    vessel: state.filters.vessel
  });

  const data = await fetchJson(`/api/mcu/edges${query ? `?${query}` : ""}`);
  state.edges = Array.isArray(data.items) ? data.items : [];

  const currentSelected = selectedEdge();
  if (!currentSelected) {
    state.selectedEdgeKey = state.edges[0] ? edgeKey(state.edges[0]) : "";
  }

  renderSummaryCards();
  renderEndpointList();
  renderEdgeList();
}

async function loadPackages() {
  if (!isPackageCatalogWorkspace) {
    state.packages = [];
    renderPackagesSection();
    renderPackageForm();
    return;
  }

  const query = createQueryString({
    tenant: state.filters.tenant,
    include_inactive: 1
  });

  const data = await fetchJson(`/api/packages${query ? `?${query}` : ""}`).catch((error) => {
    console.warn("[dashboard] package load failed:", error);
    return [];
  });

  state.packages = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  renderPackagesSection();
  renderPackageForm();
}

async function loadUsageReport() {
  if (!isPackageCatalogWorkspace) {
    state.usageReport = null;
    renderUsageReportSection();
    return;
  }

  const query = createQueryString({
    tenant: state.filters.tenant,
    vessel: state.filters.vessel,
    window_minutes: 1440,
    bucket: state.reportFilters.bucket,
    date_from: state.reportFilters.dateFrom || undefined,
    date_to: state.reportFilters.dateTo || undefined
  });

  const data = await fetchJson(`/api/reports/usage${query ? `?${query}` : ""}`).catch((error) => {
    console.warn("[dashboard] usage report load failed:", error);
    return null;
  });

  state.usageReport = data;
  renderUsageReportSection();
}

async function loadPackageAudit() {
  if (!isPackageCatalogWorkspace || !state.reportFilters.advanced) {
    state.packageAudit = [];
    renderPackageAuditSection();
    return;
  }

  const query = createQueryString({
    tenant: state.filters.tenant,
    vessel: state.filters.vessel,
    date_from: state.reportFilters.dateFrom || undefined,
    date_to: state.reportFilters.dateTo || undefined,
    limit: 50
  });

  const data = await fetchJson(`/api/package-audit${query ? `?${query}` : ""}`).catch((error) => {
    console.warn("[dashboard] package audit load failed:", error);
    return { items: [] };
  });

  state.packageAudit = Array.isArray(data?.items) ? data.items : [];
  renderPackageAuditSection();
}

async function loadAssignmentDetail() {
  if (!isPackageCatalogWorkspace || !state.selectedAssignmentId) {
    state.assignmentDetail = null;
    renderAssignmentDetailSection();
    return;
  }

  const data = await fetchJson(`/api/package-assignments/${encodeURIComponent(state.selectedAssignmentId)}`).catch((error) => {
    console.warn("[dashboard] assignment detail load failed:", error);
    return null;
  });

  state.assignmentDetail = data;
  renderAssignmentDetailSection();
}

function renderSummaryCards() {
  const total = state.edges.length;
  const online = state.edges.filter((item) => item.online).length;
  const avgThroughput = total
    ? state.edges.reduce((sum, item) => sum + Number(item.throughput_kbps || 0), 0) / total
    : 0;

  const cards = [
    {
      label: "Fleet in scope",
      value: total,
      meta: "Devices matching current tenant and vessel filters",
      icon: "bi bi-diagram-3-fill",
      color: "info"
    },
    {
      label: "Online rate",
      value: online,
      meta: "Last heartbeat within 120 seconds",
      icon: "bi bi-broadcast",
      color: "success"
    },
    {
      label: "Active throughput",
      value: state.edges.filter((item) => Number(item.throughput_kbps || 0) > 0).length,
      meta: "Edges reporting live throughput",
      icon: "bi bi-lightning-charge-fill",
      color: "warning"
    },
    {
      label: "Average throughput",
      value: formatKbps(avgThroughput),
      meta: "Mean throughput across the filtered fleet",
      icon: "bi bi-graph-up-arrow",
      color: "primary"
    }
  ];

  elements.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <div class="col-12 col-md-6 col-xl-3">
          <div class="small-box bg-${escapeHtml(card.color)}">
            <div class="inner">
              <h3>${escapeHtml(card.value)}</h3>
              <p>${escapeHtml(card.label)}</p>
            </div>
            <div class="icon">
              <i class="${escapeHtml(card.icon)}"></i>
            </div>
            <div class="small-box-footer">${escapeHtml(card.meta)}</div>
          </div>
        </div>
      `
    )
    .join("");
}

function renderPackagesSection() {
  if (!elements.packageList) {
    return;
  }

  if (elements.packageCount) {
    elements.packageCount.textContent = `${state.packages.length} packages`;
  }

  if (!state.packages.length) {
    elements.packageList.innerHTML = `
      <div class="empty-state compact-empty-state">
        <h3>No packages found</h3>
        <p>Run the package seed or broaden the tenant filter to show package catalog entries here.</p>
      </div>
    `;
    return;
  }

  elements.packageList.innerHTML = `
    <div class="package-grid">
      ${state.packages
        .map((item) => {
          const quotaMb = Number(item.quota_mb || 0);
          const selected = selectedEdge();
          const canAssign = Boolean(selected);
          const isBusy = state.packageBusyId === item.id;
          const inactive = !item.is_active;
          return `
            <article class="package-card">
              <div class="package-card-header">
                <div>
                  <span class="package-kicker">${escapeHtml(item.tenant_code || "tenant")}</span>
                  <h3>${escapeHtml(item.name || item.code || "Package")}</h3>
                  <p class="package-description">${escapeHtml(item.description || "No description")}</p>
                </div>
                <div class="d-flex flex-column align-items-end gap-2">
                  <span class="package-code">${escapeHtml(item.code || "package")}</span>
                  ${inactive ? '<span class="badge text-bg-secondary">Inactive</span>' : ""}
                </div>
              </div>
              <div class="package-metrics">
                <span><strong>Quota</strong> ${escapeHtml(formatDataVolumeMb(quotaMb))}</span>
                <span><strong>Validity</strong> ${escapeHtml(formatPackageDuration(item.validity_days ?? item.duration_days))}</span>
                <span><strong>Price</strong> ${escapeHtml(formatUsd(item.price_usd))}</span>
                <span><strong>Status</strong> ${escapeHtml(item.is_active ? "Active" : "Inactive")}</span>
                <span><strong>Created</strong> ${escapeHtml(formatDate(item.created_at))}</span>
                <span><strong>Updated</strong> ${escapeHtml(formatDate(item.updated_at))}</span>
              </div>
              <div class="package-actions">
                <div class="package-admin-actions">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-light package-edit-btn"
                    data-package-edit="${escapeHtml(item.id)}"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger package-delete-btn"
                    data-package-delete="${escapeHtml(item.id)}"
                  >
                    ${item.is_active ? "Archive" : "Restore"}
                  </button>
                </div>
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    class="btn btn-sm btn-primary package-assign-btn"
                    data-package-assign="${escapeHtml(item.id)}"
                    ${!canAssign || isBusy || !item.is_active ? "disabled" : ""}
                  >
                    ${isBusy ? "Assigning..." : "Assign"}
                  </button>
                  <span class="tiny-note">
                    ${selected
                      ? `Assign to ${selected.vessel_code} on ${selected.tenant_code}`
                      : "Select an edge first"}
                  </span>
                </div>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderPackageForm() {
  if (!elements.packageForm || !elements.packageFormFeedback) {
    return;
  }

  const pkg = state.packages.find((item) => item.id === state.packageFormId) || null;
  const isEditing = Boolean(pkg);

  if (elements.packageFormTitle) {
    elements.packageFormTitle.textContent = isEditing ? `Edit package: ${pkg.name || pkg.code}` : "Create package";
  }

  if (elements.packageFormSubmit) {
    elements.packageFormSubmit.textContent = state.packageSaving ? "Saving..." : isEditing ? "Update package" : "Save package";
    elements.packageFormSubmit.disabled = state.packageSaving;
  }

  if (elements.packageFormId) {
    elements.packageFormId.value = pkg?.id || "";
  }
  if (elements.packageFormTenant) {
    elements.packageFormTenant.value = pkg?.tenant_code || state.filters.tenant || "";
    elements.packageFormTenant.readOnly = isEditing;
  }
  if (elements.packageFormCode) {
    elements.packageFormCode.value = pkg?.code || "";
  }
  if (elements.packageFormName) {
    elements.packageFormName.value = pkg?.name || "";
  }
  if (elements.packageFormDescription) {
    elements.packageFormDescription.value = pkg?.description || "";
  }
  if (elements.packageFormQuota) {
    elements.packageFormQuota.value = pkg?.quota_mb ?? "";
  }
  if (elements.packageFormValidity) {
    elements.packageFormValidity.value = pkg?.validity_days ?? pkg?.duration_days ?? "";
  }
  if (elements.packageFormPrice) {
    elements.packageFormPrice.value = pkg?.price_usd ?? "";
  }
  if (elements.packageFormSpeed) {
    elements.packageFormSpeed.value = pkg?.speed_limit_kbps ?? "";
  }
  if (elements.packageFormActive) {
    elements.packageFormActive.checked = pkg ? Boolean(pkg.is_active) : true;
  }
  elements.packageFormFeedback.textContent = isEditing
    ? "Editing an existing package. Save will update the record in place."
    : "Use this form to create a new package or edit an existing one.";
}

async function assignPackage(packageId) {
  const selected = selectedEdge();
  const pkg = state.packages.find((item) => item.id === packageId) || null;
  if (!pkg) {
    return;
  }
  if (!selected) {
    state.commandFeedback = {
      kind: "danger",
      text: "Select an edge first before assigning a package."
    };
    renderDetail();
    return;
  }

  const username = window.prompt(`Assign ${pkg.name || pkg.code} to which username?`);
  const trimmedUsername = String(username || "").trim();
  if (!trimmedUsername) {
    return;
  }

  const confirmText = `Assign ${pkg.name || pkg.code} to ${trimmedUsername} on ${selected.vessel_code}?`;
  if (!window.confirm(confirmText)) {
    return;
  }

  state.packageBusyId = packageId;
  renderPackagesSection();

  try {
    const response = await apiFetch(`/api/packages/${encodeURIComponent(packageId)}/assign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        username: trimmedUsername,
        vessel_code: selected.vessel_code
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || "package_assign_failed");
    }

    state.commandFeedback = {
      kind: "success",
      text: `Assigned ${pkg.name || pkg.code} to ${trimmedUsername} on ${selected.vessel_code}.`
    };
    await refreshSelectedEdge();
    await loadPackages();
    await loadPackageAudit();
  } catch (error) {
    state.commandFeedback = {
      kind: "danger",
      text: error.message || "Unable to assign package"
    };
    renderDetail();
  } finally {
    state.packageBusyId = null;
    renderPackagesSection();
    renderDetail();
  }
}

function selectAssignmentDetail(assignmentId) {
  state.selectedAssignmentId = String(assignmentId || "").trim();
  state.assignmentDetail = null;
  renderAssignmentDetailSection();
  if (state.selectedAssignmentId) {
    loadAssignmentDetail().catch(renderErrorState);
  }
}

function beginPackageEdit(packageId) {
  state.packageFormId = packageId;
  renderPackageForm();
  elements.packageForm?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetPackageForm() {
  state.packageFormId = "";
  if (elements.packageForm) {
    elements.packageForm.reset();
  }
  if (elements.packageFormActive) {
    elements.packageFormActive.checked = true;
  }
  if (elements.packageFormTenant && state.filters.tenant) {
    elements.packageFormTenant.value = state.filters.tenant;
  }
  renderPackageForm();
}

async function savePackageFromForm() {
  if (!elements.packageForm) {
    return;
  }

  const payload = {
    tenant_code: elements.packageFormTenant?.value.trim() || "",
    code: elements.packageFormCode?.value.trim() || "",
    name: elements.packageFormName?.value.trim() || "",
    description: elements.packageFormDescription?.value.trim() || "",
    quota_mb: Number(elements.packageFormQuota?.value || 0),
    validity_days: Number(elements.packageFormValidity?.value || 0),
    price_usd: Number(elements.packageFormPrice?.value || 0),
    speed_limit_kbps: elements.packageFormSpeed?.value ? Number(elements.packageFormSpeed.value) : null,
    is_active: Boolean(elements.packageFormActive?.checked)
  };

  if (!payload.tenant_code || !payload.code || !payload.name || !Number.isFinite(payload.quota_mb) || payload.quota_mb <= 0 || !Number.isFinite(payload.validity_days) || payload.validity_days <= 0) {
    state.commandFeedback = {
      kind: "danger",
      text: "tenant_code, code, name, quota_mb, and validity_days are required."
    };
    renderDetail();
    return;
  }

  state.packageSaving = true;
  renderPackageForm();

  try {
    const packageId = state.packageFormId || elements.packageFormId?.value || "";
    const method = packageId ? "PATCH" : "POST";
    const endpoint = packageId ? `/api/packages/${encodeURIComponent(packageId)}` : "/api/packages";
    const response = await apiFetch(endpoint, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result?.error || response.statusText || "package_save_failed");
    }

    state.commandFeedback = {
      kind: "success",
      text: packageId ? `Updated package ${payload.code}.` : `Created package ${payload.code}.`
    };
    state.packageFormId = "";
    await loadPackages();
    await loadUsageReport();
    await loadPackageAudit();
  } catch (error) {
    state.commandFeedback = {
      kind: "danger",
      text: error.message || "Unable to save package"
    };
    renderDetail();
  } finally {
    state.packageSaving = false;
    renderPackageForm();
    renderDetail();
  }
}

async function archivePackage(packageId) {
  const pkg = state.packages.find((item) => item.id === packageId) || null;
  if (!pkg) {
    return;
  }

  const actionLabel = pkg.is_active ? "archive" : "restore";
  if (!window.confirm(`Do you want to ${actionLabel} package ${pkg.name || pkg.code}?`)) {
    return;
  }

  try {
    const response = await apiFetch(`/api/packages/${encodeURIComponent(packageId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      }
      ,
      body: JSON.stringify({
        is_active: !pkg.is_active
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result?.error || response.statusText || "package_delete_failed");
    }

    state.commandFeedback = {
      kind: "success",
      text: pkg.is_active ? `Archived package ${pkg.code}.` : `Restored package ${pkg.code}.`
    };
    await loadPackages();
    await loadUsageReport();
    await loadPackageAudit();
  } catch (error) {
    state.commandFeedback = {
      kind: "danger",
      text: error.message || "Unable to update package status"
    };
    renderDetail();
  } finally {
    renderPackageForm();
    renderDetail();
  }
}

async function unassignAssignment(assignmentId) {
  if (!assignmentId) {
    return;
  }

  if (!window.confirm("Do you want to unassign this package assignment?")) {
    return;
  }

  try {
    const response = await apiFetch(`/api/package-assignments/${encodeURIComponent(assignmentId)}`, {
      method: "DELETE",
      headers: {
        accept: "application/json"
      }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result?.error || response.statusText || "package_unassign_failed");
    }

    state.commandFeedback = {
      kind: "success",
      text: "Assignment cancelled."
    };
    if (state.selectedAssignmentId === assignmentId) {
      state.selectedAssignmentId = "";
      state.assignmentDetail = null;
    }
    await refreshSelectedEdge();
    await loadUsageReport();
    await loadPackageAudit();
    await loadAssignmentDetail();
  } catch (error) {
    state.commandFeedback = {
      kind: "danger",
      text: error.message || "Unable to unassign package"
    };
    renderDetail();
  } finally {
    renderUsageReportSection();
    renderDetail();
  }
}

function syncUsageFilterInputs() {
  if (elements.usageDateFrom) {
    elements.usageDateFrom.value = state.reportFilters.dateFrom;
  }
  if (elements.usageDateTo) {
    elements.usageDateTo.value = state.reportFilters.dateTo;
  }
  if (elements.usageBucketSelect) {
    elements.usageBucketSelect.value = state.reportFilters.bucket;
  }
  if (elements.workspaceAdvancedToggle) {
    elements.workspaceAdvancedToggle.textContent = state.reportFilters.advanced ? "Advanced on" : "Advanced";
  }
  if (elements.usageNavItem) {
    elements.usageNavItem.hidden = !state.reportFilters.advanced;
  }
  if (elements.usageExportButton) {
    elements.usageExportButton.hidden = !state.reportFilters.advanced;
  }
}

function applyUsageFiltersFromInputs() {
  state.reportFilters.dateFrom = elements.usageDateFrom?.value || "";
  state.reportFilters.dateTo = elements.usageDateTo?.value || "";
  state.reportFilters.bucket = elements.usageBucketSelect?.value || "day";
}

function resetUsageFilters() {
  state.reportFilters.dateFrom = "";
  state.reportFilters.dateTo = "";
  state.reportFilters.bucket = "day";
  syncUsageFilterInputs();
  refreshAll().catch(renderErrorState);
}

function toggleAdvancedWorkspace() {
  state.reportFilters.advanced = !state.reportFilters.advanced;
  syncUsageFilterInputs();
  document.querySelector("#usage-section")?.toggleAttribute("hidden", !state.reportFilters.advanced);
  renderUsageReportSection();
  loadPackageAudit().catch(renderErrorState);
  renderPackageAuditSection();
}

function renderUsageReportSection() {
  if (!elements.usageSummaryCards) {
    return;
  }

  const report = state.usageReport || {};
  const summary = report.summary || {};
  const topUsers = Array.isArray(report.top_users) ? report.top_users : [];
  const topPackages = Array.isArray(report.top_packages) ? report.top_packages : [];
  const activeAssignments = Array.isArray(report.active_assignments) ? report.active_assignments : [];
  const timeline = Array.isArray(report.timeline) ? report.timeline : [];

  if (elements.usageWindowPill) {
    const rangeLabel = report.date_from || report.date_to
      ? `${report.date_from ? new Date(report.date_from).toLocaleDateString() : "start"} → ${report.date_to ? new Date(report.date_to).toLocaleDateString() : "now"}`
      : report.window_minutes
        ? `${report.window_minutes}m`
        : "24h";
    elements.usageWindowPill.textContent = `${report.bucket || "day"} · ${rangeLabel}`;
  }

  const cards = [
    {
      label: "Total usage",
      value: formatDataVolumeMb(summary.total_mb ?? 0),
      meta: `${formatNumber(summary.samples ?? 0, 0)} samples in window`,
      icon: "bi bi-bar-chart-fill",
      color: "info"
    },
    {
      label: "Upload",
      value: formatDataVolumeMb(summary.upload_mb ?? 0),
      meta: `${formatNumber(summary.users ?? 0, 0)} users tracked`,
      icon: "bi bi-cloud-arrow-up-fill",
      color: "success"
    },
    {
      label: "Download",
      value: formatDataVolumeMb(summary.download_mb ?? 0),
      meta: `${formatNumber(summary.vessels ?? 0, 0)} vessels in scope`,
      icon: "bi bi-cloud-arrow-down-fill",
      color: "warning"
    },
    {
      label: "Assignments",
      value: formatNumber(summary.assignments ?? activeAssignments.length, 0),
      meta: `${formatNumber(summary.packages ?? 0, 0)} packages in use`,
      icon: "bi bi-patch-check-fill",
      color: "primary"
    }
  ];

  elements.usageSummaryCards.innerHTML = cards
    .map(
      (card) => `
        <div class="col-12 col-md-6 col-xl-3">
          <div class="small-box bg-${escapeHtml(card.color)}">
            <div class="inner">
              <h3>${escapeHtml(card.value)}</h3>
              <p>${escapeHtml(card.label)}</p>
            </div>
            <div class="icon">
              <i class="${escapeHtml(card.icon)}"></i>
            </div>
            <div class="small-box-footer">${escapeHtml(card.meta)}</div>
          </div>
        </div>
      `
    )
    .join("");

  if (elements.usageUsersTable) {
    elements.usageUsersTable.innerHTML = topUsers.length
      ? topUsers
        .map((item) => `
          <tr>
            <td>${escapeHtml(item.username || "unknown")}</td>
            <td>${escapeHtml(item.vessel_code || "n/a")}</td>
            <td class="text-end">${escapeHtml(formatDataVolumeMb(item.total_mb || 0))}</td>
            <td>${escapeHtml(formatDate(item.last_seen))}</td>
          </tr>
        `)
        .join("")
      : `<tr><td colspan="4" class="usage-empty">No usage rows for the selected scope.</td></tr>`;
  }

  if (elements.usagePackagesTable) {
    elements.usagePackagesTable.innerHTML = topPackages.length
      ? topPackages
        .map((item) => `
          <tr>
            <td>${escapeHtml(item.package_name || item.package_code || "package")}</td>
            <td class="text-end">${escapeHtml(formatDataVolumeMb(item.total_mb || 0))}</td>
            <td class="text-end">${escapeHtml(formatNumber(item.user_count || 0, 0))}</td>
          </tr>
        `)
        .join("")
      : `<tr><td colspan="3" class="usage-empty">No package usage in the current window.</td></tr>`;
  }

  if (elements.usageAssignmentsTable) {
    elements.usageAssignmentsTable.innerHTML = activeAssignments.length
      ? activeAssignments
        .map((item) => `
          <tr>
            <td>${escapeHtml(item.id || "n/a")}</td>
            <td>${escapeHtml(item.username || "unknown")}</td>
            <td>${escapeHtml(item.vessel_code || "n/a")}</td>
            <td>${escapeHtml(item.package_code || item.package_name || "package")}</td>
            <td class="text-end">${escapeHtml(formatDataVolumeMb(item.remaining_mb || 0))}</td>
            <td><span class="badge text-bg-${item.status === "active" ? "success" : "secondary"}">${escapeHtml(item.status || "unknown")}</span></td>
            <td>${escapeHtml(formatDate(item.expires_at))}</td>
            <td class="text-end">
              <button type="button" class="btn btn-sm btn-outline-light me-1" data-package-view-assignment="${escapeHtml(item.id)}">View</button>
              <button type="button" class="btn btn-sm btn-outline-danger" data-package-unassign="${escapeHtml(item.id)}">Unassign</button>
            </td>
          </tr>
        `)
        .join("")
      : `<tr><td colspan="8" class="usage-empty">No active assignments in the current scope.</td></tr>`;
  }

  if (elements.usageTimelineTable) {
    elements.usageTimelineTable.innerHTML = timeline.length
      ? timeline
        .map((item) => `
          <tr>
            <td>${escapeHtml(formatDate(item.bucket_at))}</td>
            <td class="text-end">${escapeHtml(formatDataVolumeMb(item.upload_mb || 0))}</td>
            <td class="text-end">${escapeHtml(formatDataVolumeMb(item.download_mb || 0))}</td>
            <td class="text-end">${escapeHtml(formatDataVolumeMb(item.total_mb || 0))}</td>
            <td class="text-end">${escapeHtml(formatNumber(item.samples || 0, 0))}</td>
          </tr>
        `)
        .join("")
      : `<tr><td colspan="5" class="usage-empty">No timeline data in the selected window.</td></tr>`;
  }
}

function renderPackageAuditSection() {
  if (!elements.packageAuditSection || !elements.packageAuditTable) {
    return;
  }

  const isVisible = Boolean(isPackageCatalogWorkspace && state.reportFilters.advanced);
  elements.packageAuditSection.hidden = !isVisible;
  if (!isVisible) {
    elements.packageAuditTable.innerHTML = "";
    if (elements.packageAuditCount) {
      elements.packageAuditCount.textContent = "0 events";
    }
    return;
  }

  if (elements.packageAuditCount) {
    elements.packageAuditCount.textContent = `${state.packageAudit.length} events`;
  }

  if (!state.packageAudit.length) {
    elements.packageAuditTable.innerHTML = `<tr><td colspan="5" class="usage-empty">No package audit events in the current scope.</td></tr>`;
    return;
  }

  elements.packageAuditTable.innerHTML = state.packageAudit
    .map((item) => `
      <tr>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td><span class="badge text-bg-secondary">${escapeHtml(item.action_type || "event")}</span></td>
        <td>${escapeHtml(item.package_code || "n/a")}</td>
        <td>${escapeHtml([item.tenant_code, item.vessel_code, item.username].filter(Boolean).join(" / ") || "global")}</td>
        <td>${escapeHtml([item.actor_username, item.actor_role].filter(Boolean).join(" · ") || "system")}</td>
      </tr>
    `)
    .join("");
}

function renderAssignmentDetailSection() {
  if (!elements.assignmentDetailShell) {
    return;
  }

  if (!state.selectedAssignmentId) {
    elements.assignmentDetailShell.innerHTML = `
      <div class="empty-state compact-empty-state">
        <h3>No assignment selected</h3>
        <p>Use the View button in the assignment table to open the lifecycle detail.</p>
      </div>
    `;
    if (elements.assignmentDetailPill) {
      elements.assignmentDetailPill.textContent = "None selected";
    }
    return;
  }

  const detail = state.assignmentDetail;
  if (!detail) {
    elements.assignmentDetailShell.innerHTML = `
      <div class="empty-state compact-empty-state">
        <h3>Loading assignment</h3>
        <p>Fetching lifecycle detail for assignment ${escapeHtml(state.selectedAssignmentId.slice(0, 8))}...</p>
      </div>
    `;
    if (elements.assignmentDetailPill) {
      elements.assignmentDetailPill.textContent = "Loading";
    }
    return;
  }

  const assignment = detail.assignment || {};
  const recentUsage = Array.isArray(detail.recent_usage) ? detail.recent_usage : [];
  const auditHistory = Array.isArray(detail.audit_history) ? detail.audit_history : [];
  const alerts = Array.isArray(detail.alerts) ? detail.alerts : [];
  const summary = detail.usage_summary || {};

  if (elements.assignmentDetailPill) {
    elements.assignmentDetailPill.textContent = `${assignment.package_code || "package"} · ${assignment.username || "user"}`;
  }

  elements.assignmentDetailShell.innerHTML = `
    <div class="detail-summary">
      <div class="detail-summary-header">
        <div>
          <h3>${escapeHtml(assignment.package_name || assignment.package_code || "Assignment")}</h3>
          <div class="tiny-note">${escapeHtml(assignment.username || "unknown")} · ${escapeHtml(assignment.vessel_code || "n/a")} · ${escapeHtml(assignment.tenant_name || assignment.tenant_code || "tenant")}</div>
        </div>
        <span class="badge text-bg-${assignment.is_active ? "success" : "secondary"}">${escapeHtml(assignment.status || "unknown")}</span>
      </div>
      <div class="detail-hero-meta">
        <span class="meta-chip"><strong>Assigned</strong> ${escapeHtml(formatDate(assignment.assigned_at))}</span>
        <span class="meta-chip"><strong>Expires</strong> ${escapeHtml(formatDate(assignment.expires_at))}</span>
        <span class="meta-chip"><strong>Remaining</strong> ${escapeHtml(formatDataVolumeMb(assignment.remaining_mb || 0))}</span>
        <span class="meta-chip"><strong>Usage</strong> ${escapeHtml(formatDataVolumeMb(summary.total_mb || 0))}</span>
      </div>
    </div>
    <div class="row g-3">
      ${renderInfoBox("Upload", formatDataVolumeMb(summary.upload_mb || 0), "bi bi-cloud-arrow-up-fill", "success", `${formatNumber(summary.samples || 0, 0)} usage samples`)}
      ${renderInfoBox("Download", formatDataVolumeMb(summary.download_mb || 0), "bi bi-cloud-arrow-down-fill", "warning", "Lifecycle total")}
      ${renderInfoBox("Alerts", formatNumber(alerts.length, 0), "bi bi-exclamation-triangle-fill", "danger", "Recent quota alerts")}
      ${renderInfoBox("Audit events", formatNumber(auditHistory.length, 0), "bi bi-journal-text", "primary", "Package history")}
    </div>
    <div class="row g-3 mt-2">
      <div class="col-lg-6">
        <div class="card card-outline card-secondary h-100">
          <div class="card-header"><h3 class="card-title mb-0">Recent usage</h3></div>
          <div class="card-body">
            ${renderListItems(
              recentUsage,
              (item) => `
                <li>
                  <strong>${escapeHtml(formatDate(item.observed_at))}</strong>
                  <div>${escapeHtml(item.session_id || "session")} · ${escapeHtml(item.vessel_code || "n/a")}</div>
                  <div>UL ${escapeHtml(formatDataVolumeMb(item.upload_mb || 0))} · DL ${escapeHtml(formatDataVolumeMb(item.download_mb || 0))}</div>
                </li>
              `,
              "No recent usage",
              "This assignment has not recorded usage yet."
            )}
          </div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card card-outline card-warning h-100">
          <div class="card-header"><h3 class="card-title mb-0">Lifecycle history</h3></div>
          <div class="card-body">
            ${renderListItems(
              auditHistory,
              (item) => `
                <li>
                  <strong>${escapeHtml(item.action_type || "event")}</strong>
                  <div>${escapeHtml(item.actor_username || "system")} · ${escapeHtml(item.actor_role || "n/a")}</div>
                  <div>${escapeHtml(formatDate(item.created_at))}</div>
                </li>
              `,
              "No lifecycle history",
              "Create, assign, update, and unassign events will appear here."
            )}
          </div>
        </div>
      </div>
      <div class="col-12">
        <div class="card card-outline card-info">
          <div class="card-header"><h3 class="card-title mb-0">Recent alerts</h3></div>
          <div class="card-body">
            ${renderListItems(
              alerts,
              (item) => `
                <li>
                  <strong>${escapeHtml(item.alert_type || "alert")}</strong>
                  <div>${escapeHtml(item.message || "No message")}</div>
                  <div>Remaining ${escapeHtml(formatDataVolumeMb(item.remaining_mb || 0))} · ${escapeHtml(formatDate(item.created_at))}</div>
                </li>
              `,
              "No alerts",
              "Quota alerts will appear here for the selected assignment."
            )}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderEndpointList() {
  if (!elements.endpointList) {
    return;
  }

  const selected = selectedEdge();
  const items = [
    {
      label: "API domain",
      href: currentApiOrigin()
    },
    {
      label: "Current workspace",
      href: buildAbsoluteUrl(currentWorkspacePath(), {
        tenant: state.filters.tenant,
        vessel: state.filters.vessel
      })
    },
    {
      label: "Open package catalog",
      href: buildAbsoluteUrl("/package-catalog", {
        tenant: state.filters.tenant,
        vessel: state.filters.vessel
      })
    },
    {
      label: "Health endpoint",
      href: buildAbsoluteUrl("/api/health")
    },
    {
      label: "Edges API",
      href: buildAbsoluteUrl("/api/mcu/edges", {
        tenant: state.filters.tenant,
        vessel: state.filters.vessel,
        limit: 50
      })
    },
    {
      label: "Usage report",
      href: buildAbsoluteUrl("/api/reports/usage", {
        tenant: state.filters.tenant,
        vessel: state.filters.vessel,
        window_minutes: 1440
      })
    }
  ];

  if (selected) {
    items.push({
      label: "Selected edge detail",
      href: buildAbsoluteUrl(
        `/api/mcu/edges/${encodeURIComponent(selected.tenant_code)}/${encodeURIComponent(selected.vessel_code)}/${encodeURIComponent(selected.edge_code)}`
      )
    });
    items.push({
      label: "Selected edge traffic",
      href: buildAbsoluteUrl(
        `/api/mcu/edges/${encodeURIComponent(selected.tenant_code)}/${encodeURIComponent(selected.vessel_code)}/${encodeURIComponent(selected.edge_code)}/traffic`,
        { window_minutes: 120 }
      )
    });
    items.push({
      label: "Selected edge commands",
      href: buildAbsoluteUrl("/api/commands", {
        tenant: selected.tenant_code,
        vessel: selected.vessel_code,
        edge: selected.edge_code,
        limit: 20
      })
    });
  }

  elements.endpointList.innerHTML = items
    .map(
      (item) => `
        <article class="endpoint-card">
          <span>${escapeHtml(item.label)}</span>
          <a href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer">${escapeHtml(item.href)}</a>
        </article>
      `
    )
    .join("");
}

function renderEdgeList() {
  setTextContent(elements.edgeCount, `${state.edges.length} devices`);

  if (!state.edges.length) {
    elements.edgeList.innerHTML = `
      <div class="p-3">
        <div class="callout callout-info mb-0">
          <h5>No assets found</h5>
          <p>Broaden the tenant or vessel filters to reveal more fleet data.</p>
        </div>
      </div>
    `;
    return;
  }

  elements.edgeList.innerHTML = `
    <div class="list-group list-group-flush">
      ${state.edges
    .map((edge) => {
      const selected = edgeKey(edge) === state.selectedEdgeKey;
      return `
        <button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-start ${selected ? "active" : ""}" data-edge-key="${escapeHtml(edgeKey(edge))}">
          <div class="me-3 text-start">
            <div class="fw-bold">${escapeHtml(edge.edge_code)}</div>
            <small class="${selected ? "text-white-50" : "text-muted"}">${escapeHtml(edge.tenant_code)} / ${escapeHtml(edge.vessel_code)}</small>
            <div class="mt-2 d-flex flex-wrap" style="gap: 6px;">
              <span class="badge text-bg-${edge.online ? "success" : "danger"}">${edge.online ? "Online" : "Offline"}</span>
              <span class="badge text-bg-secondary">Seen ${escapeHtml(formatDate(edge.telemetry_at || edge.heartbeat_at || edge.last_seen_at))}</span>
              <span class="badge text-bg-secondary">Uplink ${escapeHtml(edge.active_uplink || "No data")}</span>
              <span class="badge text-bg-secondary">Traffic ${escapeHtml(formatKbps(edge.throughput_kbps))}</span>
            </div>
          </div>
        </button>
      `;
    })
    .join("")}
    </div>
  `;

  elements.edgeList.querySelectorAll("[data-edge-key]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedEdgeKey = button.dataset.edgeKey || "";
      renderEndpointList();
      renderEdgeList();
      refreshSelectedEdge().catch(renderErrorState);
    });
  });
}

function computeTrafficSummary(samples) {
  const rx = samples.map((sample) => Number(sample.rx_kbps || 0));
  const tx = samples.map((sample) => Number(sample.tx_kbps || 0));
  const throughput = samples.map((sample) => Number(sample.throughput_kbps || 0));

  const average = (series) => (series.length ? series.reduce((sum, value) => sum + value, 0) / series.length : 0);
  const peak = (series) => (series.length ? Math.max(...series) : 0);

  return {
    avg_rx_kbps: average(rx),
    avg_tx_kbps: average(tx),
    avg_throughput_kbps: average(throughput),
    peak_rx_kbps: peak(rx),
    peak_tx_kbps: peak(tx),
    peak_throughput_kbps: peak(throughput)
  };
}

function linePath(values, width, height, topPadding, bottomPadding, maxValue) {
  if (!values.length) {
    return "";
  }

  const innerHeight = height - topPadding - bottomPadding;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  return values
    .map((value, index) => {
      const x = index * step;
      const y = topPadding + innerHeight - (Number(value || 0) / maxValue) * innerHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function linePathSparse(values, width, height, topPadding, bottomPadding, maxValue) {
  if (!values.length) {
    return "";
  }

  const innerHeight = height - topPadding - bottomPadding;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const segments = [];
  let segmentOpen = false;

  values.forEach((value, index) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      segmentOpen = false;
      return;
    }

    const x = index * step;
    const y = topPadding + innerHeight - (numeric / maxValue) * innerHeight;
    segments.push(`${segmentOpen ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    segmentOpen = true;
  });

  return segments.join(" ");
}

function getLatestNonNullValue(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const numeric = Number(values[index]);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function buildUplinkSeries(samples, keyword) {
  const values = [];
  let latestName = null;

  samples.forEach((sample) => {
    const interfaces = Array.isArray(sample?.interfaces) ? sample.interfaces : [];
    const matched = interfaces.find((iface) => classifyUplinkName(iface?.name) === keyword) || null;
    const throughput = Number(matched?.throughput_kbps);

    values.push(Number.isFinite(throughput) ? throughput : null);
    if (matched?.name) {
      latestName = String(matched.name).trim();
    }
  });

  return {
    label: latestName || (keyword === "starlink" ? "Starlink" : "VSAT"),
    values,
    latest: getLatestNonNullValue(values)
  };
}

function renderUplinkComparisonChart(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return `
      <div class="empty-state compact-empty-state">
        <h3>Chua co mau so sanh</h3>
        <p>Can co telemetry cho Starlink va VSAT de ve bieu do doi chieu.</p>
      </div>
    `;
  }

  const starlink = buildUplinkSeries(samples, "starlink");
  const vsat = buildUplinkSeries(samples, "vsat");
  const hasStarlink = starlink.values.some((value) => value !== null && value !== undefined);
  const hasVsat = vsat.values.some((value) => value !== null && value !== undefined);

  if (!hasStarlink && !hasVsat) {
    return `
      <div class="empty-state compact-empty-state">
        <h3>Chua co mau so sanh</h3>
        <p>Edge nay chua co interface Starlink hoac VSAT trong mau telemetry hien tai.</p>
      </div>
    `;
  }

  const width = 640;
  const height = 220;
  const topPadding = 18;
  const bottomPadding = 24;
  const maxValue = Math.max(
    1,
    ...starlink.values.map((value) => Number(value) || 0),
    ...vsat.values.map((value) => Number(value) || 0)
  );

  const gridLines = [0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = topPadding + (height - topPadding - bottomPadding) * ratio;
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4 8"></line>`;
  });

  const labels = samples
    .filter((_, index) => index === 0 || index === samples.length - 1 || index === Math.floor(samples.length / 2))
    .map((sample, index, items) => {
      const sourceIndex = samples.findIndex((item) => item.observed_at === sample.observed_at);
      const x = items.length === 1 ? width / 2 : (sourceIndex / (samples.length - 1 || 1)) * width;
      return `<text x="${x}" y="${height}" fill="rgba(169,189,216,0.86)" text-anchor="${index === 0 ? "start" : index === items.length - 1 ? "end" : "middle"}" font-size="11">${escapeHtml(new Date(sample.observed_at).toLocaleTimeString())}</text>`;
    });

  const starlinkLatest = getLatestNonNullValue(starlink.values);
  const vsatLatest = getLatestNonNullValue(vsat.values);
  const difference = starlinkLatest !== null && vsatLatest !== null ? starlinkLatest - vsatLatest : null;

  return `
    <svg class="chart-svg comparison-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Starlink and VSAT comparison chart">
      ${gridLines.join("")}
      <path d="${linePathSparse(starlink.values, width, height, topPadding, bottomPadding, maxValue)}" fill="none" stroke="#68e1fd" stroke-width="3"></path>
      <path d="${linePathSparse(vsat.values, width, height, topPadding, bottomPadding, maxValue)}" fill="none" stroke="#ff9d5c" stroke-width="3"></path>
      ${labels.join("")}
    </svg>
    <div class="comparison-metrics">
      <article class="comparison-metric">
        <span>Starlink now</span>
        <strong>${escapeHtml(formatKbps(starlinkLatest))}</strong>
        <div class="tiny-note">${escapeHtml(starlink.label)}</div>
      </article>
      <article class="comparison-metric">
        <span>VSAT now</span>
        <strong>${escapeHtml(formatKbps(vsatLatest))}</strong>
        <div class="tiny-note">${escapeHtml(vsat.label)}</div>
      </article>
      <article class="comparison-metric">
        <span>Gap</span>
        <strong>${escapeHtml(difference !== null ? formatKbps(Math.abs(difference)) : "No data")}</strong>
        <div class="tiny-note">${difference === null ? "Chua co ca hai du lieu" : difference >= 0 ? "Starlink dang cao hon" : "VSAT dang cao hon"}</div>
      </article>
    </div>
  `;
}

function renderTrafficChart(samples) {
  if (!samples.length) {
    return `
      <div class="empty-state">
        <h3>Chua co mau traffic</h3>
        <p>Edge nay chua gui telemetry hoac bo loc window hien tai chua co du lieu.</p>
      </div>
    `;
  }

  const width = 640;
  const height = 220;
  const topPadding = 18;
  const bottomPadding = 24;
  const throughput = samples.map((sample) => Number(sample.throughput_kbps || 0));
  const rx = samples.map((sample) => Number(sample.rx_kbps || 0));
  const tx = samples.map((sample) => Number(sample.tx_kbps || 0));
  const maxValue = Math.max(1, ...throughput, ...rx, ...tx);

  const gridLines = [0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = topPadding + (height - topPadding - bottomPadding) * ratio;
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4 8"></line>`;
  });

  const labels = samples
    .filter((_, index) => index === 0 || index === samples.length - 1 || index === Math.floor(samples.length / 2))
    .map((sample, index, items) => {
      const sourceIndex = samples.findIndex((item) => item.observed_at === sample.observed_at);
      const x = items.length === 1 ? width / 2 : (sourceIndex / (samples.length - 1 || 1)) * width;
      return `<text x="${x}" y="${height}" fill="rgba(169,189,216,0.86)" text-anchor="${index === 0 ? "start" : index === items.length - 1 ? "end" : "middle"}" font-size="11">${escapeHtml(new Date(sample.observed_at).toLocaleTimeString())}</text>`;
    });

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Traffic chart">
      <defs>
        <linearGradient id="throughputGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="rgba(104,225,253,0.28)"></stop>
          <stop offset="100%" stop-color="rgba(104,225,253,0.02)"></stop>
        </linearGradient>
      </defs>
      ${gridLines.join("")}
      <path d="${linePath(throughput, width, height, topPadding, bottomPadding, maxValue)}" fill="none" stroke="#68e1fd" stroke-width="3"></path>
      <path d="${linePath(rx, width, height, topPadding, bottomPadding, maxValue)}" fill="none" stroke="#53e2a1" stroke-width="2.25"></path>
      <path d="${linePath(tx, width, height, topPadding, bottomPadding, maxValue)}" fill="none" stroke="#ff9d5c" stroke-width="2.25"></path>
      ${labels.join("")}
    </svg>
  `;
}

function summarizePortSeries(samples) {
  const portMap = new Map();

  samples.forEach((sample) => {
    const interfaces = Array.isArray(sample?.interfaces) ? sample.interfaces : [];
    interfaces.forEach((iface) => {
      const name = String(iface?.name || "").trim();
      if (!name) {
        return;
      }

      const entry = portMap.get(name) || {
        name,
        samples: [],
        latestTotalGb: null,
        latestRxKbps: null,
        latestTxKbps: null,
        latestThroughputKbps: null,
        maxThroughputKbps: 0
      };

      const throughput = Number(iface?.throughput_kbps || 0);
      const rx = Number(iface?.rx_kbps || 0);
      const tx = Number(iface?.tx_kbps || 0);
      const totalGb = Number(iface?.total_gb);

      entry.samples.push({
        observed_at: sample.observed_at,
        throughput_kbps: Number.isFinite(throughput) ? throughput : 0
      });
      entry.latestThroughputKbps = Number.isFinite(throughput) ? throughput : null;
      entry.latestRxKbps = Number.isFinite(rx) ? rx : null;
      entry.latestTxKbps = Number.isFinite(tx) ? tx : null;
      entry.latestTotalGb = Number.isFinite(totalGb) ? totalGb : entry.latestTotalGb;
      entry.maxThroughputKbps = Math.max(entry.maxThroughputKbps, Number.isFinite(throughput) ? throughput : 0);

      portMap.set(name, entry);
    });
  });

  return Array.from(portMap.values())
    .sort((left, right) => {
      const rightWeight = Number(right.latestTotalGb ?? right.maxThroughputKbps ?? 0);
      const leftWeight = Number(left.latestTotalGb ?? left.maxThroughputKbps ?? 0);
      return rightWeight - leftWeight;
    });
}

function renderPortSparkline(values, stroke) {
  if (!values.length) {
    return "";
  }

  const width = 240;
  const height = 72;
  const path = linePath(values, width, height, 8, 8, Math.max(1, ...values));

  return `
    <svg class="port-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2.5"></path>
    </svg>
  `;
}

function renderPortCharts(samples, activeUplink) {
  const ports = summarizePortSeries(samples);

  if (!ports.length) {
    return `
      <div class="empty-state compact-empty-state">
        <h3>Chua co chart tung port</h3>
        <p>Can them telemetry theo interface de ve bieu do theo tung cong.</p>
      </div>
    `;
  }

  const palette = ["#68e1fd", "#53e2a1", "#ff9d5c", "#ff6f91", "#ffd166", "#b892ff"];

  return `
    <div class="port-chart-grid">
      ${ports
        .map((port, index) => {
          const color = palette[index % palette.length];
          const values = port.samples.map((sample) => Number(sample.throughput_kbps || 0));
          const isActive = activeUplink && port.name === activeUplink;
          return `
            <article class="port-chart-card">
              <div class="port-chart-header">
                <div class="port-name-cell">
                  <strong>${escapeHtml(port.name)}</strong>
                  ${isActive ? '<span class="port-active-chip">Active</span>' : ""}
                </div>
                <span class="tiny-note">Peak ${escapeHtml(formatKbps(port.maxThroughputKbps))}</span>
              </div>
              ${renderPortSparkline(values, color)}
              <div class="port-chart-metrics">
                <span><strong>Now</strong> ${escapeHtml(formatKbps(port.latestThroughputKbps))}</span>
                <span><strong>RX</strong> ${escapeHtml(formatKbps(port.latestRxKbps))}</span>
                <span><strong>TX</strong> ${escapeHtml(formatKbps(port.latestTxKbps))}</span>
                <span><strong>Total</strong> ${escapeHtml(formatDataVolumeGb(port.latestTotalGb))}</span>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderUplinkPolicyCard(policy) {
  if (!policy) {
    return `
      <div class="empty-state compact-empty-state">
        <h3>Chua co policy uplink</h3>
        <p>Telemetry hien tai chua du de xac lap VSAT va Starlink.</p>
      </div>
    `;
  }

  const activeRoleLabel =
    policy.activeRole === "vsat" ? "Work" : policy.activeRole === "starlink" ? "Entertainment" : "Unknown";

  const renderPolicyItem = (entry, accentClass) => `
    <article class="policy-item ${accentClass}">
      <div class="policy-item-header">
        <span class="policy-kicker">${escapeHtml(entry.label)}</span>
        <span class="policy-status policy-status-${entry.status}">${escapeHtml(entry.status)}</span>
      </div>
      <strong>${escapeHtml(entry.preferred)}</strong>
      <div class="policy-interface">${escapeHtml(entry.interfaceName || "No data")}</div>
      <p>${escapeHtml(entry.note)}</p>
    </article>
  `;

  return `
    <div class="policy-grid">
      ${renderPolicyItem(policy.work, "policy-work")}
      ${renderPolicyItem(policy.entertainment, "policy-entertainment")}
    </div>
    <div class="policy-summary">
      <span class="tiny-note">Current active uplink role</span>
      <strong>${escapeHtml(activeRoleLabel)}</strong>
      <span class="tiny-note">
        ${escapeHtml(policy.activeInterface ? `Active interface: ${policy.activeInterface}` : "No active interface detected")}
      </span>
    </div>
  `;
}

function renderListItems(items, renderItem, emptyTitle, emptyText) {
  if (!items.length) {
    return `
      <div class="empty-state">
        <h3>${escapeHtml(emptyTitle)}</h3>
        <p>${escapeHtml(emptyText)}</p>
      </div>
    `;
  }

  return `<ul class="list-unstyled mb-0">${items.map(renderItem).join("")}</ul>`;
}

function renderInfoBox(label, value, icon, color, note = "") {
  return `
    <div class="col-12 col-md-6 col-xl-3">
      <div class="info-box bg-${escapeHtml(color)}">
        <span class="info-box-icon">
          <i class="${escapeHtml(icon)}"></i>
        </span>
        <div class="info-box-content">
          <span class="info-box-text">${escapeHtml(label)}</span>
          <span class="info-box-number">${escapeHtml(value)}</span>
          ${note ? `<small class="text-white-50">${escapeHtml(note)}</small>` : ""}
        </div>
      </div>
    </div>
  `;
}

function humanizeCommandType(commandType) {
  const normalized = String(commandType || "").trim();
  const lookup = {
    failover_starlink: "Switch to Starlink",
    failback_vsat: "Switch to VSAT",
    restore_automatic: "Restore automatic",
    policy_sync: "Sync policy"
  };

  return lookup[normalized] || normalized.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()) || "Command";
}

function commandStatusBadgeClass(status) {
  switch (String(status || "").toLowerCase()) {
    case "success":
      return "text-bg-success";
    case "failed":
      return "text-bg-danger";
    case "ack":
      return "text-bg-info";
    case "sent":
      return "text-bg-warning";
    case "queued":
    default:
      return "text-bg-secondary";
  }
}

function hasPendingCommandJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return false;
  }

  return jobs.some((job) => {
    const status = String(job?.status || "").toLowerCase();
    return status === "queued" || status === "sent" || status === "ack";
  });
}

function summarizeCommandJobs(jobs) {
  const summary = {
    total: 0,
    pending: 0,
    success: 0,
    failed: 0,
    latestStatus: "none",
    latestAt: null
  };

  if (!Array.isArray(jobs)) {
    return summary;
  }

  summary.total = jobs.length;
  jobs.forEach((job) => {
    const status = String(job?.status || "").toLowerCase();
    if (["queued", "sent", "ack"].includes(status)) {
      summary.pending += 1;
    }
    if (status === "success") {
      summary.success += 1;
    }
    if (status === "failed") {
      summary.failed += 1;
    }
  });

  const latest = jobs[0] || null;
  summary.latestStatus = String(latest?.status || "none").toLowerCase();
  summary.latestAt = latest?.created_at || latest?.result_at || latest?.ack_at || null;
  return summary;
}

function isCommandableEdge(edge) {
  return Boolean(edge);
}

function commandActionDefinition(action) {
  const actions = {
    failback_vsat: {
      label: "Switch to VSAT",
      description: "Move primary work traffic back to VSAT.",
      icon: "bi-router-fill",
      command_type: "failback_vsat",
      command_payload: {
        preferred_uplink: "vsat",
        scope: "critical"
      },
      confirm: "Send a command to prefer VSAT for critical traffic?"
    },
    failover_starlink: {
      label: "Switch to Starlink",
      description: "Move backup or critical traffic to Starlink.",
      icon: "bi-stars",
      command_type: "failover_starlink",
      command_payload: {
        preferred_uplink: "starlink",
        scope: "critical"
      },
      confirm: "Send a command to prefer Starlink for critical traffic?"
    },
    policy_sync: {
      label: "Sync policy",
      description: "Push the current uplink policy to the edge box.",
      icon: "bi-arrow-repeat",
      command_type: "policy_sync",
      command_payload: {
        scope: "uplink_policy"
      },
      confirm: "Sync the current policy to this edge box?"
    },
    restore_automatic: {
      label: "Restore automatic",
      description: "Return the edge box to automatic policy handling.",
      icon: "bi-diagram-3-fill",
      command_type: "restore_automatic",
      command_payload: {
        mode: "automatic"
      },
      confirm: "Restore automatic handling on this edge box?"
    }
  };

  return actions[action] || null;
}

function renderCommandFeedback() {
  const feedback = state.commandFeedback;
  if (!feedback) {
    return "";
  }

  const className = feedback.kind === "success" ? "alert-success" : feedback.kind === "danger" ? "alert-danger" : "alert-info";
  return `
    <div class="alert ${className} command-feedback mb-3" role="status">
      ${escapeHtml(feedback.text)}
    </div>
  `;
}

function renderCommandJobsList(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return `
      <div class="empty-state compact-empty-state">
        <h3>No command jobs yet</h3>
        <p>Commands issued from this dashboard will show up here as they move through queued, sent, ack, and result states.</p>
      </div>
    `;
  }

  return `
    <div class="command-job-list">
      ${jobs
        .map((job) => {
          const statusClass = commandStatusBadgeClass(job.status);
          const statusLabel = String(job.status || "queued").toUpperCase();
          const payloadSummary = formatCompactValue(
            Object.entries(job.command_payload || {}).map(([key, value]) => `${key}: ${formatCompactValue(value, 48)}`).join(" · "),
            180
          );
          const resultSummary = job.result_payload && typeof job.result_payload === "object"
            ? formatCompactValue(
                Object.entries(job.result_payload)
                  .filter(([key, value]) => value !== null && value !== undefined && key !== "result_payload")
                  .slice(0, 3)
                  .map(([key, value]) => `${key}: ${formatCompactValue(value, 48)}`)
                  .join(" · "),
                180
              )
            : "";

          return `
            <article class="command-job-item">
              <div class="command-job-header">
                <div>
                  <strong>${escapeHtml(humanizeCommandType(job.command_type))}</strong>
                  <div class="tiny-note">${escapeHtml(job.command_type || "command")} · ${escapeHtml(job.id.slice(0, 8))}</div>
                </div>
                <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
              </div>
              <div class="command-job-meta">
                <span><strong>Created</strong> ${escapeHtml(formatDate(job.created_at))}</span>
                ${job.ack_at ? `<span><strong>Ack</strong> ${escapeHtml(formatDate(job.ack_at))}</span>` : ""}
                ${job.result_at ? `<span><strong>Result</strong> ${escapeHtml(formatDate(job.result_at))}</span>` : ""}
              </div>
              <div class="tiny-note">${escapeHtml(payloadSummary || "No payload details")}</div>
              ${resultSummary ? `<div class="command-job-result tiny-note">${escapeHtml(resultSummary)}</div>` : ""}
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCommandCenterCard() {
  const selected = selectedEdge();
  if (!selected) {
    return "";
  }

  const commandSummary = summarizeCommandJobs(state.commandJobs);
  const jobPollingActive = hasPendingCommandJobs(state.commandJobs);

  const buttons = [
    "failback_vsat",
    "failover_starlink",
    "policy_sync",
    "restore_automatic"
  ]
    .map((action) => {
      const definition = commandActionDefinition(action);
      if (!definition) {
        return "";
      }

      const isBusy = state.commandBusyAction === action;
      return `
        <button
          type="button"
          class="btn btn-outline-light command-action-btn"
          data-command-action="${escapeHtml(action)}"
          ${isBusy ? "disabled" : ""}
        >
          <span class="command-action-icon"><i class="bi ${escapeHtml(definition.icon)}"></i></span>
          <span class="command-action-main">
            <span class="command-action-title">${escapeHtml(definition.label)}</span>
            <span class="command-action-desc">${escapeHtml(definition.description)}</span>
          </span>
          <i class="bi bi-chevron-right command-action-arrow"></i>
        </button>
      `;
    })
    .join("");

  return `
    <div class="card card-outline card-danger mt-3 command-center-card">
      <div class="card-header d-flex align-items-center justify-content-between">
        <div class="d-flex flex-column">
          <h3 class="card-title mb-0">Command center</h3>
          <span class="tiny-note">${escapeHtml(selected.edge_code)} ready for control actions</span>
        </div>
        <span class="badge text-bg-danger">Live control</span>
      </div>
      <div class="card-body">
        <p class="chart-note mb-3">
          Commands publish to the selected edge box and are tracked until ack/result comes back.
        </p>
        <div class="command-summary-row mb-3">
          <span class="command-summary-chip"><strong>${escapeHtml(String(commandSummary.total))}</strong> tracked</span>
          <span class="command-summary-chip"><strong>${escapeHtml(String(commandSummary.pending))}</strong> pending</span>
          <span class="command-summary-chip"><strong>${escapeHtml(String(commandSummary.success))}</strong> success</span>
          <span class="command-summary-chip"><strong>${escapeHtml(String(commandSummary.failed))}</strong> failed</span>
          <span class="command-summary-chip command-summary-chip-muted"><strong>${escapeHtml(commandSummary.latestStatus.toUpperCase())}</strong> latest</span>
        </div>
        <div class="tiny-note mb-3">
          ${selected.online
            ? "Edge is online. Commands are enabled and live polling stays active while jobs are pending."
            : "Edge looks offline or stale, but commands stay enabled for recovery actions."}
        </div>
        ${renderCommandFeedback()}
        <div class="command-center-grid">
          <section class="command-action-panel command-action-panel-primary">
            <div class="command-panel-head">
              <h4>Quick actions</h4>
              <span class="tiny-note">${escapeHtml(commandSummary.latestAt ? `Latest ${formatDate(commandSummary.latestAt)}` : "No jobs yet")}</span>
            </div>
            <div class="command-action-list">
              ${buttons}
            </div>
          </section>
          <section class="command-history-panel">
            <div class="command-panel-head">
              <h4>Recent jobs</h4>
              <span class="tiny-note">${escapeHtml(String(state.commandJobs.length))} tracked${jobPollingActive ? " · polling" : ""}</span>
            </div>
            ${renderCommandJobsList(state.commandJobs.slice(0, 5))}
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderDetail() {
  const detail = state.detail;
  const traffic = state.traffic;

  if (!detail) {
    elements.detailShell.innerHTML = `
      <div class="empty-state">
        <h3>Khong co chi tiet</h3>
        <p>Edge duoc chon chua co du lieu detail de hien thi.</p>
      </div>
    `;
    return;
  }

  const summary = detail.summary || {};
  const latestHeartbeat = detail.latest?.heartbeat || {};
  const latestTelemetry = detail.latest?.telemetry || {};
  const trafficSamples = Array.isArray(traffic?.samples) ? traffic.samples : [];
  const usage24h = detail.usage_24h || {};
  const usageOverview = detail.usage_overview || {};
  const totalUsageMb24h = Number(usage24h.upload_mb_24h || 0) + Number(usage24h.download_mb_24h || 0);
  const cumulativeTelemetryGb = extractTelemetryTotalGb(latestTelemetry, traffic);
  const interfaceUsage = extractTelemetryInterfaces(latestTelemetry, traffic);
  const uplinkResolution = resolveUplinkDisplay(latestTelemetry.active_uplink, interfaceUsage);
  const activeInterfaceName = uplinkResolution.matchedName || uplinkResolution.displayName || latestTelemetry.active_uplink;
  const activeInterfaceTotalGb = findInterfaceTotalGb(interfaceUsage, activeInterfaceName);
  const latestUsageAt = usageOverview.latest_usage_at || null;
  const uplinkPolicy = resolveUplinkPolicy(interfaceUsage, latestTelemetry.active_uplink, detail.uplink_policy);

  setTextContent(elements.detailTitle, summary.edge_code || "Edge detail");
  setTextContent(elements.detailMeta, `${summary.tenant_code || "-"} / ${summary.vessel_code || "-"} / direct Ethernet`);
  renderEndpointList();

  elements.detailShell.innerHTML = `
    <div class="card card-outline card-primary">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(summary.edge_code || "Unknown edge")}</h3>
          <p>${escapeHtml(summary.tenant_name || summary.tenant_code || "Unknown tenant")} / ${escapeHtml(summary.vessel_name || summary.vessel_code || "Unknown vessel")}</p>
        </div>
        ${statusMarkup(summary.online)}
      </div>
      <div class="card-body">
        <div class="detail-hero-meta">
        <span class="meta-chip"><strong>Firmware</strong> ${escapeHtml(summary.edge_firmware_version || latestHeartbeat.firmware_version || "Unknown")}</span>
        <span class="meta-chip"><strong>Last seen</strong> ${escapeHtml(formatDate(latestTelemetry.observed_at || summary.last_seen_at || latestHeartbeat.observed_at))}</span>
        <span class="meta-chip"><strong>Uplink</strong> ${escapeHtml(uplinkResolution.displayName)}</span>
        ${uplinkResolution.rawLabel && uplinkResolution.rawLabel !== uplinkResolution.displayName ? `<span class="meta-chip"><strong>Reported</strong> ${escapeHtml(uplinkResolution.rawLabel)}</span>` : ""}
        </div>
      </div>
    </div>

    <div class="row g-3">
      ${renderInfoBox("Current throughput", formatKbps(latestTelemetry.throughput_kbps), "bi bi-speedometer2", "info", formatDate(latestTelemetry.observed_at))}
      ${renderInfoBox("Active uplink", uplinkResolution.displayName, "bi bi-diagram-3-fill", "primary", uplinkResolution.rawLabel && uplinkResolution.rawLabel !== uplinkResolution.displayName ? `Reported as ${uplinkResolution.rawLabel}` : activeInterfaceName ? `Matched interface ${activeInterfaceName}` : "No additional uplink data")}
      ${renderInfoBox("Active port total", activeInterfaceTotalGb != null ? formatDataVolumeGb(activeInterfaceTotalGb) : cumulativeTelemetryGb != null ? formatDataVolumeGb(cumulativeTelemetryGb) : formatDataVolumeMb(totalUsageMb24h), "bi bi-hdd-stack-fill", "success", "From telemetry and usage history")}
      ${renderInfoBox("Packet loss", formatPercent(latestTelemetry.loss_pct), "bi bi-exclamation-triangle-fill", "warning", "Current sample window")}
    </div>

    <div class="card card-outline card-info mt-3">
      <div class="card-header d-flex align-items-center justify-content-between">
        <h3 class="card-title mb-0">Traffic timeline</h3>
        <div class="legend">
          <span style="color:#68e1fd">Throughput</span>
          <span style="color:#53e2a1">RX</span>
          <span style="color:#ff9d5c">TX</span>
        </div>
      </div>
      <div class="card-body">
        ${renderTrafficChart(trafficSamples)}
      </div>
    </div>

    <div class="card card-outline card-warning">
      <div class="card-header">
        <h3 class="card-title mb-0">Uplink priority</h3>
      </div>
      <div class="card-body">
        ${renderUplinkPolicyCard(uplinkPolicy)}
      </div>
    </div>

    ${renderCommandCenterCard()}

    <div class="card card-outline card-secondary collapsed-card">
      <div class="card-header">
        <h3 class="card-title mb-0">Supporting detail</h3>
        <div class="card-tools">
          <button type="button" class="btn btn-tool" data-app-toggle-card>
            <i class="bi bi-plus-lg"></i>
          </button>
        </div>
      </div>
      <div class="card-body">
        <div class="card card-outline card-info">
          <div class="card-header d-flex align-items-center justify-content-between">
            <h3 class="card-title mb-0">Starlink vs VSAT</h3>
            <div class="legend">
              <span style="color:#68e1fd">Starlink</span>
              <span style="color:#ff9d5c">VSAT</span>
            </div>
          </div>
          <div class="card-body">
            ${renderUplinkComparisonChart(trafficSamples)}
          </div>
        </div>

        <div class="card card-outline card-secondary mt-3">
          <div class="card-header">
            <h3 class="card-title mb-0">Port usage breakdown</h3>
          </div>
          <div class="card-body">
            ${renderInterfaceUsage(interfaceUsage, activeInterfaceName)}
          </div>
        </div>

        <div class="row g-3 mt-3">
          <div class="col-lg-3">
            <div class="card card-outline card-secondary h-100">
              <div class="card-header">
                <h3 class="card-title mb-0">Recent events</h3>
                <span class="badge text-bg-secondary float-end">${escapeHtml(String(detail.recent_events?.length || 0))}</span>
              </div>
              <div class="card-body">
                ${renderListItems(
                  detail.recent_events || [],
                  (item) => `
                    <li>
                      <strong>${escapeHtml(item.event_type || "event")}</strong>
                      <div>${escapeHtml(item.severity || "unknown")} · ${escapeHtml(formatDate(item.observed_at))}</div>
                    </li>
                  `,
                  "No events",
                  "This edge has not emitted recent events."
                )}
              </div>
            </div>
          </div>

          <div class="col-lg-3">
            <div class="card card-outline card-secondary h-100">
              <div class="card-header">
                <h3 class="card-title mb-0">Ingest errors</h3>
                <span class="badge text-bg-secondary float-end">${escapeHtml(String(detail.ingest_errors?.length || 0))}</span>
              </div>
              <div class="card-body">
                ${renderListItems(
                  detail.ingest_errors || [],
                  (item) => `
                    <li>
                      <strong>${escapeHtml(item.reason || "error")}</strong>
                      <div>${escapeHtml(item.detail || "No detail")}</div>
                      <div>${escapeHtml(formatDate(item.created_at))}</div>
                    </li>
                  `,
                  "No ingest errors",
                  "The pipeline is currently receiving clean records."
                )}
              </div>
            </div>
          </div>

          <div class="col-lg-3">
            <div class="card card-outline card-secondary h-100">
              <div class="card-header">
                <h3 class="card-title mb-0">Top users 24h</h3>
                <span class="badge text-bg-secondary float-end">${escapeHtml(String(detail.top_users_24h?.length || 0))}</span>
              </div>
              <div class="card-body">
                ${latestUsageAt ? `<p class="chart-note">No usage in the last 24h. Latest record: ${escapeHtml(formatDate(latestUsageAt))}.</p>` : ""}
                ${renderListItems(
                  detail.top_users_24h || [],
                  (item) => `
                    <li>
                      <strong>${escapeHtml(item.username || "unknown")}</strong>
                      <div>DL ${escapeHtml(formatNumber(item.download_mb, 2))} MB · UL ${escapeHtml(formatNumber(item.upload_mb, 2))} MB</div>
                      <div>${escapeHtml(formatDate(item.last_seen))}</div>
                    </li>
                  `,
                  "No usage data in 24h",
                  latestUsageAt
                    ? "Historical usage exists, but nothing landed in the last 24 hours."
                    : "No user traffic recorded in the last 24 hours."
                )}
              </div>
            </div>
          </div>

          <div class="col-lg-3">
            <div class="card card-outline card-warning h-100">
              <div class="card-header">
                <h3 class="card-title mb-0">Quota alerts</h3>
                <span class="badge text-bg-warning float-end">${escapeHtml(String(detail.recent_alerts?.length || 0))}</span>
              </div>
              <div class="card-body">
                ${renderListItems(
                  detail.recent_alerts || [],
                  (item) => `
                    <li>
                      <strong>${escapeHtml(item.alert_type || "alert")}</strong>
                      <div>${escapeHtml(item.message || "No message")}</div>
                      <div>Remaining ${escapeHtml(formatDataVolumeMb(item.remaining_mb))}</div>
                      <div>${escapeHtml(formatDate(item.created_at))}</div>
                    </li>
                  `,
                  "No quota alerts",
                  "Quota usage is still within healthy limits."
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function mergeLiveTelemetry(telemetry) {
  if (!state.detail) {
    return;
  }

  const normalizedTelemetry = {
    ...telemetry,
    active_uplink: telemetry.active_uplink || telemetry.active_interface || null
  };

  state.detail.latest = state.detail.latest || {};
  state.detail.latest.telemetry = normalizedTelemetry;
  state.detail.summary = state.detail.summary || {};
  state.detail.summary.last_seen_at = normalizedTelemetry.observed_at;
  state.detail.summary.online = isRecentTimestamp(normalizedTelemetry.observed_at, 120);

  const summary = selectedEdge();
  if (summary) {
    summary.throughput_kbps = normalizedTelemetry.throughput_kbps;
    summary.active_uplink = normalizedTelemetry.active_uplink;
    summary.telemetry_at = normalizedTelemetry.observed_at;
    summary.last_seen_at = normalizedTelemetry.observed_at;
    summary.online = isRecentTimestamp(normalizedTelemetry.observed_at, 120);
  }

  if (!state.traffic) {
    state.traffic = {
      samples: [],
      summary: {}
    };
  }

  const nextSample = {
    observed_at: normalizedTelemetry.observed_at,
    rx_kbps: normalizedTelemetry.rx_kbps,
    tx_kbps: normalizedTelemetry.tx_kbps,
    throughput_kbps: normalizedTelemetry.throughput_kbps,
    active_interface: normalizedTelemetry.active_uplink,
    interfaces: Array.isArray(normalizedTelemetry.interfaces) ? normalizedTelemetry.interfaces : []
  };

  const existing = new Map((state.traffic.samples || []).map((sample) => [sample.observed_at, sample]));
  existing.set(nextSample.observed_at, nextSample);
  const samples = Array.from(existing.values())
    .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime())
    .slice(-180);

  state.traffic.samples = samples;
  state.traffic.latest = nextSample;
  state.traffic.summary = computeTrafficSummary(samples);
}

function closeSse() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  state.streamStatus = "idle";
  setStatusPill(elements.streamPill, "Idle", "muted");
}

function connectSse(edge) {
  closeSse();
  if (!edge) {
    return;
  }

  const path = `/api/mcu/edges/${encodeURIComponent(edge.tenant_code)}/${encodeURIComponent(edge.vessel_code)}/${encodeURIComponent(edge.edge_code)}/stream`;
  const source = new EventSource(path);
  state.sse = source;
  state.streamStatus = "connecting";
  setStatusPill(elements.streamPill, "Connecting", "loading");

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "connected") {
        state.streamStatus = "live";
        setStatusPill(elements.streamPill, "Live", "good");
        return;
      }

      if (payload.type === "telemetry" && payload.data) {
        mergeLiveTelemetry(payload.data);
        renderEdgeList();
        renderDetail();
      }
    } catch (error) {
      console.error("[dashboard/sse] parse failed:", error);
    }
  };

  source.onerror = () => {
    state.streamStatus = "retrying";
    setStatusPill(elements.streamPill, "Retrying", "warn");
  };
}

async function refreshSelectedEdge() {
  const edge = selectedEdge();
  if (!edge) {
    state.detail = null;
    state.traffic = null;
    state.commandJobs = [];
    state.commandFeedback = null;
    setCommandPollTimer();
    closeSse();
    renderDetail();
    return;
  }

  const detailPath = `/api/mcu/edges/${encodeURIComponent(edge.tenant_code)}/${encodeURIComponent(edge.vessel_code)}/${encodeURIComponent(edge.edge_code)}`;
  const trafficPath = `${detailPath}/traffic?window_minutes=120&limit=180`;

  const commandPath = `/api/commands?${createQueryString({
    tenant: edge.tenant_code,
    vessel: edge.vessel_code,
    edge: edge.edge_code,
    limit: 10
  })}`;

  const [detail, traffic, commandJobs] = await Promise.all([
    fetchJson(detailPath),
    fetchJson(trafficPath),
    fetchJson(commandPath).catch(() => ({ items: [] }))
  ]);
  state.detail = detail;
  state.traffic = traffic;
  state.commandJobs = Array.isArray(commandJobs?.items) ? commandJobs.items : [];
  setCommandPollTimer();
  renderDetail();
  connectSse(edge);
}

async function sendCommand(action) {
  const edge = selectedEdge();
  const definition = commandActionDefinition(action);
  if (!edge || !definition) {
    return;
  }

  if (!window.confirm(definition.confirm)) {
    return;
  }

  state.commandBusyAction = action;
  state.commandFeedback = {
    kind: "info",
    text: `Sending ${definition.label} to ${edge.edge_code}...`
  };
  renderDetail();

  try {
    const response = await apiFetch("/api/commands", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        tenant_code: edge.tenant_code,
        vessel_code: edge.vessel_code,
        edge_code: edge.edge_code,
        command_type: definition.command_type,
        command_payload: definition.command_payload
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Session expired or unauthorized. Please sign in again.");
      }
      if (response.status === 403) {
        throw new Error("You do not have permission to send this command.");
      }
      throw new Error(payload?.error || response.statusText || "command_request_failed");
    }

    state.commandFeedback = {
      kind: "success",
      text: `${definition.label} queued. Command job ${payload.command?.id || "created"} is now ${payload.command?.status || "sent"}.`
    };

    await refreshSelectedEdge();
    setCommandPollTimer();
    window.setTimeout(() => {
      refreshSelectedEdge().catch(renderErrorState);
    }, 1200);
  } catch (error) {
    state.commandFeedback = {
      kind: "danger",
      text: error.message || "Unable to send command"
    };
    renderDetail();
  } finally {
    state.commandBusyAction = null;
    renderDetail();
  }
}

function setCommandPollTimer() {
  if (state.commandPollTimer) {
    window.clearTimeout(state.commandPollTimer);
    state.commandPollTimer = null;
  }

  if (!selectedEdge() || !hasPendingCommandJobs(state.commandJobs)) {
    return;
  }

  state.commandPollTimer = window.setTimeout(() => {
    refreshSelectedEdge().catch(renderErrorState);
  }, 3000);
}

function renderErrorState(error) {
  console.error("[dashboard] failed:", error);
  elements.detailShell.innerHTML = `
    <div class="empty-state">
      <h3>Khong tai duoc du lieu</h3>
      <p>${escapeHtml(error.message || "Unknown error")}</p>
    </div>
  `;
}

function applyWorkspaceMode() {
  syncWorkspaceLinks();

  document.body.classList.toggle("package-catalog-workspace", isPackageCatalogWorkspace);

  const headerTitle = document.querySelector(".app-content-header h1");
  const headerSubtitle = document.querySelector(".app-content-header p.text-muted");
  const breadcrumbActive = document.querySelector(".breadcrumb .breadcrumb-item.active");
  document.querySelectorAll(".sidebar-menu .nav-link").forEach((link) => {
    link.classList.remove("active");
  });
  const activeLink = isPackageCatalogWorkspace
    ? document.querySelector('.sidebar-menu a[href="/package-catalog"]')
    : document.querySelector('.sidebar-menu a[href="#summary-section"]');
  activeLink?.classList.add("active");

  if (isPackageCatalogWorkspace) {
    document.title = "Package Catalog - MCU Fleet Monitor";
    document.querySelector("#packages-section")?.removeAttribute("hidden");
    document.querySelector("#usage-section")?.toggleAttribute("hidden", !state.reportFilters.advanced);
    document.querySelector("#summary-section")?.setAttribute("hidden", "hidden");
    document.querySelector("#detail-section")?.setAttribute("hidden", "hidden");
    if (headerTitle) {
      headerTitle.textContent = "Package catalog";
    }
    if (headerSubtitle) {
      headerSubtitle.textContent = "Package lifecycle, assignment control, and usage aggregation in one workspace.";
    }
    if (breadcrumbActive) {
      breadcrumbActive.textContent = "Workspace";
    }
    window.setTimeout(() => {
      document.querySelector("#packages-section")?.scrollIntoView({ behavior: "auto", block: "start" });
    }, 0);
  } else {
    document.title = "Executive Fleet Monitor";
    document.querySelector("#summary-section")?.removeAttribute("hidden");
    document.querySelector("#detail-section")?.removeAttribute("hidden");
    if (headerTitle) {
      headerTitle.textContent = "Executive summary";
    }
    if (headerSubtitle) {
      headerSubtitle.textContent = "Fleet scope, uptime, policy, and selected asset detail.";
    }
    if (breadcrumbActive) {
      breadcrumbActive.textContent = "Executive";
    }
    document.querySelector("#packages-section")?.remove();
    document.querySelector("#usage-section")?.remove();
  }
}

function setRefreshTimer() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (!state.autoRefreshSeconds) {
    return;
  }

  state.refreshTimer = window.setInterval(() => {
    refreshAll().catch(renderErrorState);
  }, state.autoRefreshSeconds * 1000);
}

async function refreshAll() {
  await Promise.all([
    loadHealth(),
    loadEdges(),
    loadPackages(),
    loadUsageReport(),
    loadPackageAudit(),
    loadAssignmentDetail()
  ]);
  await refreshSelectedEdge();
}

function bindEvents() {
  document.querySelectorAll("[data-app-toggle-sidebar]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      document.body.classList.toggle("sidebar-collapsed");
    });
  });

  elements.detailShell.addEventListener("click", (event) => {
    const cardToggle = event.target.closest("[data-app-toggle-card]");
    if (cardToggle) {
      event.preventDefault();
      const card = cardToggle.closest(".card");
      if (card) {
        card.classList.toggle("collapsed-card");
        const icon = cardToggle.querySelector("i");
        if (icon) {
          icon.classList.toggle("bi-plus-lg");
          icon.classList.toggle("bi-dash-lg");
        }
      }
      return;
    }

    const button = event.target.closest("[data-command-action]");
    if (!button) {
      const packageButton = event.target.closest("[data-package-assign]");
      if (!packageButton) {
        return;
      }
      event.preventDefault();
      assignPackage(packageButton.dataset.packageAssign || "").catch(renderErrorState);
      return;
    }

    event.preventDefault();
    const action = button.dataset.commandAction;
    sendCommand(action).catch(renderErrorState);
  });

  elements.packageList?.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-package-edit]");
    if (editButton) {
      event.preventDefault();
      beginPackageEdit(editButton.dataset.packageEdit || "");
      return;
    }

    const deleteButton = event.target.closest("[data-package-delete]");
    if (deleteButton) {
      event.preventDefault();
      archivePackage(deleteButton.dataset.packageDelete || "").catch(renderErrorState);
      return;
    }

    const packageButton = event.target.closest("[data-package-assign]");
    if (!packageButton) {
      const unassignButton = event.target.closest("[data-package-unassign]");
      if (unassignButton) {
        event.preventDefault();
        unassignAssignment(unassignButton.dataset.packageUnassign || "").catch(renderErrorState);
      }
      return;
    }
    event.preventDefault();
    assignPackage(packageButton.dataset.packageAssign || "").catch(renderErrorState);
  });

  elements.usageAssignmentsTable?.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-package-view-assignment]");
    if (viewButton) {
      event.preventDefault();
      selectAssignmentDetail(viewButton.dataset.packageViewAssignment || "");
      return;
    }
    const unassignButton = event.target.closest("[data-package-unassign]");
    if (!unassignButton) {
      return;
    }
    event.preventDefault();
    unassignAssignment(unassignButton.dataset.packageUnassign || "").catch(renderErrorState);
  });

  elements.packageForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    savePackageFromForm().catch(renderErrorState);
  });

  elements.packageFormReset?.addEventListener("click", () => {
    resetPackageForm();
  });

  elements.filtersForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.filters.tenant = elements.tenantInput.value.trim();
    state.filters.vessel = elements.vesselInput.value.trim();
    syncLocationQuery();
    refreshAll().catch(renderErrorState);
  });

  elements.clearFiltersButton.addEventListener("click", () => {
    elements.tenantInput.value = "";
    elements.vesselInput.value = "";
    state.filters = { tenant: "", vessel: "" };
    syncLocationQuery();
    refreshAll().catch(renderErrorState);
  });

  elements.refreshButton.addEventListener("click", () => {
    refreshAll().catch(renderErrorState);
  });

  elements.refreshIntervalSelect.addEventListener("change", () => {
    state.autoRefreshSeconds = Number(elements.refreshIntervalSelect.value || "0");
    syncLocationQuery();
    setRefreshTimer();
  });

  elements.workspaceAdvancedToggle?.addEventListener("click", () => {
    toggleAdvancedWorkspace();
  });

  elements.usageFilterApply?.addEventListener("click", () => {
    applyUsageFiltersFromInputs();
    refreshAll().catch(renderErrorState);
  });

  elements.usageFilterReset?.addEventListener("click", () => {
    resetUsageFilters();
  });

  elements.usageExportButton?.addEventListener("click", () => {
    const query = createQueryString({
      tenant: state.filters.tenant,
      vessel: state.filters.vessel,
      bucket: state.reportFilters.bucket,
      date_from: state.reportFilters.dateFrom || undefined,
      date_to: state.reportFilters.dateTo || undefined
    });
    window.open(`/api/reports/usage/export${query ? `?${query}` : ""}`, "_blank", "noopener");
  });
}

async function bootstrap() {
  applyQueryFiltersFromLocation();
  syncUsageFilterInputs();
  applyWorkspaceMode();
  bindEvents();
  setStatusPill(elements.healthPill, "Checking", "loading");
  setStatusPill(elements.readyPill, "Checking", "loading");
  setStatusPill(elements.streamPill, "Idle", "muted");
  renderEndpointList();
  renderPackagesSection();
  renderPackageForm();
  renderUsageReportSection();
  renderPackageAuditSection();
  renderAssignmentDetailSection();
  setRefreshTimer();
  await refreshAll();
}

window.addEventListener("beforeunload", () => {
  closeSse();
  if (state.commandPollTimer) {
    window.clearTimeout(state.commandPollTimer);
  }
});

bootstrap().catch(renderErrorState);
