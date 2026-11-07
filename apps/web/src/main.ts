import './style.css';
import { installLocalBackend } from './local/install.ts';
import { mountStatusPanel } from './local/status-panel.ts';
import { mountBlankFrontend } from './mount.ts';

// The backend runs inside this tab: requests to /search, /deconstruct and /preview never leave the browser.
installLocalBackend();
const disposeStatus = mountStatusPanel();

const root = document.getElementById('proto-root') ?? document.body;
const handle = mountBlankFrontend(root);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle.dispose();
    disposeStatus();
  });
}
