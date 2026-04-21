<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  createCommand,
  getEdgeDetail,
  getEdgeTraffic,
  getMetrics,
  getPublicHealth,
  getPublicReady,
  listCommandsWithMeta,
  listEdges,
  listPackages
} from '../services/api';
import { debounce } from '../utils/performance';
import { useUiStore } from '../stores/ui';

const fallbackEdges = [
  {
    tenant_code: 'tnr13',
    vessel_code: 'vsl-001',
    edge_code: 'edge-001',
    online: false,
    public_wan_ip: null,
    edge_firmware_version: '1.0.0',
    last_seen_at: null,
    error_count_24h: 1,
    last_error_at: '2026-04-16T03:02:16.967Z'
  }
];

const fallbackCommands = [
  {
    id: '8ef4adef-5a5c-43f3-8a40-4cdaaa13e996',
    tenant_code: 'tnr13',
    vessel_code: 'vsl-001',
    edge_code: 'edge-001',
    command_type: 'failover_starlink',
    status: 'sent',
    created_at: '2026-04-16T03:04:16.773Z'
  }
];

const fallbackPackages = [
  { code: 'basic-50gb', name: 'Basic 50GB', is_active: true },
  { code: 'standard-100gb', name: 'Standard 100GB', is_active: true },
  { code: 'premium-200gb', name: 'Premium 200GB', is_active: true }
];

const loading = ref(false);
const backendMode = ref('loading');
const apiHealth = ref('checking');
const apiReady = ref('checking');
const apiHealthSnapshot = ref(null);
const apiReadySnapshot = ref(null);
const systemMetrics = ref(null);
const edges = ref([...fallbackEdges]);
const commands = ref([...fallbackCommands]);
const packages = ref([...fallbackPackages]);
const commandPageSize = ref(5);
const commandOffset = ref(0);
const liveError = ref('');
const commandNotice = ref('');
const commandBusy = ref(false);
const selectedEdgeSummary = ref(null);
const selectedEdgeDetail = ref(null);
const selectedEdgeTraffic = ref(null);
const selectedEdgeLoading = ref(false);
const selectedEdgeError = ref('');
const trafficLoading = ref(false);
const dashboardRefreshMs = ref(60_000);
const streamStatus = ref('idle');
const streamError = ref('');
const selectedAssetPanelRef = ref(null);
const uiStore = useUiStore();
let refreshTimer = null;
let selectedEdgePollTimer = null;
let unmounted = false;

const selectedEdge = computed(() => selectedEdgeSummary.value || edges.value[0] || null);
const selectedEdgeKey = computed(() => selectedEdge.value ? `${selectedEdge.value.tenant_code}/${selectedEdge.value.vessel_code}/${selectedEdge.value.edge_code}` : '');
const trafficLatest = computed(() => selectedEdgeTraffic.value?.latest || null);
const trafficSamples = computed(() => selectedEdgeTraffic.value?.samples || []);
const trafficPreview = computed(() => trafficSamples.value.slice(-8));
const trafficMaxKbps = computed(() => {
  const values = trafficPreview.value.flatMap((sample) => [sample.rx_kbps ?? 0, sample.tx_kbps ?? 0]);
  return values.length ? Math.max(...values, 1) : 1;
});
const perPortTrafficRows = computed(() => {
  const latestInterfaces = selectedEdgeDetail.value?.latestTelemetry?.interfaces
    ?? selectedEdgeTraffic.value?.latest?.interfaces
    ?? [];

  return latestInterfaces
    .map((iface) => {
      const rawName = String(iface?.name || 'unknown').trim();
      const rxKbps = Number(iface?.rx_kbps ?? 0) || 0;
      const txKbps = Number(iface?.tx_kbps ?? 0) || 0;
      const throughputKbps = Number(iface?.throughput_kbps ?? rxKbps + txKbps) || 0;

      return {
        name: rawName,
        label: formatInterfaceLabel(rawName),
        rxKbps,
        txKbps,
        throughputKbps,
        totalGb: iface?.total_gb ?? null
      };
    })
    .filter((iface) => iface.name)
    .sort((left, right) => left.name.localeCompare(right.name));
});
const perPortTrafficMaxKbps = computed(() => {
  const values = perPortTrafficRows.value.flatMap((iface) => [iface.rxKbps, iface.txKbps, iface.throughputKbps]);
  return values.length ? Math.max(...values, 1) : 1;
});
const onlineEdges = computed(() => edges.value.filter((edge) => edge.online).length);
const warningEdges = computed(() => edges.value.filter((edge) => !edge.online && edge.error_count_24h > 0).length);
const activePackages = computed(() => packages.value.filter((item) => item.is_active !== false).length);
const metricsSummary = computed(() => {
  const metrics = systemMetrics.value;
  if (!metrics) {
    return {
      inFlight: null,
      requestCount: null
    };
  }

  const requestCount = (metrics.httpRequestsTotal || []).reduce((total, entry) => total + Number(entry.value || 0), 0);
  return {
    inFlight: Number(metrics.httpRequestsInFlight || 0),
    requestCount
  };
});
const connectionStatus = computed(() => uiStore.connection);
const databaseHealth = computed(() => apiHealthSnapshot.value?.checks?.database || null);

const summaryCards = computed(() => [
  {
    label: 'Total edges',
    value: String(edges.value.length),
    note: backendMode.value === 'live' ? 'Loaded from /api/mcu/edges' : 'Fallback preview data',
    tone: 'accent'
  },
  {
    label: 'Online edges',
    value: String(onlineEdges.value),
    note: `API ${apiReady.value}`,
    tone: apiReady.value === 'ready' ? 'good' : 'danger'
  },
  {
    label: 'Recent commands',
    value: String(commands.value.length),
    note: 'Latest command jobs from backend',
    tone: 'warm'
  },
  {
    label: 'Active packages',
    value: String(activePackages.value),
    note: 'Phase 3 package catalog',
    tone: 'accent'
  },
  {
    label: 'HTTP in-flight',
    value: metricsSummary.value.inFlight === null ? 'n/a' : String(metricsSummary.value.inFlight),
    note: 'Live metrics endpoint',
    tone: 'warm'
  },
  {
    label: 'Requests seen',
    value: metricsSummary.value.requestCount === null ? 'n/a' : String(metricsSummary.value.requestCount),
    note: 'Prometheus scrape sample',
    tone: 'accent'
  }
]);

const statusClass = (status) => {
  if (status === 'Online' || status === true) return 'status-pill status-good';
  if (status === 'Warning') return 'status-pill status-warn';
  return 'status-pill status-bad';
};

const edgeStatusLabel = (edge) => {
  if (edge?.online) return 'Online';
  if (edge?.error_count_24h > 0) return 'Warning';
  return 'Offline';
};

const edgeStatusTone = (edge) => {
  if (edge?.online) return 'status-good';
  if (edge?.error_count_24h > 0) return 'status-warn';
  return 'status-bad';
};

const isSelectedEdge = (edge) => {
  if (!edge || !selectedEdge.value) return false;
  return edge.tenant_code === selectedEdge.value.tenant_code
    && edge.vessel_code === selectedEdge.value.vessel_code
    && edge.edge_code === selectedEdge.value.edge_code;
};

const selectEdge = async (edge) => {
  await loadSelectedEdgeDetail(edge);
  connectLiveStream(edge);
  await nextTick();
  selectedAssetPanelRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const normalizeEdgeDetail = (detail) => {
  if (!detail) return null;
  const summary = detail.summary || {};
  const latest = detail.latest || {};
  return {
    summary: detail.summary || null,
    latestHeartbeat: latest.heartbeat || null,
    latestTelemetry: latest.telemetry || null,
    latestVms: latest.vms || null,
    usage24h: detail.usage_24h || null,
    topUsers24h: detail.top_users_24h || [],
    usageOverview: detail.usage_overview || null,
    uplinkPolicy: detail.uplink_policy || null,
    recentEvents: detail.recent_events || [],
    ingestErrors: detail.ingest_errors || [],
    ingestActivity24h: detail.ingest_activity_24h || [],
    recentAlerts: detail.recent_alerts || [],
    online: summary.online,
    edge_code: summary.edge_code,
    tenant_code: summary.tenant_code,
    vessel_code: summary.vessel_code
  };
};

const normalizeTraffic = (traffic) => {
  if (!traffic) return null;
  return {
    ...traffic,
    latest: traffic.latest || null,
    summary: traffic.summary || null,
    samples: Array.isArray(traffic.samples) ? traffic.samples : []
  };
};

const loadSelectedEdgeTraffic = async (edge) => {
  if (!edge?.tenant_code || !edge?.vessel_code || !edge?.edge_code) {
    selectedEdgeTraffic.value = null;
    return;
  }

  trafficLoading.value = true;
  try {
    const traffic = await getEdgeTraffic({
      tenant: edge.tenant_code,
      vessel: edge.vessel_code,
      edge: edge.edge_code,
      windowMinutes: 60,
      limit: 120
    });
    selectedEdgeTraffic.value = normalizeTraffic(traffic);
  } catch (error) {
    selectedEdgeTraffic.value = null;
    selectedEdgeError.value = error?.message || 'Unable to load edge traffic';
  } finally {
    trafficLoading.value = false;
  }
};

const loadSelectedEdgeDetail = async (edge) => {
  if (!edge?.tenant_code || !edge?.vessel_code || !edge?.edge_code) {
    selectedEdgeSummary.value = edge || null;
    selectedEdgeDetail.value = null;
    selectedEdgeTraffic.value = null;
    return;
  }

  selectedEdgeLoading.value = true;
  selectedEdgeError.value = '';
  selectedEdgeSummary.value = edge;

  try {
    const detailRes = await getEdgeDetail({
      tenant: edge.tenant_code,
      vessel: edge.vessel_code,
      edge: edge.edge_code,
      onlineSeconds: 120
    });

    selectedEdgeDetail.value = normalizeEdgeDetail(detailRes);
    await loadSelectedEdgeTraffic(edge);
  } catch (error) {
    selectedEdgeError.value = error?.message || 'Unable to load edge detail';
    selectedEdgeDetail.value = null;
    selectedEdgeTraffic.value = null;
  } finally {
    selectedEdgeLoading.value = false;
  }
};

const closeEdgeStream = () => {
  if (selectedEdgePollTimer) {
    clearInterval(selectedEdgePollTimer);
    selectedEdgePollTimer = null;
  }
  streamStatus.value = 'idle';
  streamError.value = '';
};

const mergeTelemetrySnapshot = (payload) => {
  if (!payload || !selectedEdgeDetail.value) return;
  const nextTelemetry = {
    ...(selectedEdgeDetail.value.latestTelemetry || {}),
    ...payload,
    interfaces: Array.isArray(payload.interfaces) ? payload.interfaces : (selectedEdgeDetail.value.latestTelemetry?.interfaces || [])
  };

  selectedEdgeDetail.value = {
    ...selectedEdgeDetail.value,
    latestTelemetry: nextTelemetry,
    online: payload.observed_at ? true : selectedEdgeDetail.value.online
  };
};

const scheduleTrafficRefresh = debounce((edge) => {
  if (unmounted || !edge) return;
  loadSelectedEdgeTraffic(edge);
}, 400);

const connectLiveStream = (edge) => {
  if (!edge?.tenant_code || !edge?.vessel_code || !edge?.edge_code) {
    closeEdgeStream();
    return;
  }

  const streamKey = `${edge.tenant_code}/${edge.vessel_code}/${edge.edge_code}`;
  if (selectedEdgePollTimer) {
    clearInterval(selectedEdgePollTimer);
  }
  selectedEdgePollTimer = window.setInterval(() => {
    if (unmounted || selectedEdgeLoading.value || !isSelectedEdge(edge)) return;
    loadSelectedEdgeDetail(edge);
  }, 15_000);

  streamStatus.value = 'polling';
  streamError.value = '';
  uiStore.setConnection({
    status: 'polling',
    label: 'Telemetry polling',
    detail: streamKey,
    tone: 'good'
  });
};

const commandProfiles = {
  failover_starlink: {
    label: 'Switch to Starlink',
    payload: { preferred_uplink: 'starlink', scope: 'critical', mode: 'manual' }
  },
  failback_vsat: {
    label: 'Switch to VSAT',
    payload: { preferred_uplink: 'vsat', scope: 'critical', mode: 'manual' }
  },
  restore_automatic: {
    label: 'Restore automatic',
    payload: { preferred_uplink: 'automatic', scope: 'automatic', mode: 'automatic' }
  },
  policy_sync: {
    label: 'Sync policy',
    payload: { preferred_uplink: 'automatic', scope: 'uplink_policy', mode: 'manual' }
  }
};

const sendCommand = async (commandType) => {
  const edge = selectedEdgeSummary.value || edges.value[0];
  if (!edge) {
    commandNotice.value = 'No edge selected';
    return;
  }

  const profile = commandProfiles[commandType];
  if (!profile) {
    commandNotice.value = `Unsupported command: ${commandType}`;
    return;
  }

  commandBusy.value = true;
  commandNotice.value = '';

  try {
    const result = await createCommand({
      tenant_code: edge.tenant_code,
      vessel_code: edge.vessel_code,
      edge_code: edge.edge_code,
      command_type: commandType,
      command_payload: profile.payload
    });
    commandNotice.value = `Command sent: ${result?.command?.status || 'sent'} on ${result?.mqtt_topic || edge.edge_code}`;
    await refreshDashboard({ silent: true });
    await loadSelectedEdgeDetail(edge);
  } catch (error) {
    commandNotice.value = error?.message || 'Unable to send command';
  } finally {
    commandBusy.value = false;
  }
};

const loadPublicStatus = async ({ silent = false } = {}) => {
  if (!silent) {
    loading.value = true;
  }
  liveError.value = '';

  try {
    const [healthRes, readyRes, metricsRes, edgesRes, commandsRes, packagesRes] = await Promise.allSettled([
      getPublicHealth(),
      getPublicReady(),
      getMetrics(),
      listEdges({ limit: 8 }),
      listCommandsWithMeta({ limit: commandPageSize.value, offset: commandOffset.value }),
      listPackages({ tenant: 'tnr13', includeInactive: true })
    ]);

    if (healthRes.status === 'fulfilled') {
      apiHealth.value = healthRes.value?.status || 'unknown';
      apiHealthSnapshot.value = healthRes.value || null;
    } else {
      apiHealth.value = 'error';
      apiHealthSnapshot.value = null;
    }

    if (readyRes.status === 'fulfilled') {
      apiReady.value = readyRes.value?.status || 'unknown';
      apiReadySnapshot.value = readyRes.value || null;
    } else {
      apiReady.value = 'error';
      apiReadySnapshot.value = null;
    }

    if (metricsRes.status === 'fulfilled') {
      systemMetrics.value = metricsRes.value;
      uiStore.setSystemMetrics(metricsRes.value);
    } else {
      systemMetrics.value = null;
      uiStore.setSystemMetrics(null);
    }

    if (edgesRes.status === 'fulfilled' && Array.isArray(edgesRes.value?.items)) {
      edges.value = edgesRes.value.items;
      const preferredEdge = selectedEdgeSummary.value
        ? edges.value.find((edge) =>
            edge.edge_code === selectedEdgeSummary.value.edge_code
            && edge.vessel_code === selectedEdgeSummary.value.vessel_code
            && edge.tenant_code === selectedEdgeSummary.value.tenant_code
          )
        : edges.value[0];
      if (preferredEdge) {
        await loadSelectedEdgeDetail(preferredEdge);
        connectLiveStream(preferredEdge);
      }
    } else {
      edges.value = [...fallbackEdges];
      await loadSelectedEdgeDetail(fallbackEdges[0]);
      connectLiveStream(fallbackEdges[0]);
    }

    if (commandsRes.status === 'fulfilled') {
      const commandPayload = commandsRes.value?.payload || commandsRes.value;
      commands.value = Array.isArray(commandPayload?.items) ? commandPayload.items : (Array.isArray(commandPayload) ? commandPayload : []);
    } else {
      commands.value = [...fallbackCommands];
    }

    if (packagesRes.status === 'fulfilled' && Array.isArray(packagesRes.value)) {
      packages.value = packagesRes.value;
    } else {
      packages.value = [...fallbackPackages];
    }

    backendMode.value = edgesRes.status === 'fulfilled' || commandsRes.status === 'fulfilled' || packagesRes.status === 'fulfilled'
      ? 'live'
      : 'fallback';

    const dbHealth = healthRes.status === 'fulfilled' ? healthRes.value?.checks?.database : null;
    uiStore.setConnection({
      status: backendMode.value === 'live' ? 'monitoring' : 'fallback',
      label: backendMode.value === 'live' ? 'Monitoring live' : 'Monitoring fallback',
      detail: dbHealth ? `DB ${dbHealth.status}${dbHealth.latency_ms !== undefined ? ` · ${dbHealth.latency_ms}ms` : ''}` : 'Backend status unavailable',
      tone: backendMode.value === 'live' ? 'good' : 'warn'
    });
  } catch (error) {
    liveError.value = error?.message || 'Unable to load dashboard data';
    backendMode.value = 'fallback';
    edges.value = [...fallbackEdges];
    commands.value = [...fallbackCommands];
    packages.value = [...fallbackPackages];
    await loadSelectedEdgeDetail(fallbackEdges[0]);
    connectLiveStream(fallbackEdges[0]);
    uiStore.setConnection({
      status: 'fallback',
      label: 'Monitoring fallback',
      detail: 'Backend data unavailable',
      tone: 'warn'
    });
  } finally {
    loading.value = false;
  }
};

const formatDate = (value) => {
  if (!value) return 'No data';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const formatTime = (value) => {
  if (!value) return '--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatRate = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'No data';
  }
  return `${Number(value).toFixed(0)} Kbps`;
};

const formatVolumeGb = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'No data';
  }
  return `${Number(value).toFixed(2)} GB`;
};

const refreshDashboard = async ({ silent = false } = {}) => {
  await loadPublicStatus({ silent });
};

const prevCommandsPage = async () => {
  commandOffset.value = Math.max(0, commandOffset.value - commandPageSize.value);
  await loadPublicStatus({ silent: true });
};

const nextCommandsPage = async () => {
  commandOffset.value += commandPageSize.value;
  await loadPublicStatus({ silent: true });
};

const debouncedRefreshDashboard = debounce(() => {
  refreshDashboard({ silent: true });
}, 250);

const formatInterfaceLabel = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 'Unknown port';

  const lowered = raw.toLowerCase();

  if (/(^|[^a-z])(vsat)([^a-z]|$)/.test(lowered)) return 'VSAT';
  if (/(^|[^a-z])(starlink|starlink)([^a-z]|$)/.test(lowered)) return 'Starlink';
  if (/(^|[^a-z])(wan|internet|uplink)([^a-z]|$)/.test(lowered)) return 'WAN';
  if (/(^|[^a-z])(lan|bridge)([^a-z]|$)/.test(lowered)) return 'LAN';
  if (/(^|[^a-z])(cell|lte|4g|5g|wwan)([^a-z]|$)/.test(lowered)) return 'Cellular';

  const etherMatch = raw.match(/(?:ethernet|ether|eth)[-_ ]?(\d+)/i);
  if (etherMatch) {
    return `Ethernet ${etherMatch[1]}`;
  }

  const portMatch = raw.match(/(?:port|ge|te|xe)[-_ ]?(\d+)/i);
  if (portMatch) {
    return `Port ${portMatch[1]}`;
  }

  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const trafficBarWidth = (value) => `${Math.max(4, Math.round((Number(value || 0) / trafficMaxKbps.value) * 100))}%`;
const perPortTrafficBarWidth = (value) => `${Math.max(4, Math.round((Number(value || 0) / perPortTrafficMaxKbps.value) * 100))}%`;

const formatEdgeTitle = (edge) => `${edge.tenant_code}/${edge.vessel_code}/${edge.edge_code}`;

const startAutoRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  if (dashboardRefreshMs.value > 0) {
    refreshTimer = window.setInterval(() => {
      if (!loading.value) {
        debouncedRefreshDashboard();
      }
    }, dashboardRefreshMs.value);
  }
};

const stopAllTimers = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (selectedEdgePollTimer) {
    clearInterval(selectedEdgePollTimer);
    selectedEdgePollTimer = null;
  }
};

onMounted(() => {
  loadPublicStatus();
  startAutoRefresh();
});

onBeforeUnmount(() => {
  unmounted = true;
  stopAllTimers();
  closeEdgeStream();
});
</script>

<template>
  <section class="portal-page">
    <div class="portal-card">
      <div class="portal-card__header">
        <div>
          <span class="portal-kicker">Executive summary</span>
          <h2>Fleet command center</h2>
          <p class="portal-muted mb-0">Monitoring-first dashboard for NOC and operations.</p>
        </div>
        <div class="d-flex gap-2 flex-wrap justify-content-end">
          <router-link to="/package-catalog" class="btn btn-sm btn-outline-light">Open package catalog</router-link>
          <button class="btn btn-sm btn-primary" :disabled="loading" @click="loadPublicStatus">
            {{ loading ? 'Refreshing...' : 'Refresh' }}
          </button>
        </div>
      </div>

      <div v-if="liveError" class="alert alert-warning border-0 bg-warning bg-opacity-10 text-warning mb-3">
        {{ liveError }}
      </div>

      <div class="portal-card portal-status-banner mb-3">
        <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <span class="portal-kicker">Portal status</span>
            <strong>{{ connectionStatus?.label || 'Monitoring ready' }}</strong>
            <div class="portal-muted small">{{ connectionStatus?.detail || 'Live dashboard connected to backend APIs.' }}</div>
          </div>
          <div class="d-flex flex-wrap gap-2">
            <span class="status-pill" :class="connectionStatus?.tone === 'good' ? 'status-good' : connectionStatus?.tone === 'warn' ? 'status-warn' : 'status-muted'">
              {{ connectionStatus?.status || 'idle' }}
            </span>
            <span v-if="uiStore.rateLimit?.remaining !== null && uiStore.rateLimit?.remaining !== undefined" class="status-pill status-muted">
              Rate {{ uiStore.rateLimit.remaining }}/{{ uiStore.rateLimit.limit || '?' }}
            </span>
          </div>
        </div>
      </div>

      <div class="portal-grid portal-grid--3">
        <div v-for="card in summaryCards" :key="card.label" class="portal-card" style="padding: 16px;">
          <div class="d-flex justify-content-between align-items-start gap-3 mb-2">
            <span class="portal-kicker">{{ card.label }}</span>
            <span class="portal-chip" :class="card.tone === 'accent' ? 'portal-chip--accent' : ''">{{ card.tone === 'good' ? 'Live' : 'Info' }}</span>
          </div>
          <h3 class="mb-1">{{ card.value }}</h3>
          <p class="portal-muted mb-0">{{ card.note }}</p>
        </div>
      </div>

      <div class="portal-grid portal-grid--2 mt-4">
        <div class="portal-card" style="padding: 16px;">
          <span class="portal-kicker">Backend status</span>
          <div class="d-flex gap-2 flex-wrap mt-2">
            <span :class="apiHealth === 'ok' ? 'status-pill status-good' : 'status-pill status-bad'">API {{ apiHealth }}</span>
            <span :class="apiReady === 'ready' ? 'status-pill status-good' : 'status-pill status-warn'">Ready {{ apiReady }}</span>
          </div>
          <div class="d-flex flex-wrap gap-2 mt-3">
            <span class="status-pill status-muted">DB {{ databaseHealth?.status || 'n/a' }}</span>
            <span class="status-pill status-muted">Pool {{ databaseHealth?.pool?.usage_percent ?? 'n/a' }}%</span>
            <span class="status-pill status-muted">Latency {{ databaseHealth?.latency_ms ?? 'n/a' }}ms</span>
          </div>
        </div>
        <div class="portal-card" style="padding: 16px;">
          <span class="portal-kicker">Current focus</span>
          <div class="d-flex gap-2 flex-wrap mt-2">
            <span class="portal-chip portal-chip--accent">Monitoring</span>
            <span class="portal-chip">Package ops</span>
            <span class="portal-chip">{{ backendMode === 'live' ? 'Live data' : 'Fallback data' }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="portal-grid portal-grid--2">
      <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Fleet snapshot</span>
            <h3>Connected assets</h3>
          </div>
          <span class="portal-chip">{{ edges.length }} edges</span>
        </div>

        <div class="table-responsive">
          <table class="table table-borderless align-middle mb-0 portal-mono">
            <thead>
              <tr class="text-uppercase portal-muted" style="font-size: 0.72rem; letter-spacing: 0.12em;">
                <th>Asset</th>
                <th>Status</th>
                <th>Seen</th>
                <th class="text-end">Action</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="edge in edges" :key="edge.edge_code" :class="{ 'edge-row--selected': isSelectedEdge(edge) }">
                <td>
                  <div class="fw-semibold text-white">{{ formatEdgeTitle(edge) }}</div>
                  <div class="portal-muted small">{{ edge.edge_firmware_version || 'Unknown firmware' }}</div>
                </td>
                <td>
                  <span :class="statusClass(edge.online ? 'Online' : edge.error_count_24h > 0 ? 'Warning' : 'Offline')">
                    {{ edgeStatusLabel(edge) }}
                  </span>
                </td>
                <td class="text-white">
                  <div>{{ formatDate(edge.last_seen_at || edge.heartbeat_at) }}</div>
                  <div class="portal-muted small">{{ edge.public_wan_ip || 'No WAN IP mapped' }}</div>
                </td>
                <td class="text-end">
                  <button class="btn btn-sm btn-outline-info" @click="selectEdge(edge)">
                    {{ isSelectedEdge(edge) ? 'Viewing' : 'Monitor' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div ref="selectedAssetPanelRef" class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Selected asset</span>
            <h3>{{ selectedEdge ? formatEdgeTitle(selectedEdge) : 'No selection' }}</h3>
          </div>
          <span :class="selectedEdge ? edgeStatusTone(selectedEdge) : 'status-pill status-muted'">
            {{ selectedEdge ? edgeStatusLabel(selectedEdge) : 'None' }}
          </span>
        </div>

        <div v-if="selectedEdgeLoading" class="portal-muted">
          <div class="portal-skeleton portal-skeleton--line w-45 mb-2"></div>
          <div class="portal-grid portal-grid--2" style="gap: 12px;">
            <div class="portal-skeleton portal-skeleton--block"></div>
            <div class="portal-skeleton portal-skeleton--block"></div>
          </div>
        </div>
        <div v-else-if="selectedEdgeError" class="portal-muted">{{ selectedEdgeError }}</div>
        <div v-else-if="selectedEdge" class="portal-grid" style="gap: 12px;">
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Uplink</span>
            <strong>{{ selectedEdgeDetail?.latestTelemetry?.active_uplink || selectedEdge.active_uplink || 'Unknown' }}</strong>
            <div class="portal-muted small mt-1">Firmware {{ selectedEdgeDetail?.latestHeartbeat?.firmware_version || selectedEdge.edge_firmware_version || 'n/a' }}</div>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Status</span>
            <strong>{{ selectedEdgeDetail?.online ? 'Online' : selectedEdge.online ? 'Online' : 'Offline' }}</strong>
            <div class="portal-muted small mt-1">
              Alerts: {{ (selectedEdgeDetail?.recentAlerts?.length ?? selectedEdge.error_count_24h ?? 0) }} in 24h
            </div>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">WAN</span>
            <strong>{{ selectedEdge.public_wan_ip || 'Unmapped' }}</strong>
            <div class="portal-muted small mt-1">Last error {{ selectedEdge.last_error_at ? formatDate(selectedEdge.last_error_at) : 'None' }}</div>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Traffic</span>
            <strong>{{ formatRate(trafficLatest?.throughput_kbps ?? selectedEdgeTraffic?.summary?.avg_throughput_kbps) }}</strong>
            <div class="portal-muted small mt-1">Window {{ selectedEdgeTraffic?.window_minutes || 60 }}m</div>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Usage 24h</span>
            <strong>{{ selectedEdgeDetail?.usage24h ? `${Number(selectedEdgeDetail.usage24h.upload_mb_24h || 0).toFixed(0)} / ${Number(selectedEdgeDetail.usage24h.download_mb_24h || 0).toFixed(0)} MB` : 'No usage' }}</strong>
            <div class="portal-muted small mt-1">Samples {{ selectedEdgeDetail?.usage24h?.samples_24h || 0 }}</div>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Alerts</span>
            <strong>{{ selectedEdgeDetail?.recentAlerts?.length || 0 }}</strong>
            <div class="portal-muted small mt-1">Recent warnings for this vessel</div>
          </div>
        </div>

        <div v-if="selectedEdgeTraffic" class="portal-card mt-3" style="padding: 16px;">
          <div class="portal-card__header">
            <div>
              <span class="portal-kicker">Traffic RX / TX</span>
              <h3>Throughput window</h3>
            </div>
            <span class="portal-chip portal-chip--accent">{{ selectedEdgeTraffic.summary?.interfaces_seen?.length || 0 }} interfaces</span>
          </div>

          <div class="portal-grid portal-grid--3">
            <div class="portal-card" style="padding: 14px;">
              <span class="portal-kicker">Average RX</span>
              <strong>{{ formatRate(selectedEdgeTraffic.summary?.avg_rx_kbps) }}</strong>
            </div>
            <div class="portal-card" style="padding: 14px;">
              <span class="portal-kicker">Average TX</span>
              <strong>{{ formatRate(selectedEdgeTraffic.summary?.avg_tx_kbps) }}</strong>
            </div>
            <div class="portal-card" style="padding: 14px;">
              <span class="portal-kicker">Peak</span>
              <strong>{{ formatRate(selectedEdgeTraffic.summary?.peak_throughput_kbps) }}</strong>
            </div>
          </div>

          <div class="portal-grid" style="gap: 10px; margin-top: 14px;">
            <div
              v-for="sample in trafficPreview"
              :key="sample.observed_at"
              class="traffic-row"
            >
              <div class="traffic-row__time">{{ formatTime(sample.observed_at) }}</div>
              <div class="traffic-row__bars">
                <div class="traffic-row__bar traffic-row__bar--rx" :style="{ width: trafficBarWidth(sample.rx_kbps) }"></div>
                <div class="traffic-row__bar traffic-row__bar--tx" :style="{ width: trafficBarWidth(sample.tx_kbps) }"></div>
              </div>
              <div class="traffic-row__values">
                <span class="traffic-badge traffic-badge--rx">RX {{ formatRate(sample.rx_kbps) }}</span>
                <span class="traffic-badge traffic-badge--tx">TX {{ formatRate(sample.tx_kbps) }}</span>
              </div>
            </div>
          </div>

          <div v-if="trafficPreview.length === 0" class="portal-muted mt-3">No TX/RX samples available yet. Connect telemetry from MCU to populate this chart.</div>
        </div>

        <div v-else-if="trafficLoading" class="portal-card mt-3" style="padding: 16px;">
          <div class="portal-skeleton portal-skeleton--line w-40 mb-2"></div>
          <div class="portal-skeleton portal-skeleton--block"></div>
        </div>

          <div v-if="perPortTrafficRows.length" class="portal-card mt-3" style="padding: 16px;">
            <div class="portal-card__header">
              <div>
                <span class="portal-kicker">Per-port traffic</span>
                <h3>Interface breakdown</h3>
              </div>
            <span class="portal-chip portal-chip--accent">{{ perPortTrafficRows.length }} ports</span>
          </div>

          <div class="table-responsive">
            <table class="table table-borderless align-middle mb-0 portal-mono portal-port-table">
              <thead>
                <tr class="text-uppercase portal-muted" style="font-size: 0.72rem; letter-spacing: 0.12em;">
                  <th>Port</th>
                  <th>RX</th>
                  <th>TX</th>
                  <th>Throughput</th>
                  <th>Total GB</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="iface in perPortTrafficRows" :key="iface.name">
                  <td>
                    <div class="text-white fw-semibold">{{ iface.label }}</div>
                    <div class="portal-muted small portal-mono">{{ iface.name }}</div>
                  </td>
                  <td>
                    <div class="port-metric">
                      <div class="port-metric__bar port-metric__bar--rx" :style="{ width: perPortTrafficBarWidth(iface.rxKbps) }"></div>
                      <span>{{ formatRate(iface.rxKbps) }}</span>
                    </div>
                  </td>
                  <td>
                    <div class="port-metric">
                      <div class="port-metric__bar port-metric__bar--tx" :style="{ width: perPortTrafficBarWidth(iface.txKbps) }"></div>
                      <span>{{ formatRate(iface.txKbps) }}</span>
                    </div>
                  </td>
                  <td>
                    <div class="port-metric">
                      <div class="port-metric__bar port-metric__bar--throughput" :style="{ width: perPortTrafficBarWidth(iface.throughputKbps) }"></div>
                      <span>{{ formatRate(iface.throughputKbps) }}</span>
                    </div>
                  </td>
                  <td class="text-white">{{ formatVolumeGb(iface.totalGb) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="!perPortTrafficRows.length" class="portal-muted mt-3">
            No per-port rows available yet. If the MCU publishes only totals, this section stays empty until interface telemetry arrives.
          </div>
        </div>

        <div v-else class="portal-muted">No edge returned from backend.</div>
      </div>
    </div>

    <div class="portal-card">
      <div class="portal-card__header">
        <div>
          <span class="portal-kicker">Command center</span>
          <h3>Recovery actions</h3>
        </div>
        <span class="portal-chip portal-chip--accent">{{ selectedEdge ? formatEdgeTitle(selectedEdge) : 'Select an edge' }}</span>
      </div>

      <div v-if="commandNotice" class="alert alert-info border-0 bg-info bg-opacity-10 text-info mb-3">
        {{ commandNotice }}
      </div>

      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-outline-light" type="button" :disabled="commandBusy || !selectedEdge" @click="sendCommand('failback_vsat')">
          Switch to VSAT
        </button>
        <button class="btn btn-outline-light" type="button" :disabled="commandBusy || !selectedEdge" @click="sendCommand('failover_starlink')">
          Switch to Starlink
        </button>
        <button class="btn btn-outline-light" type="button" :disabled="commandBusy || !selectedEdge" @click="sendCommand('restore_automatic')">
          Restore automatic
        </button>
        <button class="btn btn-outline-light" type="button" :disabled="commandBusy || !selectedEdge" @click="sendCommand('policy_sync')">
          Sync policy
        </button>
      </div>

      <div class="portal-muted small mt-3">
        Commands are sent to <span class="portal-mono">{{ selectedEdge ? `${selectedEdge.tenant_code}/${selectedEdge.vessel_code}/${selectedEdge.edge_code}` : 'no edge selected' }}</span>
        and will appear in the recent jobs list with ACK/result once the MCU responds.
      </div>
      <div v-if="uiStore.rateLimit?.remaining !== null && uiStore.rateLimit?.remaining !== undefined" class="portal-muted small mt-2">
        API budget: {{ uiStore.rateLimit.remaining }}/{{ uiStore.rateLimit.limit || '?' }} remaining
      </div>
    </div>

    <div class="portal-grid portal-grid--2">
      <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Recent commands</span>
            <h3>Command jobs</h3>
          </div>
          <span class="portal-chip">{{ commands.length }} jobs</span>
        </div>

        <div class="portal-grid" style="gap: 10px;">
          <article v-for="job in commands" :key="job.id" class="portal-card" style="padding: 14px;">
            <div class="d-flex justify-content-between gap-3 align-items-start">
              <div>
                <div class="portal-kicker">{{ formatEdgeTitle(job) }}</div>
                <strong>{{ job.command_type }}</strong>
                <div class="portal-muted small">Created {{ formatDate(job.created_at) }}</div>
              </div>
              <span class="portal-chip portal-chip--accent">{{ job.status }}</span>
            </div>
          </article>
        </div>

        <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center mt-3">
          <div class="portal-muted small">
            Showing {{ commandOffset + 1 }} - {{ commandOffset + commands.length }} of latest command jobs
          </div>
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-outline-light" type="button" :disabled="commandOffset === 0" @click="prevCommandsPage">
              Prev
            </button>
            <button class="btn btn-sm btn-outline-light" type="button" :disabled="commands.length < commandPageSize" @click="nextCommandsPage">
              Next
            </button>
          </div>
        </div>
      </div>

      <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Package overview</span>
            <h3>Package workspace entry</h3>
          </div>
          <span class="portal-chip">{{ activePackages }} active</span>
        </div>

        <div class="portal-grid" style="gap: 10px;">
          <article v-for="pkg in packages.slice(0, 3)" :key="pkg.code" class="portal-card" style="padding: 14px;">
            <div class="d-flex justify-content-between align-items-start gap-3">
              <div>
                <div class="portal-kicker">{{ pkg.tenant_code || 'tenant' }}</div>
                <strong>{{ pkg.name }}</strong>
                <div class="portal-muted small">{{ pkg.code }}</div>
              </div>
              <span class="portal-chip" :class="pkg.is_active ? 'portal-chip--accent' : ''">{{ pkg.is_active ? 'Active' : 'Inactive' }}</span>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>
