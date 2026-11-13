// Single source of truth for the build version.
// Zip filename MUST match `filename` exactly.
self.BUILD_INFO = {
  version: 'v2.1',
  filename: 'photo-invoice-v2.1',
  date: '2026-11-13',
  apiBase: 'https://n8n.12wqa.com/webhook', // n8n API used when the app is hosted on its own server
  notes: 'Self-hosted build (Unraid nginx + tunnel): saved settings and offline mode work again'
};
