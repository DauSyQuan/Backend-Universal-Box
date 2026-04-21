<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
  assignPackage,
  createPackage,
  exportUsageReport,
  getPackageAssignment,
  getUsageReport,
  listPackageAuditWithMeta,
  listPackages,
  unassignPackageAssignment,
  updatePackage
} from '../services/api';
import { debounce } from '../utils/performance';
import { useUiStore } from '../stores/ui';

const tenantCode = ref('tnr13');
const packages = ref([]);
const usageReport = ref(null);
const packageAudit = ref([]);
const selectedAssignment = ref(null);
const loading = ref(false);
const loadError = ref('');
const actionMessage = ref('');
const backendMode = ref('loading');
const showAdvanced = ref(false);
const savingPackage = ref(false);
const savingAssignment = ref(false);
const exportingReport = ref(false);
const editingPackageId = ref(null);
const auditPageSize = ref(10);
const auditOffset = ref(0);
const uiStore = useUiStore();
const { connection, rateLimit } = storeToRefs(uiStore);
const usageFilters = ref({
  tenant: 'tnr13',
  vessel: '',
  username: '',
  packageCode: '',
  dateFrom: '',
  dateTo: '',
  bucket: 'day',
  windowMinutes: 1440
});

const form = ref({
  tenant: 'tnr13',
  code: 'basic-50gb',
  name: 'Basic 50GB',
  description: 'Starter package for pilot users',
  quota: 51200,
  validity: 30,
  price: 0,
  speedLimit: 5120,
  active: true
});

const summaryCards = computed(() => [
  {
    label: 'Packages',
    value: String(packages.value.length),
    note: backendMode.value === 'live' ? 'Loaded from /api/packages' : 'Fallback preview data',
    tone: 'accent'
  },
  {
    label: 'Active',
    value: String(packages.value.filter((item) => item.is_active !== false).length),
    note: 'Assignable packages',
    tone: 'good'
  },
  {
    label: 'Total usage',
    value: usageReport.value?.summary?.total_mb ? `${Number(usageReport.value.summary.total_mb).toFixed(0)} MB` : '0 MB',
    note: 'Current window',
    tone: 'warm'
  }
]);

const activeAssignments = computed(() => usageReport.value?.active_assignments || []);
const topUsers = computed(() => usageReport.value?.top_users || []);
const topPackages = computed(() => usageReport.value?.top_packages || []);
const timeline = computed(() => usageReport.value?.timeline || []);
const usageWindowLabel = computed(() => {
  if (usageFilters.value.dateFrom || usageFilters.value.dateTo) {
    return `${usageFilters.value.dateFrom || 'start'} → ${usageFilters.value.dateTo || 'now'}`;
  }
  return `${usageFilters.value.windowMinutes}m`;
});
const workspaceBusy = computed(() => loading.value && packages.value.length === 0 && !usageReport.value);

const formatQuota = (value) => `${(Number(value || 0) / 1024).toFixed(0)} GB`;
const formatNumber = (value) => Number(value || 0).toLocaleString();
const debouncedReloadWorkspace = debounce(() => {
  if (showAdvanced.value && !loading.value) {
    loadWorkspace();
  }
}, 450);

const setActionMessage = (message, tone = 'info') => {
  actionMessage.value = message ? { message, tone } : '';
};

const clearForm = () => {
  editingPackageId.value = null;
  form.value = {
    tenant: tenantCode.value,
    code: '',
    name: '',
    description: '',
    quota: 51200,
    validity: 30,
    price: 0,
    speedLimit: 5120,
    active: true
  };
};

const hydrateFormFromPackage = (pkg) => {
  if (!pkg) return;
  editingPackageId.value = pkg.id || null;
  form.value = {
    tenant: pkg.tenant_code || tenantCode.value,
    code: pkg.code || '',
    name: pkg.name || '',
    description: pkg.description || '',
    quota: Number(pkg.quota_mb ?? 0),
    validity: Number(pkg.validity_days ?? pkg.duration_days ?? 30),
    price: Number(pkg.price_usd ?? 0),
    speedLimit: Number(pkg.speed_limit_kbps ?? 0),
    active: pkg.is_active !== false
  };
  setActionMessage(`Editing ${pkg.code || pkg.name || 'package'}`);
};

const syncFiltersFromTenant = () => {
  usageFilters.value.tenant = tenantCode.value;
  auditOffset.value = 0;
};

const loadWorkspace = async () => {
  loading.value = true;
  loadError.value = '';

  try {
    const [packagesRes, usageRes, auditRes] = await Promise.allSettled([
      listPackages({ tenant: tenantCode.value, includeInactive: true }),
      getUsageReport({
        tenant: usageFilters.value.tenant,
        vessel: usageFilters.value.vessel || undefined,
        username: usageFilters.value.username || undefined,
        packageCode: usageFilters.value.packageCode || undefined,
        dateFrom: usageFilters.value.dateFrom || undefined,
        dateTo: usageFilters.value.dateTo || undefined,
        bucket: usageFilters.value.bucket,
        windowMinutes: Number(usageFilters.value.windowMinutes || 1440)
      }),
      listPackageAuditWithMeta({
        tenant: usageFilters.value.tenant,
        vessel: usageFilters.value.vessel || undefined,
        username: usageFilters.value.username || undefined,
        packageCode: usageFilters.value.packageCode || undefined,
        dateFrom: usageFilters.value.dateFrom || undefined,
        dateTo: usageFilters.value.dateTo || undefined,
        limit: auditPageSize.value,
        offset: auditOffset.value
      })
    ]);

    if (packagesRes.status === 'fulfilled' && Array.isArray(packagesRes.value)) {
      packages.value = packagesRes.value;
      if (!editingPackageId.value && packages.value.length > 0) {
        hydrateFormFromPackage(packages.value[0]);
      }
    }

    if (usageRes.status === 'fulfilled') {
      usageReport.value = usageRes.value;
    }

    if (auditRes.status === 'fulfilled') {
      const auditPayload = auditRes.value?.payload || auditRes.value;
      packageAudit.value = Array.isArray(auditPayload?.items) ? auditPayload.items : (Array.isArray(auditPayload) ? auditPayload : []);
    }

    backendMode.value = packagesRes.status === 'fulfilled' || usageRes.status === 'fulfilled' || auditRes.status === 'fulfilled'
      ? 'live'
      : 'fallback';

    if (packages.value.length === 0) {
      packages.value = [
        {
          code: 'basic-50gb',
          name: 'Basic 50GB',
          description: 'Starter package for pilot users',
          quota_mb: 51200,
          validity_days: 30,
          price_usd: 0,
          speed_limit_kbps: 5120,
          is_active: true,
          tenant_code: tenantCode.value
        }
      ];
      if (!editingPackageId.value) {
        hydrateFormFromPackage(packages.value[0]);
      }
    }

    syncFiltersFromTenant();
  } catch (error) {
    backendMode.value = 'fallback';
    loadError.value = error?.message || 'Unable to load package workspace';
  } finally {
    loading.value = false;
  }
};

watch(
  usageFilters,
  () => {
    if (showAdvanced.value) {
      auditOffset.value = 0;
      debouncedReloadWorkspace();
    }
  },
  { deep: true }
);

watch(
  () => showAdvanced.value,
  (enabled) => {
    if (enabled && !usageReport.value) {
      loadWorkspace();
    }
  }
);

const savePackage = async () => {
  savingPackage.value = true;
  loadError.value = '';
  setActionMessage('');

  try {
    const payload = {
      tenant_code: form.value.tenant,
      code: form.value.code,
      name: form.value.name,
      description: form.value.description,
      quota_mb: Number(form.value.quota),
      validity_days: Number(form.value.validity),
      price_usd: Number(form.value.price),
      speed_limit_kbps: Number(form.value.speedLimit),
      is_active: form.value.active
    };

    if (editingPackageId.value) {
      await updatePackage(editingPackageId.value, payload);
      setActionMessage('Package updated successfully', 'success');
    } else {
      await createPackage(payload);
      setActionMessage('Package created successfully', 'success');
    }

    await loadWorkspace();
  } catch (error) {
    loadError.value = error?.message || 'Unable to save package';
  } finally {
    savingPackage.value = false;
  }
};

const togglePackageActive = async (pkg) => {
  try {
    await updatePackage(pkg.id, {
      tenant_code: pkg.tenant_code,
      code: pkg.code,
      name: pkg.name,
      description: pkg.description,
      quota_mb: pkg.quota_mb,
      validity_days: pkg.validity_days ?? pkg.duration_days ?? 30,
      price_usd: pkg.price_usd ?? 0,
      speed_limit_kbps: pkg.speed_limit_kbps,
      is_active: !pkg.is_active
    });
    setActionMessage(`${pkg.code} ${pkg.is_active ? 'archived' : 'restored'}`, 'success');
    await loadWorkspace();
  } catch (error) {
    loadError.value = error?.message || 'Unable to update package';
  }
};

const assignToAsset = async (pkg) => {
  const vesselCode = window.prompt('Enter vessel code', 'vsl-001');
  if (!vesselCode) return;
  const username = window.prompt('Enter username', 'crew01');
  if (!username) return;

  savingAssignment.value = true;
  loadError.value = '';
  setActionMessage('');

  try {
    await assignPackage(pkg.id, {
      vessel_code: vesselCode.trim(),
      username: username.trim()
    });
    setActionMessage(`Assigned ${pkg.code} to ${username} on ${vesselCode}`, 'success');
    await loadWorkspace();
  } catch (error) {
    loadError.value = error?.message || 'Unable to assign package';
  } finally {
    savingAssignment.value = false;
  }
};

const openAssignment = async (assignment) => {
  if (!assignment?.id) return;
  selectedAssignment.value = { loading: true, id: assignment.id };
  try {
    const detail = await getPackageAssignment(assignment.id);
    selectedAssignment.value = detail;
  } catch (error) {
    selectedAssignment.value = {
      loading: false,
      error: error?.message || 'Unable to load assignment detail'
    };
  }
};

const removeAssignment = async (assignment) => {
  const confirmed = window.confirm(`Unassign ${assignment.package_code} from ${assignment.username} on ${assignment.vessel_code}?`);
  if (!confirmed) return;

  savingAssignment.value = true;
  try {
    await unassignPackageAssignment(assignment.id);
    setActionMessage('Assignment cancelled', 'success');
    if (selectedAssignment.value?.assignment?.id === assignment.id) {
      selectedAssignment.value = null;
    }
    await loadWorkspace();
  } catch (error) {
    loadError.value = error?.message || 'Unable to cancel assignment';
  } finally {
    savingAssignment.value = false;
  }
};

const exportReport = async () => {
  exportingReport.value = true;
  loadError.value = '';

  try {
    const blob = await exportUsageReport({
      tenant: usageFilters.value.tenant,
      vessel: usageFilters.value.vessel || undefined,
      username: usageFilters.value.username || undefined,
      packageCode: usageFilters.value.packageCode || undefined,
      dateFrom: usageFilters.value.dateFrom || undefined,
      dateTo: usageFilters.value.dateTo || undefined,
      bucket: usageFilters.value.bucket,
      windowMinutes: Number(usageFilters.value.windowMinutes || 1440)
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `usage-report-${tenantCode.value}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setActionMessage('Usage CSV exported', 'success');
  } catch (error) {
    loadError.value = error?.message || 'Unable to export report';
  } finally {
    exportingReport.value = false;
  }
};

const prevAuditPage = async () => {
  auditOffset.value = Math.max(0, auditOffset.value - auditPageSize.value);
  await loadWorkspace();
};

const nextAuditPage = async () => {
  auditOffset.value += auditPageSize.value;
  await loadWorkspace();
};

const formatDate = (value) => {
  if (!value) return 'No data';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

onMounted(() => {
  loadWorkspace();
});
</script>

<template>
  <section class="portal-page">
    <div class="portal-card">
      <div class="portal-card__header">
        <div>
          <span class="portal-kicker">Package workspace</span>
          <h2>Package catalog</h2>
          <p class="portal-muted mb-0">Create, edit, assign, and audit packages without leaving the portal.</p>
        </div>
        <div class="d-flex gap-2 flex-wrap justify-content-end">
          <button class="btn btn-sm btn-outline-light" type="button" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? 'Simple view' : 'Advanced' }}
          </button>
          <button class="btn btn-sm btn-outline-info" type="button" @click="exportReport" :disabled="exportingReport || !showAdvanced">
            {{ exportingReport ? 'Exporting...' : 'Export CSV' }}
          </button>
          <button class="btn btn-sm btn-outline-light" type="button" @click="loadWorkspace" :disabled="loading">
            {{ loading ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
      </div>

      <div v-if="loadError" class="alert alert-warning border-0 bg-warning bg-opacity-10 text-warning mb-3">
        {{ loadError }}
      </div>

      <div v-if="actionMessage" class="alert border-0 mb-3" :class="actionMessage.tone === 'success' ? 'alert-success bg-success bg-opacity-10 text-success' : 'alert-info bg-info bg-opacity-10 text-info'">
        {{ actionMessage.message }}
      </div>

      <div class="portal-grid portal-grid--3">
        <template v-if="workspaceBusy">
          <div v-for="n in 3" :key="`pkg-skel-${n}`" class="portal-card portal-skeleton-card" style="padding: 16px;">
            <div class="portal-skeleton portal-skeleton--line w-40"></div>
            <div class="portal-skeleton portal-skeleton--title w-70"></div>
            <div class="portal-skeleton portal-skeleton--line w-80"></div>
          </div>
        </template>
        <div v-for="card in summaryCards" :key="card.label" class="portal-card" style="padding: 16px;">
          <div class="d-flex justify-content-between align-items-start gap-3 mb-2">
            <span class="portal-kicker">{{ card.label }}</span>
            <span class="portal-chip" :class="card.tone === 'accent' ? 'portal-chip--accent' : ''">{{ backendMode === 'live' ? 'Live' : 'Demo' }}</span>
          </div>
          <h3 class="mb-1">{{ card.value }}</h3>
          <p class="portal-muted mb-0">{{ card.note }}</p>
        </div>
      </div>

      <div class="portal-grid portal-grid--2 mt-4">
        <div class="portal-card" style="padding: 16px;">
          <span class="portal-kicker">Workspace status</span>
          <div class="d-flex flex-wrap gap-2 mt-2">
            <span class="status-pill status-good">Tenant {{ tenantCode }}</span>
            <span class="status-pill" :class="backendMode === 'live' ? 'status-good' : 'status-warn'">{{ backendMode }}</span>
            <span class="status-pill" :class="showAdvanced ? 'status-good' : 'status-muted'">{{ showAdvanced ? 'Advanced on' : 'Simple mode' }}</span>
          </div>
          <div class="d-flex flex-wrap gap-2 mt-3">
            <span class="status-pill" :class="connection?.tone === 'good' ? 'status-good' : connection?.tone === 'warn' ? 'status-warn' : 'status-muted'">
              {{ connection?.label || 'Monitoring' }}
            </span>
            <span v-if="rateLimit?.remaining !== null && rateLimit?.remaining !== undefined" class="status-pill status-muted">
              Rate {{ rateLimit.remaining }}/{{ rateLimit.limit || '?' }}
            </span>
          </div>
        </div>
        <div class="portal-card" style="padding: 16px;">
          <span class="portal-kicker">Usage window</span>
          <div class="d-flex flex-wrap gap-2 mt-2" v-if="usageReport?.summary">
            <span class="portal-chip portal-chip--accent">Samples {{ usageReport.summary.samples }}</span>
            <span class="portal-chip">Users {{ usageReport.summary.users }}</span>
            <span class="portal-chip">Packages {{ usageReport.summary.packages }}</span>
          </div>
          <div v-else class="portal-muted mt-2">Usage summary will appear after backend data loads.</div>
        </div>
      </div>
    </div>

    <div class="portal-grid portal-grid--2">
      <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Package management</span>
            <h3>{{ editingPackageId ? 'Edit package' : 'Create package' }}</h3>
          </div>
          <span class="portal-chip portal-chip--accent">Phase 3</span>
        </div>

        <div class="portal-grid" style="gap: 12px;">
          <div class="portal-grid portal-grid--2" style="gap: 12px;">
            <label>
              <div class="portal-kicker">Tenant code</div>
              <input class="form-control" v-model="form.tenant" />
            </label>
            <label>
              <div class="portal-kicker">Package code</div>
              <input class="form-control" v-model="form.code" />
            </label>
          </div>

          <label>
            <div class="portal-kicker">Name</div>
            <input class="form-control" v-model="form.name" />
          </label>

          <label>
            <div class="portal-kicker">Description</div>
            <textarea class="form-control" rows="3" v-model="form.description"></textarea>
          </label>

          <div class="portal-grid portal-grid--2" style="gap: 12px;">
            <label>
              <div class="portal-kicker">Quota MB</div>
              <input class="form-control portal-mono" type="number" v-model="form.quota" />
            </label>
            <label>
              <div class="portal-kicker">Validity days</div>
              <input class="form-control portal-mono" type="number" v-model="form.validity" />
            </label>
          </div>

          <div class="portal-grid portal-grid--2" style="gap: 12px;">
            <label>
              <div class="portal-kicker">Price USD</div>
              <input class="form-control portal-mono" type="number" v-model="form.price" />
            </label>
            <label>
              <div class="portal-kicker">Speed limit Kbps</div>
              <input class="form-control portal-mono" type="number" v-model="form.speedLimit" />
            </label>
          </div>

          <div class="d-flex align-items-center justify-content-between flex-wrap gap-3">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" v-model="form.active" id="pkgActive" />
              <label class="form-check-label" for="pkgActive">Active</label>
            </div>
            <div class="d-flex gap-2">
              <button class="btn btn-outline-light" type="button" @click="clearForm">Reset</button>
              <button class="btn btn-primary" type="button" @click="savePackage" :disabled="savingPackage">
                {{ savingPackage ? 'Saving...' : 'Save package' }}
              </button>
            </div>
          </div>

          <div class="portal-muted">Use this form to create a new package or edit an existing one.</div>
        </div>
      </div>

        <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Package catalog</span>
            <h3>Available packages</h3>
          </div>
          <span class="portal-chip">{{ packages.length }} items</span>
        </div>

        <div v-if="workspaceBusy" class="portal-grid" style="gap: 12px;">
          <div class="portal-skeleton portal-skeleton--block"></div>
          <div class="portal-skeleton portal-skeleton--block"></div>
          <div class="portal-skeleton portal-skeleton--block"></div>
        </div>
        <div v-else class="portal-grid" style="gap: 12px;">
          <article v-for="pkg in packages" :key="pkg.id || pkg.code" class="portal-card" style="padding: 16px;">
            <div class="d-flex justify-content-between align-items-start gap-3">
              <div>
                <div class="portal-kicker">{{ pkg.tenant_code || form.tenant.toUpperCase() }}</div>
                <h4>{{ pkg.name }}</h4>
                <p class="portal-muted mb-0">{{ pkg.description }}</p>
              </div>
              <span class="portal-chip" :class="pkg.is_active ? 'portal-chip--accent' : ''">{{ pkg.code }}</span>
            </div>

            <div class="portal-grid portal-grid--2 mt-3" style="gap: 12px;">
              <div>
                <div class="portal-kicker">Quota</div>
                <strong>{{ formatQuota(pkg.quota_mb) }}</strong>
              </div>
              <div>
                <div class="portal-kicker">Validity</div>
                <strong>{{ pkg.validity_days }} days</strong>
              </div>
              <div>
                <div class="portal-kicker">Price</div>
                <strong>${{ Number(pkg.price_usd || 0).toFixed(2) }}</strong>
              </div>
              <div>
                <div class="portal-kicker">Status</div>
                <strong :class="pkg.is_active ? 'text-success' : 'text-warning'">{{ pkg.is_active ? 'Active' : 'Inactive' }}</strong>
              </div>
            </div>

            <div class="d-flex gap-2 flex-wrap mt-3">
              <button class="btn btn-sm btn-outline-light" type="button" @click="hydrateFormFromPackage(pkg)">Edit</button>
              <button class="btn btn-sm btn-outline-light" type="button" @click="assignToAsset(pkg)" :disabled="savingAssignment">Assign</button>
              <button class="btn btn-sm btn-outline-light" type="button" @click="togglePackageActive(pkg)">
                {{ pkg.is_active ? 'Archive' : 'Restore' }}
              </button>
            </div>
          </article>
        </div>
      </div>
    </div>

      <div v-if="showAdvanced" class="portal-grid portal-grid--2">
      <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Usage aggregation</span>
            <h3>Current window</h3>
          </div>
          <span class="portal-chip">{{ usageWindowLabel }}</span>
        </div>

        <div class="portal-grid portal-grid--3 mb-3" style="gap: 12px;">
          <label>
            <div class="portal-kicker">Tenant</div>
            <input class="form-control" v-model="usageFilters.tenant" />
          </label>
          <label>
            <div class="portal-kicker">Vessel</div>
            <input class="form-control" v-model="usageFilters.vessel" placeholder="Optional" />
          </label>
          <label>
            <div class="portal-kicker">Username</div>
            <input class="form-control" v-model="usageFilters.username" placeholder="Optional" />
          </label>
          <label>
            <div class="portal-kicker">Package code</div>
            <input class="form-control" v-model="usageFilters.packageCode" placeholder="Optional" />
          </label>
          <label>
            <div class="portal-kicker">Date from</div>
            <input class="form-control" type="datetime-local" v-model="usageFilters.dateFrom" />
          </label>
          <label>
            <div class="portal-kicker">Date to</div>
            <input class="form-control" type="datetime-local" v-model="usageFilters.dateTo" />
          </label>
          <label>
            <div class="portal-kicker">Bucket</div>
            <select class="form-select" v-model="usageFilters.bucket">
              <option value="hour">Hour</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
            </select>
          </label>
          <label>
            <div class="portal-kicker">Window minutes</div>
            <input class="form-control" type="number" v-model="usageFilters.windowMinutes" />
          </label>
          <div class="d-flex align-items-end gap-2">
            <button class="btn btn-outline-light" type="button" @click="syncFiltersFromTenant">Sync tenant</button>
            <button class="btn btn-primary" type="button" @click="loadWorkspace">Apply filters</button>
          </div>
        </div>

        <div v-if="usageReport" class="portal-grid portal-grid--3 mb-3">
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Total</span>
            <strong>{{ formatNumber(usageReport.summary.total_mb) }} MB</strong>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Users</span>
            <strong>{{ usageReport.summary.users }}</strong>
          </div>
          <div class="portal-card" style="padding: 14px;">
            <span class="portal-kicker">Assignments</span>
            <strong>{{ usageReport.summary.assignments }}</strong>
          </div>
        </div>

        <div class="table-responsive">
          <table class="table table-borderless align-middle mb-0 portal-mono">
            <thead>
              <tr class="text-uppercase portal-muted" style="font-size: 0.72rem; letter-spacing: 0.12em;">
                <th>Window</th>
                <th>User</th>
                <th>Package</th>
                <th class="text-end">Usage</th>
              </tr>
            </thead>
            <tbody>
            <tr v-for="row in topUsers" :key="row.username + row.package_code">
              <td>Today</td>
              <td>
                <div class="fw-semibold text-white">{{ row.username }}</div>
                <div class="portal-muted small">{{ row.vessel_code }}</div>
                </td>
                <td>{{ row.package_code }}</td>
                <td class="text-end text-white">{{ Number(row.total_mb || 0).toFixed(0) }} MB</td>
              </tr>
              <tr v-if="topUsers.length === 0">
                <td colspan="4" class="text-center py-4 portal-muted">No usage data in the current window.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-4">
          <div class="portal-card__header mb-2">
            <div>
              <span class="portal-kicker">Timeline</span>
              <h3>Window buckets</h3>
            </div>
            <span class="portal-chip">{{ timeline.length }} buckets</span>
          </div>
          <div class="portal-grid portal-grid--3">
            <div v-for="bucket in timeline.slice(0, 6)" :key="bucket.bucket_at" class="portal-card" style="padding: 14px;">
              <span class="portal-kicker">{{ formatDate(bucket.bucket_at) }}</span>
              <strong>{{ Number(bucket.total_mb || 0).toFixed(0) }} MB</strong>
              <div class="portal-muted small">{{ bucket.samples }} samples</div>
            </div>
          </div>
        </div>

        <div class="mt-4">
          <div class="portal-card__header mb-2">
            <div>
            <span class="portal-kicker">Top packages</span>
            <h3>Most active package groups</h3>
          </div>
            <span class="portal-chip">{{ topPackages.length }} packages</span>
          </div>
          <div class="table-responsive">
            <table class="table table-borderless align-middle mb-0 portal-mono">
              <thead>
                <tr class="text-uppercase portal-muted" style="font-size: 0.72rem; letter-spacing: 0.12em;">
                  <th>Package</th>
                  <th>Users</th>
                  <th class="text-end">Usage</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in topPackages.slice(0, 6)" :key="row.package_code">
                  <td>
                    <div class="fw-semibold text-white">{{ row.package_name }}</div>
                    <div class="portal-muted small">{{ row.package_code }}</div>
                  </td>
                  <td>{{ row.user_count }}</td>
                  <td class="text-end text-white">{{ Number(row.total_mb || 0).toFixed(0) }} MB</td>
                </tr>
                <tr v-if="topPackages.length === 0">
                  <td colspan="3" class="text-center py-3 portal-muted">No package usage yet.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="portal-card">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Assignment detail</span>
            <h3>Active assignments</h3>
          </div>
          <span class="portal-chip">{{ activeAssignments.length }} active</span>
        </div>

        <div v-if="workspaceBusy" class="portal-grid" style="gap: 10px;">
          <div class="portal-skeleton portal-skeleton--block"></div>
          <div class="portal-skeleton portal-skeleton--block"></div>
        </div>
        <div v-else class="portal-grid" style="gap: 10px;">
          <article v-for="assignment in activeAssignments" :key="assignment.id" class="portal-card" style="padding: 14px;">
            <div class="d-flex justify-content-between align-items-start gap-3">
              <div>
                <div class="portal-kicker">{{ assignment.tenant_code }}/{{ assignment.vessel_code }}</div>
                <strong>{{ assignment.username }}</strong>
                <div class="portal-muted small">{{ assignment.package_code }} · {{ assignment.package_name }}</div>
              </div>
              <span class="portal-chip portal-chip--accent">{{ Number(assignment.remaining_mb || 0).toFixed(0) }} MB left</span>
            </div>

            <div class="d-flex gap-2 flex-wrap mt-3">
              <button class="btn btn-sm btn-outline-light" type="button" @click="openAssignment(assignment)">View</button>
              <button class="btn btn-sm btn-outline-light" type="button" @click="removeAssignment(assignment)" :disabled="savingAssignment">Unassign</button>
            </div>
          </article>

          <div v-if="activeAssignments.length === 0" class="portal-muted">No active assignments found.</div>
        </div>

        <div v-if="selectedAssignment" class="portal-card mt-4" style="padding: 16px;">
          <div class="portal-card__header">
            <div>
              <span class="portal-kicker">Selected assignment</span>
              <h3>{{ selectedAssignment.assignment?.package_code || 'Assignment detail' }}</h3>
            </div>
            <button class="btn btn-sm btn-outline-light" type="button" @click="selectedAssignment = null">Close</button>
          </div>

          <div v-if="selectedAssignment.loading" class="portal-muted">
            <div class="portal-skeleton portal-skeleton--line w-55 mb-2"></div>
            <div class="portal-skeleton portal-skeleton--block"></div>
          </div>
          <div v-else-if="selectedAssignment.error" class="portal-muted">{{ selectedAssignment.error }}</div>
          <div v-else-if="selectedAssignment.assignment">
            <div class="portal-grid portal-grid--2" style="gap: 12px;">
              <div class="portal-card" style="padding: 14px;">
                <span class="portal-kicker">User</span>
                <strong>{{ selectedAssignment.assignment.username }}</strong>
                <div class="portal-muted small">{{ selectedAssignment.assignment.tenant_name }}</div>
              </div>
              <div class="portal-card" style="padding: 14px;">
                <span class="portal-kicker">Package</span>
                <strong>{{ selectedAssignment.assignment.package_name }}</strong>
                <div class="portal-muted small">{{ selectedAssignment.assignment.package_code }}</div>
              </div>
              <div class="portal-card" style="padding: 14px;">
                <span class="portal-kicker">Quota</span>
                <strong>{{ Number(selectedAssignment.assignment.quota_mb || 0).toFixed(0) }} MB</strong>
                <div class="portal-muted small">Remaining {{ Number(selectedAssignment.assignment.remaining_mb || 0).toFixed(0) }} MB</div>
              </div>
              <div class="portal-card" style="padding: 14px;">
                <span class="portal-kicker">Status</span>
                <strong>{{ selectedAssignment.assignment.status }}</strong>
                <div class="portal-muted small">Expires {{ formatDate(selectedAssignment.assignment.expires_at) }}</div>
              </div>
            </div>

            <div class="portal-grid portal-grid--2 mt-3" style="gap: 12px;">
              <div>
                <span class="portal-kicker">Recent usage</span>
                <div class="table-responsive mt-2">
                  <table class="table table-borderless align-middle mb-0 portal-mono">
                    <thead>
                      <tr class="text-uppercase portal-muted" style="font-size: 0.72rem; letter-spacing: 0.12em;">
                        <th>Seen</th>
                        <th>Session</th>
                        <th class="text-end">Usage</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in selectedAssignment.recent_usage || []" :key="row.session_id + row.observed_at">
                        <td>{{ formatDate(row.observed_at) }}</td>
                        <td>{{ row.session_id }}</td>
                        <td class="text-end">{{ Number(row.total_mb || 0).toFixed(0) }} MB</td>
                      </tr>
                      <tr v-if="!selectedAssignment.recent_usage || selectedAssignment.recent_usage.length === 0">
                        <td colspan="3" class="text-center py-3 portal-muted">No recent usage entries.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <span class="portal-kicker">Alerts</span>
                <div class="portal-grid" style="gap: 10px; margin-top: 8px;">
                  <div v-for="alert in selectedAssignment.alerts || []" :key="alert.created_at + alert.alert_type" class="portal-card" style="padding: 14px;">
                    <strong>{{ alert.alert_type }}</strong>
                    <div class="portal-muted small">{{ alert.message }}</div>
                  </div>
                  <div v-if="!selectedAssignment.alerts || selectedAssignment.alerts.length === 0" class="portal-muted">No alerts for this assignment.</div>
                </div>
              </div>
            </div>

            <div class="mt-3">
              <span class="portal-kicker">Audit history</span>
              <div class="portal-grid" style="gap: 10px; margin-top: 8px;">
                <div v-for="event in selectedAssignment.audit_history || []" :key="event.created_at + event.action_type" class="portal-card" style="padding: 14px;">
                  <strong>{{ event.action_type }}</strong>
                  <div class="portal-muted small">{{ event.actor_username || 'system' }} · {{ formatDate(event.created_at) }}</div>
                </div>
                <div v-if="!selectedAssignment.audit_history || selectedAssignment.audit_history.length === 0" class="portal-muted">No audit entries for this assignment.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showAdvanced" class="portal-card mt-4">
        <div class="portal-card__header">
          <div>
            <span class="portal-kicker">Audit history</span>
            <h3>Recent mutations</h3>
          </div>
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <span class="portal-chip">{{ packageAudit.length }} events</span>
            <div class="d-flex gap-2">
              <button class="btn btn-sm btn-outline-light" type="button" :disabled="auditOffset === 0" @click="prevAuditPage">Prev</button>
              <button class="btn btn-sm btn-outline-light" type="button" :disabled="packageAudit.length < auditPageSize" @click="nextAuditPage">Next</button>
            </div>
          </div>
        </div>
      <div class="portal-muted small mb-3">
        Showing {{ auditOffset + 1 }} - {{ auditOffset + packageAudit.length }} audit events
      </div>

      <div class="portal-grid" style="gap: 10px;">
        <div v-for="event in packageAudit" :key="event.id" class="portal-card" style="padding: 14px;">
          <div class="d-flex justify-content-between gap-3 align-items-start">
            <div>
              <div class="portal-kicker">{{ formatDate(event.created_at) }}</div>
              <strong>{{ event.action_type }}</strong>
              <div class="portal-muted small">{{ event.actor_username || 'system' }}</div>
            </div>
            <span class="portal-chip portal-chip--accent">{{ event.package_code }}</span>
          </div>
        </div>
        <div v-if="packageAudit.length === 0" class="portal-muted">No audit entries found.</div>
      </div>
    </div>
  </section>
</template>
