export const protocolVersion = 1;
export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export const terminal = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled', 'unknown']);
export interface Approval {
  id: string;
  method: string;
  description: string;
  expires_at: string;
}
export interface Task {
  id: string;
  device_id: string;
  request_id: string;
  conversation_id: string;
  prompt: string;
  status: TaskStatus;
  output: string;
  output_truncated: boolean;
  error: string | null;
  progress: string | null;
  thread_id: string | null;
  turn_id: string | null;
  approval: Approval | null;
  created_at: string;
  updated_at: string;
  version: number;
}
export interface EventEnvelope {
  protocol_version: 1;
  event_id: string;
  event_seq: number;
  type: string;
  occurred_at: string;
  payload: { task_id: string; status: TaskStatus; version: number } | { chat_id: string; status: ChatStatus; version: number };
}
export const taskInputSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'prompt'],
  properties: {
    request_id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' },
    conversation_id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' },
    prompt: { type: 'string', minLength: 1, maxLength: 16000 }
  }
} as const;

export type ChatStatus = 'running' | 'succeeded' | 'cancelled' | 'failed';
export interface ChatTurn {
  id: string;
  device_id: string;
  request_id: string;
  conversation_id: string;
  prompt: string;
  output: string;
  status: ChatStatus;
  error: string | null;
  task_ids: string[];
  created_at: string;
  updated_at: string;
  version: number;
}
export interface ChatCommand { request_id: string; prompt: string; conversation_id?: string }
