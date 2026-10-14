import { render } from 'solid-js/web';
import { App } from './App.jsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
render(() => <App />, root);

// Offline app shell (installable PWA). Skipped in dev so stale caches never hide code changes.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('ServiceWorker registration failed', error);
    });
  });
}
