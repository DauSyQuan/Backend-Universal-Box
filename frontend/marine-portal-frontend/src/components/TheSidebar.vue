<script setup>
import { storeToRefs } from 'pinia';
import { useUiStore } from '../stores/ui';

const uiStore = useUiStore();
const { connection, rateLimit } = storeToRefs(uiStore);

const navItems = [
  { to: '/dashboard', icon: 'bi-pie-chart-fill', label: 'Executive summary' },
  { to: '/package-catalog', icon: 'bi-box-seam-fill', label: 'Package catalog' }
];
</script>

<template>
  <div class="sidebar-shell">
    <div class="sidebar-header">
      <div class="logo-container">
        <i class="bi bi-anchor"></i>
      </div>
      <div class="brand-text">
        <h5 class="m-0 fw-bold text-white tracking-wide">MARINE PRO</h5>
        <small class="text-blue-300" style="font-size: 0.65rem; letter-spacing: 2px;">FLEET OPS</small>
      </div>
    </div>

    <nav class="sidebar-nav">
      <div class="nav-label">Main Menu</div>

      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        active-class="active"
      >
        <i class="bi" :class="item.icon"></i>
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="sidebar-footer">
      <div class="user-glass-card">
        <div class="d-flex align-items-center gap-3">
          <div class="user-avatar">
            M
            <span class="status-dot"></span>
          </div>

          <div class="user-info">
            <div class="fw-bold text-white text-truncate" style="max-width: 120px;">Marine Ops</div>
            <div class="text-white-50 small" style="font-size: 0.7rem;">
              {{ connection?.label || 'Monitoring mode' }}
            </div>
          </div>
          <router-link to="/login" class="btn btn-sm btn-outline-light" style="white-space: nowrap;">Auth</router-link>
        </div>

        <div class="d-flex flex-wrap gap-2 mt-3">
          <span class="status-pill" :class="connection?.tone === 'good' ? 'status-good' : connection?.tone === 'warn' ? 'status-warn' : 'status-muted'">
            {{ connection?.status || 'idle' }}
          </span>
          <span v-if="rateLimit?.remaining !== null && rateLimit?.remaining !== undefined" class="status-pill status-muted">
            Rate {{ rateLimit.remaining }}/{{ rateLimit.limit || '?' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
