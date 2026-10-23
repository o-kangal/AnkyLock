import { createMemo, createSignal, For, onCleanup, onMount, untrack, type JSX } from 'solid-js';

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  /** Fixed row height in px; keeps windowing O(1) without measuring rows. */
  readonly rowHeight: number;
  /** Rows rendered above and below the viewport. */
  readonly overscan?: number;
  /** Used until the container can be measured (and in layout-less environments). */
  readonly fallbackHeight?: number;
  readonly children: (item: T, index: number) => JSX.Element;
}

/**
 * Renders only the rows in view plus overscan, so lists with thousands of notes keep a small,
 * constant DOM. Rows are keyed by index and reused while scrolling.
 */
export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(untrack(() => props.fallbackHeight) ?? 600);

  onMount(() => {
    if (scroller.clientHeight > 0) setHeight(scroller.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (scroller.clientHeight > 0) setHeight(scroller.clientHeight);
    });
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
  });

  const indices = createMemo(() => {
    const overscan = props.overscan ?? 8;
    const first = Math.max(0, Math.floor(scrollTop() / props.rowHeight) - overscan);
    const last = Math.min(props.items.length, Math.ceil((scrollTop() + height()) / props.rowHeight) + overscan);
    return Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
  });

  return (
    <div
      ref={scroller}
      role="list"
      style={{ 'overflow-y': 'auto', height: '100%', position: 'relative' }}
      onScroll={() => setScrollTop(scroller.scrollTop)}
    >
      <div style={{ height: `${props.items.length * props.rowHeight}px`, position: 'relative' }}>
        <For each={indices()}>
          {(index) => (
            <div
              role="listitem"
              style={{
                position: 'absolute',
                top: `${index * props.rowHeight}px`,
                left: '0',
                right: '0',
                height: `${props.rowHeight}px`,
              }}
            >
              {props.children(props.items[index] as T, index)}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
