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
  ready: null,
  refreshTimer: null,
  selectedEdgeKey: "",
  sse: null,
  streamStatus: "idle",
  traffic: null
};

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
  readyPill: document.querySelector("#ready-pill"),
  refreshButton: document.querySelector("#refresh-button"),
  refreshIntervalSelect: document.querySelector("#refresh-interval-select"),
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

async function fetchJson(path) {
  const response = await fetch(path, {
    headers: {
      accept: "application/json"
    }
  });

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
  const nextUrl = query ? `/dashboard?${query}` : "/dashboard";
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
      label: "Dashboard",
      href: buildAbsoluteUrl("/dashboard", {
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

function isCommandableEdge(edge) {
  return Boolean(edge?.online);
}

function commandActionDefinition(action) {
  const actions = {
    failback_vsat: {
      label: "Switch to VSAT",
      description: "Move primary work traffic back to VSAT.",
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
      command_type: "policy_sync",
      command_payload: {
        scope: "uplink_policy"
      },
      confirm: "Sync the current policy to this edge box?"
    },
    restore_automatic: {
      label: "Restore automatic",
      description: "Return the edge box to automatic policy handling.",
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
          const payloadSummary = Object.entries(job.command_payload || {})
            .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
            .join(" · ");

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

  const commandable = isCommandableEdge(selected);
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
          ${isBusy || !commandable ? "disabled" : ""}
        >
          <span class="command-action-main">
            <span class="command-action-title">${escapeHtml(definition.label)}</span>
            <span class="command-action-desc">${escapeHtml(definition.description)}</span>
          </span>
          <i class="bi bi-arrow-right-circle"></i>
        </button>
      `;
    })
    .join("");

  return `
    <div class="card card-outline card-danger mt-3">
      <div class="card-header d-flex align-items-center justify-content-between">
        <h3 class="card-title mb-0">Command center</h3>
        <span class="badge text-bg-danger">Live control</span>
      </div>
      <div class="card-body">
        <p class="chart-note mb-3">
          Commands publish to the selected edge box and are tracked until ack/result comes back.
        </p>
        <div class="tiny-note mb-3">
          ${commandable
            ? "Edge is online. Commands are enabled and live polling stays active while jobs are pending."
            : "Edge is offline. Commands are disabled until the next heartbeat arrives."}
        </div>
        ${renderCommandFeedback()}
        <div class="command-center-grid">
          <section class="command-action-panel">
            <div class="command-panel-head">
              <h4>Quick actions</h4>
              <span class="tiny-note">${escapeHtml(selected.edge_code)} ready</span>
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
          <button type="button" class="btn btn-tool" data-lte-toggle="card-widget">
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
          <div class="col-lg-4">
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

          <div class="col-lg-4">
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

          <div class="col-lg-4">
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
    const response = await fetch("/api/commands", {
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
  await loadHealth();
  await loadEdges();
  await refreshSelectedEdge();
}

function bindEvents() {
  elements.detailShell.addEventListener("click", (event) => {
    const button = event.target.closest("[data-command-action]");
    if (!button) {
      return;
    }

    event.preventDefault();
    const action = button.dataset.commandAction;
    sendCommand(action).catch(renderErrorState);
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
}

async function bootstrap() {
  applyQueryFiltersFromLocation();
  bindEvents();
  setStatusPill(elements.healthPill, "Checking", "loading");
  setStatusPill(elements.readyPill, "Checking", "loading");
  setStatusPill(elements.streamPill, "Idle", "muted");
  renderEndpointList();
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
