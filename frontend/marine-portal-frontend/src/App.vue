<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import TheSidebar from './components/TheSidebar.vue';
import PortalToastStack from './components/PortalToastStack.vue';
import { onPortalEvent } from './services/portal-events';
import { useUiStore } from './stores/ui';

const route = useRoute();
const mainContentRef = ref(null);
const uiStore = useUiStore();
let unsubscribePortalEvents = null;

const resetScroll = async () => {
  await nextTick();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  if (mainContentRef.value) {
    mainContentRef.value.scrollTop = 0;
    mainContentRef.value.scrollLeft = 0;
  }
};

watch(
  () => route.fullPath,
  () => {
    resetScroll();
  },
  { immediate: true }
);

onMounted(() => {
  unsubscribePortalEvents = onPortalEvent((event) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'toast') {
      uiStore.addToast({
        title: event.title || '',
        message: event.message || '',
        tone: event.tone || 'info',
        timeout: event.timeout ?? 4500
      });
    }

    if (event.type === 'rate-limit') {
      uiStore.setRateLimit(event.rateLimit || null);
      uiStore.setConnection({
        status: event.status === 429 ? 'limited' : 'active',
        label: event.status === 429 ? 'Rate limited' : 'Active',
        detail: event.path || '',
        tone: event.status === 429 ? 'warn' : 'good'
      });
    }

    if (event.type === 'connection') {
      uiStore.setConnection(event.connection || {});
    }

    if (event.type === 'metrics') {
      uiStore.setSystemMetrics(event.metrics || null);
    }
  });
});

onBeforeUnmount(() => {
  if (unsubscribePortalEvents) {
    unsubscribePortalEvents();
    unsubscribePortalEvents = null;
  }
});
</script>

<template>
  <div class="app-layout">
    <aside v-if="route.path !== '/login'" class="sidebar-wrapper glass-sidebar">
      <TheSidebar />
    </aside>

    <div class="main-wrapper" :class="{ 'login-mode': route.path === '/login' }">
      <div ref="mainContentRef" class="main-content" :class="{ 'login-content': route.path === '/login' }">
        <router-view v-slot="{ Component }">
          <transition name="pure-fade" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </transition>
        </router-view>
      </div>
    </div>
    <PortalToastStack />
  </div>
</template>
