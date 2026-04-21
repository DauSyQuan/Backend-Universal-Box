<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { clearStoredBasicAuthHeader, getStoredBasicAuthHeader, saveBasicAuth } from '../services/auth';

const router = useRouter();
const username = ref('');
const password = ref('');
const notice = ref('');

const hasSavedAuth = computed(() => Boolean(getStoredBasicAuthHeader()));

const submit = async () => {
  if (!username.value.trim() || !password.value) {
    notice.value = 'Username and password are required.';
    return;
  }

  saveBasicAuth(username.value, password.value);
  notice.value = 'Auth header saved for this browser.';
  await router.replace('/dashboard');
};

const clearAuth = async () => {
  clearStoredBasicAuthHeader();
  username.value = '';
  password.value = '';
  notice.value = 'Saved auth cleared.';
};

onMounted(() => {
  const stored = getStoredBasicAuthHeader();
  if (stored) {
    notice.value = 'Auth header already saved in this browser.';
  }
});
</script>

<template>
  <section class="portal-page portal-page--login">
    <div class="portal-card login-shell">
      <div class="portal-card__header">
        <div>
          <span class="portal-kicker">Access</span>
          <h2>Auth settings</h2>
          <p class="portal-muted mb-0">Save HTTP Basic Auth locally for API requests in this browser.</p>
        </div>
        <span class="portal-chip portal-chip--accent">{{ hasSavedAuth ? 'Saved' : 'Not saved' }}</span>
      </div>

      <div v-if="notice" class="alert alert-info border-0 bg-info bg-opacity-10 text-info mb-3">
        {{ notice }}
      </div>

      <div class="portal-grid portal-grid--2">
        <label>
          <div class="portal-kicker">Username</div>
          <input v-model="username" class="form-control" autocomplete="username" placeholder="admin" />
        </label>
        <label>
          <div class="portal-kicker">Password</div>
          <input v-model="password" type="password" class="form-control" autocomplete="current-password" placeholder="••••••••" />
        </label>
      </div>

      <div class="d-flex gap-2 justify-content-end mt-4">
        <button class="btn btn-outline-light" type="button" @click="clearAuth">Clear saved auth</button>
        <button class="btn btn-primary" type="button" @click="submit">Save and continue</button>
      </div>
    </div>
  </section>
</template>
