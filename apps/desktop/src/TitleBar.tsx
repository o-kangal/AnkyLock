import { getCurrentWindow } from '@tauri-apps/api/window';
import type { JSX } from 'solid-js';
import logoUrl from '../src-tauri/icons/app-icon.svg';

const buttonStyle: JSX.CSSProperties = {
  width: '44px',
  height: '100%',
  border: 'none',
  background: 'transparent',
  font: '13px system-ui, sans-serif',
  cursor: 'pointer',
};

/** Custom title bar for the frameless window; the empty area drags the window. */
export function TitleBar(): JSX.Element {
  const appWindow = getCurrentWindow();
  return (
    <header
      data-tauri-drag-region
      style={{
        display: 'flex',
        'align-items': 'center',
        height: '32px',
        'padding-left': '12px',
        font: '12px system-ui, sans-serif',
        'user-select': 'none',
        'border-bottom': '1px solid rgba(127, 127, 127, 0.25)',
      }}
    >
      {/* Clicks pass through the logo to the header, so dragging it moves the window. */}
      <img
        src={logoUrl}
        alt=""
        width="16"
        height="16"
        draggable={false}
        style={{ 'margin-right': '8px', 'pointer-events': 'none' }}
      />
      <span data-tauri-drag-region style={{ flex: '1' }}>
        AnkyLock
      </span>
      <button type="button" aria-label="Minimize" style={buttonStyle} onClick={() => void appWindow.minimize()}>
        –
      </button>
      <button type="button" aria-label="Maximize" style={buttonStyle} onClick={() => void appWindow.toggleMaximize()}>
        □
      </button>
      <button type="button" aria-label="Close" style={buttonStyle} onClick={() => void appWindow.close()}>
        ×
      </button>
    </header>
  );
}
