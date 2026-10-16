import { afterEach, describe, expect, it } from 'vitest';
import type { NoteId } from '@ankylock/core';
import { TEXT_FIELD } from '@ankylock/sync';
import { textOf, twoDevices, until, type Device } from './harness.js';

const opened: Device[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((d) => d.runtime.lock()));
});

async function pair() {
  const devices = await twoDevices();
  opened.push(devices.a, devices.b);
  return devices;
}

/** Opens a new `Untitled-N` scratchpad on a device and returns its id and live text. */
async function scratchpad(d: Device) {
  expect((await d.runtime.store.createTab()).ok).toBe(true);
  const noteId = d.runtime.store.state.tabs.at(-1)?.noteId as NoteId;
  return { noteId, text: (await d.runtime.openDoc(noteId)).getText(TEXT_FIELD) };
}

describe('scratchpad sync across devices', () => {
  it('delivers unsaved scratchpad text to the other device, decrypted, without any save action', async () => {
    const { relay, a, b } = await pair();
    const { noteId, text } = await scratchpad(a);
    expect(a.runtime.store.state.notes[noteId]?.isEphemeral).toBe(true);

    // Typing is all the user does: no save, no dialog (BR-NOTE-01).
    text.insert(0, 'const apiKey = "s3cr3t-value";\nconsole.log(apiKey);');

    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'scratchpad listed on B');
    expect(b.runtime.store.state.notes[noteId]?.isEphemeral).toBe(true);
    await until(async () => (await textOf(b, noteId)).includes('console.log'), 'text on B');
    expect(await textOf(b, noteId)).toBe('const apiKey = "s3cr3t-value";\nconsole.log(apiKey);');

    // The relay carried only ciphertext: no text, no title (BR-SEC-01).
    expect(relay.frames.length).toBeGreaterThan(0);
    expect(relay.seen()).not.toContain('s3cr3t');
    expect(relay.seen()).not.toContain('apiKey');
  });

  it('keeps typing while offline and delivers it after reconnecting', async () => {
    const { a, b } = await pair();
    const { noteId, text } = await scratchpad(a);
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'scratchpad listed on B');

    a.setOnline(false);
    await until(() => a.runtime.syncStatus().connection !== 'open', 'A offline');
    text.insert(0, 'written on a train');
    expect(await textOf(b, noteId)).toBe('');

    a.setOnline(true);
    await until(async () => (await textOf(b, noteId)) === 'written on a train', 'queued text on B', 15_000);
  });

  it('merges concurrent edits on both devices without losing either (no last-write-wins)', async () => {
    const { a, b } = await pair();
    const { noteId, text } = await scratchpad(a);
    text.insert(0, 'shared line\n');
    await until(async () => (await textOf(b, noteId)) === 'shared line\n', 'base text on B');
    const onB = (await b.runtime.openDoc(noteId)).getText(TEXT_FIELD);

    // Both devices edit before either sees the other's change.
    a.setOnline(false);
    b.setOnline(false);
    text.insert(text.length, 'from A\n');
    onB.insert(onB.length, 'from B\n');
    a.setOnline(true);
    b.setOnline(true);

    await until(async () => (await textOf(a, noteId)) === (await textOf(b, noteId)), 'converged', 15_000);
    const merged = await textOf(a, noteId);
    expect(merged.startsWith('shared line\n')).toBe(true);
    expect(merged).toContain('from A\n');
    expect(merged).toContain('from B\n');
  });
});
