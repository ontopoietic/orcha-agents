import { describe, expect, it } from 'bun:test';
import { formatMessagesForObserver } from '../format-messages.ts';
import type { ObservableMessage } from '../../observation-watermark.ts';

const MAY_15_1430 = Date.UTC(2026, 4, 15, 14, 30, 0);
const MAY_15_1430_PLUS_60S = MAY_15_1430 + 60_000;
const MAY_16_0915 = Date.UTC(2026, 4, 16, 9, 15, 0);

describe('formatMessagesForObserver', () => {
  it('emits a date header, a time-tagged role line, and omits repeated times', () => {
    const msgs: ObservableMessage[] = [
      { id: 'a', content: 'hello there', timestamp: MAY_15_1430, type: 'user' },
      { id: 'b', content: 'hi back', timestamp: MAY_15_1430_PLUS_60S, type: 'assistant' },
    ];
    const out = formatMessagesForObserver(msgs);
    // Date header is the first line.
    expect(out.split('\n')[0]).toMatch(/^[A-Z][a-z]{2,8} \d{1,2}, \d{4}:$/);
    expect(out).toContain('User');
    expect(out).toContain('hello there');
    expect(out).toContain('Assistant');
    expect(out).toContain('hi back');
  });

  it('emits a new date header when day changes and resets the time tag', () => {
    const msgs: ObservableMessage[] = [
      { id: 'a', content: 'day one', timestamp: MAY_15_1430, type: 'user' },
      { id: 'b', content: 'day two', timestamp: MAY_16_0915, type: 'user' },
    ];
    const out = formatMessagesForObserver(msgs);
    const headerCount = (out.match(/^[A-Z][a-z]{2,8} \d{1,2}, \d{4}:$/gm) ?? []).length;
    expect(headerCount).toBe(2);
  });

  it('drops empty messages but keeps tool / system / error with titles', () => {
    const msgs: ObservableMessage[] = [
      { id: 'a', content: '   ', timestamp: MAY_15_1430, type: 'user' },
      { id: 'b', content: 'result body', timestamp: MAY_15_1430, type: 'tool', toolName: 'Read' },
      { id: 'c', content: 'system note', timestamp: MAY_15_1430, type: 'system' },
      { id: 'd', content: 'boom', timestamp: MAY_15_1430, type: 'error' },
    ];
    const out = formatMessagesForObserver(msgs);
    expect(out).not.toContain('   '); // dropped empty user
    expect(out).toContain('Tool Result Read');
    expect(out).toContain('System');
    expect(out).toContain('Error');
  });

  it('handles an empty input gracefully', () => {
    expect(formatMessagesForObserver([])).toBe('');
  });
});
