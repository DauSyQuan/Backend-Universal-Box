<script setup>
import { storeToRefs } from 'pinia';
import { useUiStore } from '../stores/ui';

const uiStore = useUiStore();
const { toasts } = storeToRefs(uiStore);
</script>

<template>
  <div class="portal-toast-stack">
    <TransitionGroup name="toast-slide" tag="div" class="portal-toast-stack__inner">
      <article v-for="toast in toasts" :key="toast.id" class="portal-toast" :class="`portal-toast--${toast.tone}`">
        <div class="portal-toast__body">
          <strong v-if="toast.title" class="portal-toast__title">{{ toast.title }}</strong>
          <div class="portal-toast__message">{{ toast.message }}</div>
        </div>
        <button class="portal-toast__close btn btn-sm btn-outline-light" type="button" @click="uiStore.removeToast(toast.id)">
          <i class="bi bi-x-lg"></i>
        </button>
      </article>
    </TransitionGroup>
  </div>
</template>
