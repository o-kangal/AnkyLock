import { render } from 'solid-js/web';
import { App } from './App.jsx';
import { applyColorScheme, initialColorScheme } from '@ankylock/web/workspace';
import { drawsWindowCorners, TRANSPARENT_WINDOW_ATTRIBUTE } from './windowFrame.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
if (drawsWindowCorners()) {
  document.documentElement.setAttribute(TRANSPARENT_WINDOW_ATTRIBUTE, '');
  document.body.style.background = 'transparent';
}
// Before the first render, so the stored dark/light choice never flashes the other one.
applyColorScheme(initialColorScheme());
render(() => <App />, root);
