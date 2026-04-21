import { defineStore } from 'pinia';

let nextToastId = 1;

export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: [],
    connection: {
      status: 'idle',
      label: 'Idle',
      detail: '',
      tone: 'muted'
    },
    rateLimit: null,
    systemMetrics: null
  }),
  actions: {
    addToast({ title = '', message = '', tone = 'info', timeout = 4500 }) {
      const id = nextToastId++;
      const toast = { id, title, message, tone, timeout };
      this.toasts.unshift(toast);

      if (timeout > 0) {
        const timer = window.setTimeout(() => {
          this.removeToast(id);
        }, timeout);
        toast.timer = timer;
      }

      return id;
    },
    removeToast(id) {
      const toast = this.toasts.find((item) => item.id === id);
      if (toast?.timer) {
        clearTimeout(toast.timer);
      }
      this.toasts = this.toasts.filter((item) => item.id !== id);
    },
    clearToasts() {
      for (const toast of this.toasts) {
        if (toast?.timer) {
          clearTimeout(toast.timer);
        }
      }
      this.toasts = [];
    },
    setConnection(connection) {
      this.connection = {
        ...this.connection,
        ...connection
      };
    },
    setRateLimit(rateLimit) {
      this.rateLimit = rateLimit ? { ...rateLimit } : null;
    },
    setSystemMetrics(metrics) {
      this.systemMetrics = metrics ? { ...metrics } : null;
    }
  }
});
