import { describe, expect, it } from 'vitest';
import { V1TextCoalescer } from './v1-text-coalescer.js';

const collect = () => {
  const texts: string[] = [];
  return { texts, coalescer: new V1TextCoalescer((t) => texts.push(t)) };
};

describe('V1TextCoalescer', () => {
  it('buffers deltas and emits ONE text on complete — never one per delta', () => {
    const { texts, coalescer } = collect();
    for (const delta of ['github', '.com', '/open', '-merc', 'ato']) coalescer.append('m1', delta);
    expect(texts).toEqual([]);
    coalescer.complete('m1');
    expect(texts).toEqual(['github.com/open-mercato']);
  });

  it('prefers the completion snapshot over accumulated deltas', () => {
    const { texts, coalescer } = collect();
    coalescer.append('m1', 'partial');
    coalescer.complete('m1', 'the full authoritative text');
    expect(texts).toEqual(['the full authoritative text']);
  });

  it('emits the snapshot for an item that never streamed (no-delta turns)', () => {
    const { texts, coalescer } = collect();
    coalescer.complete('m1', 'whole message at once');
    expect(texts).toEqual(['whole message at once']);
  });

  it('emits nothing for an empty completion', () => {
    const { texts, coalescer } = collect();
    coalescer.complete('m1');
    coalescer.complete('m2', '');
    expect(texts).toEqual([]);
  });

  it('never double-emits: repeated complete for the same item is a no-op', () => {
    const { texts, coalescer } = collect();
    coalescer.append('m1', 'hello');
    coalescer.complete('m1', 'hello');
    coalescer.complete('m1', 'hello');
    expect(texts).toEqual(['hello']);
  });

  it('claims id-less deltas for the completing item', () => {
    const { texts, coalescer } = collect();
    coalescer.append(undefined, 'no id ');
    coalescer.append(undefined, 'yet');
    coalescer.complete('m1');
    expect(texts).toEqual(['no id yet']);
  });

  it('flush surfaces buffered prose of items that never completed, in arrival order', () => {
    const { texts, coalescer } = collect();
    coalescer.append('a', 'first');
    coalescer.append('b', 'second');
    coalescer.flush();
    expect(texts).toEqual(['first', 'second']);
    coalescer.flush();
    expect(texts).toEqual(['first', 'second']);
  });

  it('a re-sent snapshot after flush does not re-emit (the latch survives the boundary)', () => {
    const { texts, coalescer } = collect();
    coalescer.append('m1', 'partial prose');
    coalescer.flush();
    coalescer.complete('m1', 'partial prose plus tail');
    expect(texts).toEqual(['partial prose']);
  });

  it('keeps items independent — interleaved deltas do not mix', () => {
    const { texts, coalescer } = collect();
    coalescer.append('a', 'aaa');
    coalescer.append('b', 'bbb');
    coalescer.complete('b');
    coalescer.complete('a');
    expect(texts).toEqual(['bbb', 'aaa']);
  });

  it('the anonymous bucket is reusable across items (never latched)', () => {
    const { texts, coalescer } = collect();
    coalescer.append(undefined, 'one');
    coalescer.complete(undefined);
    coalescer.append(undefined, 'two');
    coalescer.complete(undefined);
    expect(texts).toEqual(['one', 'two']);
  });
});
