/**
 * Copyright (c) 2024, Daily.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

import { v4 as uuidv4 } from "uuid";

import {
  name as packageName,
  version as packageVersion,
} from "../package.json";
import type { A11ySnapshot, UIJobGroupEnvelope } from "./ui";

// Protocol 2.0.0 adds server-driven bot-output progress (spoken_progress, segment_id).
export const RTVI_PROTOCOL_VERSION = "2.1.0";
export const RTVI_MESSAGE_LABEL = "rtvi-ai";

/**
 * Messages the corresponding server-side client expects to receive about
 * our client-side state.
 */
export enum RTVIMessageType {
  /** Outbound Messages */
  CLIENT_READY = "client-ready",
  DISCONNECT_BOT = "disconnect-bot",
  // Client-to-server messages
  CLIENT_MESSAGE = "client-message",
  SEND_TEXT = "send-text",
  DTMF = "dtmf",
  // UI Worker Protocol (client-to-server)
  UI_EVENT = "ui-event",
  UI_SNAPSHOT = "ui-snapshot",
  UI_CANCEL_JOB_GROUP = "ui-cancel-job-group",
  // DEPRECATED
  APPEND_TO_CONTEXT = "append-to-context",

  /**
   * Inbound Messages
   * Messages the server-side client sends to our client-side client regarding
   * its state or other non-service-specific messaging.
   */
  BOT_READY = "bot-ready", // Bot is connected and ready to receive messages
  ERROR = "error", // Bot initialization error
  METRICS = "metrics", // Bot reporting metrics
  SERVER_MESSAGE = "server-message", // Custom server-to-client message
  SERVER_RESPONSE = "server-response", // Server response to client message
  ERROR_RESPONSE = "error-response", // Error message in response to an outbound message
  APPEND_TO_CONTEXT_RESULT = "append-to-context-result", // Result of appending to context
  // UI Worker Protocol (server-to-client)
  UI_COMMAND = "ui-command",
  UI_JOB_GROUP = "ui-job-group",

  /** Speaking and Transcription Messages */
  USER_STARTED_SPEAKING = "user-started-speaking", // User started speaking
  USER_STOPPED_SPEAKING = "user-stopped-speaking", // User stopped speaking
  BOT_STARTED_SPEAKING = "bot-started-speaking", // Bot started speaking
  BOT_STOPPED_SPEAKING = "bot-stopped-speaking", // Bot stopped speaking
  // User muted events. These events notify when the server is ignoring audio from the client.
  // The client should continue sending audio normally but may want to show some indication to the user.
  USER_MUTE_STARTED = "user-mute-started", // User muted server-side.
  USER_MUTE_STOPPED = "user-mute-stopped", // User unmuted server-side.

  USER_TRANSCRIPTION = "user-transcription", // Local user speech to text transcription (partials and finals)
  BOT_OUTPUT = "bot-output", // A best effort aggregation of all bot output along with metadata like if it's spoken
  // DEPRECATED
  BOT_TRANSCRIPTION = "bot-transcription", // Bot full text transcription (sentence aggregated)

  /** LLM Messages */
  USER_LLM_TEXT = "user-llm-text", // Aggregated user input text which is sent to LLM
  BOT_LLM_TEXT = "bot-llm-text", // Streamed token returned by the LLM
  BOT_LLM_STARTED = "bot-llm-started", // Bot LLM inference starts
  BOT_LLM_STOPPED = "bot-llm-stopped", // Bot LLM inference stops

  // Function calling
  // DECPRECATED
  LLM_FUNCTION_CALL = "llm-function-call", // Inbound function call from LLM
  LLM_FUNCTION_CALL_STARTED = "llm-function-call-started", // Inbound function call started
  LLM_FUNCTION_CALL_IN_PROGRESS = "llm-function-call-in-progress", // Inbound function call in progress
  LLM_FUNCTION_CALL_STOPPED = "llm-function-call-stopped", // Inbound function call stopped
  LLM_FUNCTION_CALL_RESULT = "llm-function-call-result", // Outbound result of function call

  BOT_LLM_SEARCH_RESPONSE = "bot-llm-search-response", // Bot LLM search response

  /** TTS Messages */
  BOT_TTS_TEXT = "bot-tts-text", // Bot TTS text output (streamed word as it is spoken)
  BOT_TTS_STARTED = "bot-tts-started", // Bot TTS response starts
  BOT_TTS_STOPPED = "bot-tts-stopped", // Bot TTS response stops
}

// ----- Message Data Types

export type BotReadyData = {
  version: string;
  about?: unknown; // Optional about data from the bot
};

type PlatformDetailsValue = undefined | string | number | boolean;
type NestedPlatformDetails =
  | PlatformDetailsValue
  | Record<string, PlatformDetailsValue>;

// This is an interface so that different client libraries can provide their own
// implementation of the about data, e.g., with more platform-specific details.
// The client library should call `setAboutClient` to set this data before sending
// the `client-ready` message.
export interface AboutClientData {
  library: string; // Library name, e.g., "@pipecat-ai/client-js"
  library_version?: string; // Library version, e.g., "1.0.0"
  platform?: string; // Platform name, e.g., "Android"
  platform_version?: string; // Platform version, e.g., "14.0"
  platform_details?: Record<string, NestedPlatformDetails>; // Optional platform details, e.g., browser info
}

export type ClientReadyData = {
  version: string;
  about: AboutClientData; // Information about the client library
};

export type ErrorData = {
  error: string;
  fatal: boolean;
  /** @deprecated Use `error` instead. */
  message?: string;
};

export type PipecatMetricData = {
  processor: string;
  value: number;
};

export type PipecatMetricsData = {
  processing?: PipecatMetricData[];
  ttfb?: PipecatMetricData[];
  characters?: PipecatMetricData[];
};

export type TranscriptData = {
  text: string;
  final: boolean;
  timestamp: string;
  user_id: string;
};

export enum AggregationType {
  WORD = "word",
  SENTENCE = "sentence",
}

export type SpokenStatus = "new" | "in-progress" | "completed";

export type SpokenProgressData = {
  accumulated_text: string;
  remaining_text: string;
};

export type BotOutputData = {
  text: string;
  aggregated_by?: AggregationType | string;
  segment_id?: number;
  /** @deprecated Protocol 1.4.x only. Use `will_be_spoken` instead. */
  spoken?: boolean;
  // Protocol 2.0.0+ fields
  will_be_spoken?: boolean;
  spoken_status?: SpokenStatus;
  spoken_progress?: SpokenProgressData;
};

export type BotLLMTextData = {
  text: string;
};

export type UserLLMTextData = {
  text: string;
};

export type BotTTSTextData = {
  text: string;
};

export type ServerMessageData = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
};

export type ClientMessageData = {
  t: string;
  d?: unknown;
};

export type UIEventData = {
  event: string;
  payload?: unknown;
};

export type UISnapshotData = {
  tree: A11ySnapshot;
};

export type UICancelJobGroupData = {
  job_id: string;
  reason?: string;
};

export type UICommandData = {
  command: string;
  payload: unknown;
};

export type UIJobGroupData = UIJobGroupEnvelope;

export type LLMSearchResult = {
  text: string;
  confidence: number[];
};

export type BotLLMSearchResponseData = {
  search_result?: string;
  rendered_content?: string;
  origins: LLMSearchOrigin[];
};

export type LLMSearchOrigin = {
  site_uri?: string;
  site_title?: string;
  results: LLMSearchResult[];
};

export type LLMFunctionCallStartedData = {
  function_name?: string;
  /**
   * The `tool_call_id` of the function call this one ran as part of. A tool's
   * work can involve function calls of its own, made by another model on its
   * behalf, e.g. a backend that a `delegate` tool hands work to makes calls
   * while the `delegate` call is in progress; each of them names it as its
   * parent. Absent for a call the bot's LLM made itself.
   */
  parent_tool_call_id?: string;
};

export type LLMFunctionCallInProgressData = {
  function_name?: string;
  tool_call_id: string;
  /**
   * The `tool_call_id` of the function call this one ran as part of. A tool's
   * work can involve function calls of its own, made by another model on its
   * behalf, e.g. a backend that a `delegate` tool hands work to makes calls
   * while the `delegate` call is in progress; each of them names it as its
   * parent. Absent for a call the bot's LLM made itself.
   */
  parent_tool_call_id?: string;
  arguments?: Record<string, unknown>;
};

/** @deprecated Use LLMFunctionCallInProgressData instead */
export type LLMFunctionCallData = {
  function_name?: string;
  tool_call_id: string;
  args: Record<string, unknown>;
};

export type LLMFunctionCallResult = Record<string, unknown> | string;

export type LLMFunctionCallResultResponse = {
  function_name: string;
  tool_call_id: string;
  arguments: Record<string, unknown>;
  result: LLMFunctionCallResult;
};

export type LLMFunctionCallStoppedData = {
  function_name?: string;
  tool_call_id: string;
  /**
   * The `tool_call_id` of the function call this one ran as part of. A tool's
   * work can involve function calls of its own, made by another model on its
   * behalf, e.g. a backend that a `delegate` tool hands work to makes calls
   * while the `delegate` call is in progress; each of them names it as its
   * parent. Absent for a call the bot's LLM made itself.
   */
  parent_tool_call_id?: string;
  cancelled: boolean;
  result?: unknown;
};

export type SendTextOptions = {
  run_immediately?: boolean;
  audio_response?: boolean;
};

/** Valid DTMF keypad keys. */
export type DTMFButton =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "*"
  | "#";

export type DTMFData = {
  /** One or more DTMF keys, in order. Requires a bot on RTVI protocol
   * 2.1.0+; older bots expect a legacy `{button}` message per key. */
  buttons: DTMFButton[];
};

/** DEPRECATED */
export type LLMContextMessage = {
  role: "user" | "assistant";
  content: unknown;
  run_immediately?: boolean;
};

/** DEPRECATED */
export type AppendToContextResultData = {
  result: Record<string, unknown> | string;
};

// ----- Message Classes

let _aboutClient: AboutClientData | undefined;
export function setAboutClient(about: AboutClientData) {
  // allow for partial updates to the about data
  // this allows the client to set the about data at any time
  // before sending the `client-ready` message and not worry about
  // overwriting existing data
  if (_aboutClient) {
    _aboutClient = { ..._aboutClient, ...about };
  } else {
    // if no about data is set, set it to the provided value
    _aboutClient = about;
  }
}

export class RTVIMessage {
  id: string;
  label: string = RTVI_MESSAGE_LABEL;
  type: string;
  data: unknown;

  constructor(type: string, data: unknown, id?: string) {
    this.type = type;
    this.data = data;
    this.id = id || uuidv4().slice(0, 8);
  }

  // Outbound message types
  static clientReady(): RTVIMessage {
    return new RTVIMessage(RTVIMessageType.CLIENT_READY, {
      version: RTVI_PROTOCOL_VERSION,
      about: _aboutClient || {
        library: packageName,
        library_version: packageVersion,
      },
    });
  }

  static disconnectBot(): RTVIMessage {
    return new RTVIMessage(RTVIMessageType.DISCONNECT_BOT, {});
  }

  static error(message: string, fatal = false): RTVIMessage {
    return new RTVIMessage(RTVIMessageType.ERROR, {
      error: message,
      message,
      fatal,
    });
  }
}
