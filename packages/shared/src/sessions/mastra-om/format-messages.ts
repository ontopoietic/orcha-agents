/**
 * Adapter — not vendored. We bridge our `ObservableMessage` shape to the text
 * format Mastra's Observer expects in `## New Message History to Observe`.
 *
 * Output format mirrors Mastra's `formatMessagesForObserver` for the
 * text-only / single-thread case (see chunk-LPMZNXSF.js:3239 ff), with one
 * orcha-specific addition: each message header carries an `[#shortId]` tag
 * (last 6 chars of the message-id) so the LLM can transport that anchor
 * onto every bullet it emits — enabling UI back-linking from a bullet to
 * its source message.
 *
 *   Dec 4, 2025:
 *   User (14:30) [#abc123]: hello there
 *   Assistant (14:31) [#def456]: hi back
 *   Assistant [#ghi789]: continuing (same time as above; time omitted on repeat)
 *   Dec 5, 2025:
 *   User (09:15) [#jkl012]: next day
 *
 * Date headers appear when the date changes. Times appear when they change.
 * Tool / system / error messages are folded in with synthesized titles so the
 * Observer can still reason about them.
 *
 * Works for both Claude Code SDK and Pi sessions because our caller already
 * normalised to ObservableMessage upstream in observation-watermark.ts.
 */

import type { ObservableMessage } from '../observation-watermark.ts';

/** Last 6 chars of the message-id — the canonical orcha anchor format. */
function shortIdFromMsgId(id: string): string {
  if (!id) return '';
  const parts = id.split('-');
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : id.slice(-6);
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function titleForMessage(msg: ObservableMessage): string {
  switch (msg.type) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'tool':
      return msg.toolName ? `Tool Result ${msg.toolName}` : 'Tool Result';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    case 'plan':
      return 'Plan';
    default:
      return 'Message';
  }
}

/** Format a slice of ObservableMessages for the Observer LLM call. */
export function formatMessagesForObserver(messages: readonly ObservableMessage[]): string {
  let previousDate: string | undefined;
  let previousTime: string | undefined;
  const out: string[] = [];

  for (const msg of messages) {
    const body = (msg.content ?? '').trim();
    if (!body) continue;

    const date = formatDate(msg.timestamp);
    const time = formatTime(msg.timestamp);

    if (date !== previousDate) {
      out.push(`${date}:`);
      previousDate = date;
      previousTime = undefined;
    }

    const title = titleForMessage(msg);
    const timeLabel = time && time !== previousTime ? `(${time})` : '';
    const anchorLabel = `[#${shortIdFromMsgId(msg.id)}]`;
    if (!title) {
      out.push(timeLabel ? `${timeLabel} ${anchorLabel}: ${body}` : `${anchorLabel}: ${body}`);
    } else {
      out.push(`${title}${timeLabel ? ` ${timeLabel}` : ''} ${anchorLabel}: ${body}`);
    }
    if (time) previousTime = time;
  }
  return out.join('\n');
}
