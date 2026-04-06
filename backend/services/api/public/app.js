const state = {
  autoRefreshSeconds: 15,
  detail: null,
  edges: [],
  filters: {
    tenant: "",
    vessel: ""
  },
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
      label: "Observed edges",
      value: total,
      meta: "Tong so edge dang nam trong bo loc hien tai"
    },
    {
      label: "Online now",
      value: online,
      meta: "Tinh theo heartbeat trong 120 giay"
    },
    {
      label: "Traffic active",
      value: state.edges.filter((item) => Number(item.throughput_kbps || 0) > 0).length,
      meta: "So edge dang co luu luong duoc ghi nhan"
    },
    {
      label: "Average traffic",
      value: formatKbps(avgThroughput),
      meta: "Trung binh throughput hien tai"
    }
  ];

  elements.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <span>${escapeHtml(card.meta)}</span>
        </article>
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
      <div class="empty-state">
        <h3>Khong tim thay edge nao</h3>
        <p>Thu bo rong bo loc tenant hoac vessel de xem them du lieu.</p>
      </div>
    `;
    return;
  }

  elements.edgeList.innerHTML = state.edges
    .map((edge) => {
      const selected = edgeKey(edge) === state.selectedEdgeKey;
      return `
        <article class="edge-item ${selected ? "is-selected" : ""}" data-edge-key="${escapeHtml(edgeKey(edge))}">
          <div class="edge-item-header">
            <div>
              <h3>${escapeHtml(edge.edge_code)}</h3>
              <p>${escapeHtml(edge.tenant_code)} / ${escapeHtml(edge.vessel_code)}</p>
            </div>
            ${statusMarkup(edge.online)}
          </div>
          <div class="edge-meta">
            <span class="meta-chip"><strong>Seen</strong> ${escapeHtml(formatDate(edge.telemetry_at || edge.heartbeat_at || edge.last_seen_at))}</span>
            <span class="meta-chip"><strong>Uplink</strong> ${escapeHtml(edge.active_uplink || "No data")}</span>
            <span class="meta-chip"><strong>Traffic</strong> ${escapeHtml(formatKbps(edge.throughput_kbps))}</span>
          </div>
        </article>
      `;
    })
    .join("");

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

function renderListItems(items, renderItem, emptyTitle, emptyText) {
  if (!items.length) {
    return `
      <div class="empty-state">
        <h3>${escapeHtml(emptyTitle)}</h3>
        <p>${escapeHtml(emptyText)}</p>
      </div>
    `;
  }

  return `<ul>${items.map(renderItem).join("")}</ul>`;
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
  const latestVms = detail.latest?.vms || {};
  const trafficSummary = traffic?.summary || {};
  const trafficSamples = Array.isArray(traffic?.samples) ? traffic.samples : [];
  const usage24h = detail.usage_24h || {};
  const totalUsageMb24h = Number(usage24h.upload_mb_24h || 0) + Number(usage24h.download_mb_24h || 0);
  const cumulativeTelemetryGb = extractTelemetryTotalGb(latestTelemetry, traffic);

  setTextContent(elements.detailTitle, summary.edge_code || "Edge detail");
  setTextContent(elements.detailMeta, `${summary.tenant_code || "-"} / ${summary.vessel_code || "-"} / direct Ethernet`);
  renderEndpointList();

  elements.detailShell.innerHTML = `
    <section class="detail-summary">
      <div class="detail-summary-header">
        <div>
          <h3>${escapeHtml(summary.edge_code || "Unknown edge")}</h3>
          <p>${escapeHtml(summary.tenant_name || summary.tenant_code || "Unknown tenant")} / ${escapeHtml(summary.vessel_name || summary.vessel_code || "Unknown vessel")}</p>
        </div>
        ${statusMarkup(summary.online)}
      </div>
      <div class="detail-hero-meta">
        <span class="meta-chip"><strong>Firmware</strong> ${escapeHtml(summary.edge_firmware_version || latestHeartbeat.firmware_version || "Unknown")}</span>
        <span class="meta-chip"><strong>Last seen</strong> ${escapeHtml(formatDate(latestTelemetry.observed_at || summary.last_seen_at || latestHeartbeat.observed_at))}</span>
        <span class="meta-chip"><strong>Uplink</strong> ${escapeHtml(latestTelemetry.active_uplink || "No data")}</span>
      </div>
    </section>

    <section class="live-grid">
      <article class="live-card">
        <div class="live-card-header">
          <h3>Throughput now</h3>
          <span class="tiny-note">${escapeHtml(formatDate(latestTelemetry.observed_at))}</span>
        </div>
        <div class="live-value">${escapeHtml(formatKbps(latestTelemetry.throughput_kbps))}</div>
      </article>
      <article class="live-card">
        <div class="live-card-header">
          <h3>Active uplink</h3>
          <span class="tiny-note">Direct link</span>
        </div>
        <div class="live-value">${escapeHtml(latestTelemetry.active_uplink || "Unknown")}</div>
      </article>
    </section>

    <section class="metric-grid">
      <article class="metric-card">
        <span>RX now</span>
        <strong>${escapeHtml(formatKbps(latestTelemetry.rx_kbps))}</strong>
      </article>
      <article class="metric-card">
        <span>TX now</span>
        <strong>${escapeHtml(formatKbps(latestTelemetry.tx_kbps))}</strong>
      </article>
      <article class="metric-card">
        <span>Total data</span>
        <strong>${escapeHtml(cumulativeTelemetryGb != null ? formatDataVolumeGb(cumulativeTelemetryGb) : formatDataVolumeMb(totalUsageMb24h))}</strong>
      </article>
      <article class="metric-card">
        <span>Latency</span>
        <strong>${escapeHtml(latestTelemetry.latency_ms != null ? `${formatNumber(latestTelemetry.latency_ms)} ms` : "No data")}</strong>
      </article>
      <article class="metric-card">
        <span>Packet loss</span>
        <strong>${escapeHtml(formatPercent(latestTelemetry.loss_pct))}</strong>
      </article>
      <article class="metric-card">
        <span>CPU</span>
        <strong>${escapeHtml(formatPercent(latestHeartbeat.cpu_usage_pct))}</strong>
      </article>
      <article class="metric-card">
        <span>RAM</span>
        <strong>${escapeHtml(formatPercent(latestHeartbeat.ram_usage_pct))}</strong>
      </article>
      <article class="metric-card">
        <span>Traffic average</span>
        <strong>${escapeHtml(formatKbps(trafficSummary.avg_throughput_kbps))}</strong>
      </article>
      <article class="metric-card">
        <span>Traffic peak</span>
        <strong>${escapeHtml(formatKbps(trafficSummary.peak_throughput_kbps))}</strong>
      </article>
      <article class="metric-card">
        <span>Latitude</span>
        <strong>${escapeHtml(formatCoordinate(latestVms.latitude))}</strong>
      </article>
      <article class="metric-card">
        <span>Longitude</span>
        <strong>${escapeHtml(formatCoordinate(latestVms.longitude))}</strong>
      </article>
    </section>

    <section class="chart-card">
      <div class="chart-header">
        <div>
          <h3>Traffic timeline</h3>
          <p class="chart-note">Window 120 phut, tu dong cap nhat va tron them telemetry song.</p>
        </div>
        <div class="legend">
          <span style="color:#68e1fd">Throughput</span>
          <span style="color:#53e2a1">RX</span>
          <span style="color:#ff9d5c">TX</span>
        </div>
      </div>
      ${renderTrafficChart(trafficSamples)}
    </section>

    <section class="history-grid">
      <article class="stack-card">
        <div class="stack-card-header">
          <h3>Recent events</h3>
          <span class="tiny-note">${escapeHtml(String(detail.recent_events?.length || 0))} items</span>
        </div>
        ${renderListItems(
          detail.recent_events || [],
          (item) => `
            <li>
              <strong>${escapeHtml(item.event_type || "event")}</strong>
              <div>${escapeHtml(item.severity || "unknown")} · ${escapeHtml(formatDate(item.observed_at))}</div>
            </li>
          `,
          "No events",
          "Edge nay chua phat sinh su kien nao."
        )}
      </article>

      <article class="stack-card">
        <div class="stack-card-header">
          <h3>Ingest errors</h3>
          <span class="tiny-note">${escapeHtml(String(detail.ingest_errors?.length || 0))} items</span>
        </div>
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
          "Worker dang nhan va xu ly du lieu sach."
        )}
      </article>

      <article class="stack-card">
        <div class="stack-card-header">
          <h3>Top users 24h</h3>
          <span class="tiny-note">${escapeHtml(String(detail.top_users_24h?.length || 0))} users</span>
        </div>
        ${renderListItems(
          detail.top_users_24h || [],
          (item) => `
            <li>
              <strong>${escapeHtml(item.username || "unknown")}</strong>
              <div>DL ${escapeHtml(formatNumber(item.download_mb, 2))} MB · UL ${escapeHtml(formatNumber(item.upload_mb, 2))} MB</div>
              <div>${escapeHtml(formatDate(item.last_seen))}</div>
            </li>
          `,
          "No usage data",
          "Chua co luu luong user trong 24h qua."
        )}
      </article>
    </section>
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
    closeSse();
    renderDetail();
    return;
  }

  const detailPath = `/api/mcu/edges/${encodeURIComponent(edge.tenant_code)}/${encodeURIComponent(edge.vessel_code)}/${encodeURIComponent(edge.edge_code)}`;
  const trafficPath = `${detailPath}/traffic?window_minutes=120&limit=180`;

  const [detail, traffic] = await Promise.all([fetchJson(detailPath), fetchJson(trafficPath)]);
  state.detail = detail;
  state.traffic = traffic;
  renderDetail();
  connectSse(edge);
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
});

bootstrap().catch(renderErrorState);
