/**
 * Copyright (c) 2024, Daily.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

import { type ReactNode } from "react";

/**
 * Custom renderer for function call messages in the conversation.
 * Receives the full FunctionCallData so developers can render differently
 * based on function name, status, args, and result.
 */
export type FunctionCallRenderer = (
  functionCall: FunctionCallData
) => ReactNode;

/**
 * BotOutput text structure for messages in BotOutput mode
 */
export interface BotOutputText {
  spoken: string;
  unspoken: string;
}

/**
 * Filter controlling which portions of BotOutput text are returned by the hook.
 * The underlying atoms always store the full data; this filter controls what
 * the consumer receives.
 */
export interface BotOutputFilter {
  /** Include spoken text (TTS-confirmed portion). Default: true */
  spoken?: boolean;
  /** Include unspoken text (LLM output not yet spoken). Default: true */
  unspoken?: boolean;
}

/**
 * A raw BotOutput event stored for debugging and replay.
 * Each event represents a single BotOutput RTVI event as received.
 */
export interface BotOutputEvent {
  /** The raw text from the BotOutput event */
  text: string;
  /** @deprecated Protocol 1.4.x only. Use `will_be_spoken` instead. */
  spoken: boolean;
  /** Aggregation type (e.g., "sentence", "word", "code") */
  aggregatedBy?: string;
  /** ISO timestamp of when the event was received */
  receivedAt: string;
  // Protocol 2.0.0 adds server-driven bot-output progress (will_be_spoken, spoken_status, spoken_progress and segment_id)
  will_be_spoken?: boolean;
  spoken_status?: "new" | "in-progress" | "completed";
  spoken_progress?: { accumulated_text: string; remaining_text: string };
  segment_id?: number;
}

/**
 * Metadata for aggregation types to control rendering and speech progress behavior
 */
export interface AggregationMetadata {
  /**
   * Whether the content of this aggregation type is expected to be spoken.
   * If false, it will be skipped from karaoke-style highlighting and position-based splitting.
   * @default true
   */
  isSpoken?: boolean;
  /**
   * How the aggregation should be rendered.
   * - 'inline': Rendered inline with surrounding text
   * - 'block': Rendered as a block element (e.g., code blocks)
   * @default 'inline'
   */
  displayMode?: "inline" | "block";
}

/**
 * Data associated with an LLM function call message.
 * Present only when role === "function_call".
 */
export interface FunctionCallData {
  /** The name of the function being called */
  function_name?: string;
  /** Unique identifier for this tool call */
  tool_call_id?: string;
  /**
   * The `tool_call_id` of the function call this one ran as part of. A tool's
   * work can involve function calls of its own, made by another model on its
   * behalf, e.g. a backend that a `delegate` tool hands work to makes calls
   * while the `delegate` call is in progress; each of them names it as its
   * parent. Absent for a call the bot's LLM made itself.
   */
  parent_tool_call_id?: string;
  /** Arguments passed to the function */
  args?: Record<string, unknown>;
  /** Result of the function call (populated when complete) */
  result?: unknown;
  /** Whether the function call was cancelled */
  cancelled?: boolean;
  /** Current status of the function call */
  status: "started" | "in_progress" | "completed";
}

export interface ConversationMessagePart {
  /**
   * Text content for the message part.
   * - BotOutputText: For assistant messages with spoken/unspoken text
   * - ReactNode: For user messages (strings) or custom injected content
   */
  text: ReactNode | BotOutputText;
  final: boolean;
  createdAt: string;
  /**
   * Aggregation type for BotOutput content (e.g., "code", "link", "sentence", "word")
   * Used to determine which custom renderer to use, if any
   */
  aggregatedBy?: string;
  /**
   * RTVI Protocol 2.0.0+ segment identifier. Used to correlate progress
   * events (`spoken_status: "in-progress" | "completed"`) back to the
   * part they belong to.
   */
  segment_id?: number;
  /**
   * RTVI Protocol 2.0.0+ only. When true, the renderer should prepend an
   * inter-segment separator (a space) before this part's text. The stored
   * `text` is always the original segment text as received from the server.
   */
  needsSeparator?: boolean;
  /**
   * Display mode for BotOutput content.
   * - "inline": Rendered inline with surrounding text (default for sentence-level)
   * - "block": Rendered as a block element (e.g., code blocks)
   * @default "inline"
   */
  displayMode?: "inline" | "block";
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "function_call";
  final?: boolean;
  parts: ConversationMessagePart[];
  createdAt: string;
  updatedAt?: string;
  /** Function call data, present only when role is "function_call" */
  functionCall?: FunctionCallData;
}
