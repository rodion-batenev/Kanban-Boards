import type { Board, Op } from './board';

/** `ack` is the seq of the last op fully processed by the host, set only on replies to ops. */
export type HostMessage =
  | { type: 'board'; board: Board; ack?: number }
  | { type: 'error'; error: string; ack?: number }
  /** Reply to `pickLink`; `link` is formatted markdown, absent if cancelled. */
  | { type: 'pickedLink'; reqId: number; link?: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'op'; op: Op; seq: number }
  | { type: 'openAsText' }
  | { type: 'openLink'; target: string; beside: boolean }
  | { type: 'pickLink'; reqId: number };
