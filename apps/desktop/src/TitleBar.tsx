import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Accessor, JSX } from 'solid-js';
import { AnkyLogo, tokens, type LogoFace } from '@ankylock/web/workspace';

const buttonStyle: JSX.CSSProperties = {
  width: '44px',
  height: '100%',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: '13px system-ui, sans-serif',
  cursor: 'pointer',
};

/** Custom title bar for the frameless window; the empty area drags the window. */
export function TitleBar(props: { readonly logoFace: Accessor<LogoFace> }): JSX.Element {
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
        color: tokens.text,
        background: tokens.surface,
        'border-bottom': `1px solid ${tokens.border}`,
      }}
    >
      {/* Clicks pass through the logo to the header, so dragging it moves the window. */}
      <span style={{ display: 'flex', 'margin-right': '8px', 'pointer-events': 'none' }}>
        <AnkyLogo face={props.logoFace()} size={26} background={tokens.surface} />
      </span>
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
