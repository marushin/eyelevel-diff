import './style.css';
import { mountBlankFrontend } from './mount.ts';

const root = document.getElementById('proto-root') ?? document.body;
const handle = mountBlankFrontend(root);

if (import.meta.hot) {
  import.meta.hot.dispose(() => handle.dispose());
}
