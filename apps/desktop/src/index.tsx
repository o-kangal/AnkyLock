import { render } from 'solid-js/web';
import { App } from './App.jsx';
import { applyColorScheme, initialColorScheme } from '@ankylock/web/workspace';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
// Before the first render, so the stored dark/light choice never flashes the other one.
applyColorScheme(initialColorScheme());
render(() => <App />, root);
