import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';
import { UpdateBanner, type PendingUpdate } from '../src/pwa/UpdateBanner.jsx';
import { watchForUpdates, type ContainerLike, type RegistrationLike, type WorkerLike } from '../src/pwa/updates.js';
import { SKIP_WAITING } from '../src/sw/cachePolicy.js';

class FakeTarget {
  readonly #listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

class FakeWorker extends FakeTarget implements WorkerLike {
  state = 'installing';
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

class FakeRegistration extends FakeTarget implements RegistrationLike {
  waiting: WorkerLike | null = null;
  installing: WorkerLike | null = null;
}

class FakeContainer extends FakeTarget implements ContainerLike {
  constructor(readonly controller: unknown) {
    super();
  }
}

describe('watchForUpdates', () => {
  it('offers an update once a new worker is installed behind the current one', () => {
    const container = new FakeContainer({});
    const registration = new FakeRegistration();
    const offers: (() => void)[] = [];
    watchForUpdates(container, registration, (activate) => offers.push(activate), () => undefined);

    const next = new FakeWorker();
    registration.installing = next;
    registration.emit('updatefound');
    expect(offers).toHaveLength(0);
    next.state = 'installed';
    next.emit('statechange');
    expect(offers).toHaveLength(1);

    offers[0]?.();
    expect(next.messages).toEqual([SKIP_WAITING]);
  });

  it('offers an update that was already waiting at startup', () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();
    const offers: unknown[] = [];
    watchForUpdates(new FakeContainer({}), registration, (a) => offers.push(a), () => undefined);
    expect(offers).toHaveLength(1);
  });

  it('treats the first install as not an update', () => {
    const registration = new FakeRegistration();
    const offers: unknown[] = [];
    watchForUpdates(new FakeContainer(null), registration, (a) => offers.push(a), () => undefined);
    const first = new FakeWorker();
    registration.installing = first;
    registration.emit('updatefound');
    first.state = 'installed';
    first.emit('statechange');
    expect(offers).toHaveLength(0);
  });

  it('reloads once when the new worker takes control', () => {
    const container = new FakeContainer({});
    let reloads = 0;
    watchForUpdates(container, new FakeRegistration(), () => undefined, () => {
      reloads++;
    });
    container.emit('controllerchange');
    container.emit('controllerchange');
    expect(reloads).toBe(1);
  });
  it('does not reload a first visit when its first worker claims the page', () => {
    // The page had no controller: the claim is the install, not an update.
    const container = new FakeContainer(null);
    let reloads = 0;
    watchForUpdates(container, new FakeRegistration(), () => undefined, () => {
      reloads++;
    });
    container.emit('controllerchange');
    expect(reloads).toBe(0);
    // A later update on the same page still reloads.
    container.emit('controllerchange');
    expect(reloads).toBe(1);
  });
});

describe('UpdateBanner', () => {
  function mount(update: () => PendingUpdate | null) {
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <UpdateBanner update={update()} />, root);
    return {
      root,
      button: () => root.querySelector('button') as HTMLButtonElement,
      dispose: () => {
        dispose();
        root.remove();
      },
    };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('stays hidden until an update is ready, then runs it once', async () => {
    const runs: string[] = [];
    const [update, setUpdate] = createSignal<PendingUpdate | null>(null);
    const banner = mount(update);
    expect(banner.root.textContent).toBe('');

    setUpdate({ message: 'A new version of AnkyLock is available.', action: 'Reload', busy: 'Saving…', apply: async () => void runs.push('apply') });
    expect(banner.root.textContent).toContain('A new version of AnkyLock is available.');
    banner.button().click();
    expect(banner.button().textContent).toBe('Saving…');
    expect(banner.button().disabled).toBe(true);
    await tick();
    expect(runs).toEqual(['apply']);
    banner.dispose();
  });

  it('says so when the update fails, and lets the user try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let attempts = 0;
    const banner = mount(() => ({
      message: 'AnkyLock 0.2.0 is available.',
      action: 'Install and restart',
      busy: 'Installing…',
      apply: () => {
        attempts++;
        return Promise.reject(new Error('download failed'));
      },
    }));
    banner.button().click();
    await tick();
    expect(banner.root.textContent).toContain('The update could not be installed. Try again later.');
    expect(banner.button().disabled).toBe(false);
    banner.button().click();
    await tick();
    expect(attempts).toBe(2);
    banner.dispose();
  });
});
