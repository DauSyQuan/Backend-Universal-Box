import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from '../views/DashboardView.vue';
import LoginView from '../views/LoginView.vue';
import PackageCatalogView from '../views/PackageCatalogView.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/dashboard'
    },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { title: 'Auth settings' }
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: DashboardView,
      meta: { title: 'Executive summary' }
    },
    {
      path: '/package-catalog',
      name: 'package-catalog',
      component: PackageCatalogView,
      meta: { title: 'Package catalog' }
    }
  ]
});

router.afterEach((to) => {
  const baseTitle = 'Marine Portal';
  document.title = to.meta?.title ? `${to.meta.title} | ${baseTitle}` : baseTitle;
});

export default router;
