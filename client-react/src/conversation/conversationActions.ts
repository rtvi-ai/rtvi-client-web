/**
 * Copyright (c) 2024, Daily.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

import type { Getter, Setter } from "jotai";
import type { ReactNode } from "react";

import {
  applySpokenBotOutputProgress,
  applySpokenProgressV2,
  hasUnspokenContent,
  normalizeForMatching,
} from "./botOutput";
import type { MessageCallbacks } from "./conversationAtoms";
import {
  botOutputEventsAtom,
  botOutputMessageStateAtom,
  messageCallbacksAtom,
  messagesAtom,
} from "./conversationAtoms";
import type {
  BotOutputEvent,
  BotOutputText,
  ConversationMessage,
  ConversationMessagePart,
  FunctionCallData,
} from "./types";
import { findLast, findLastIndex } from "./utils";

/** Max time gap (ms) between consecutive same-role messages for merging. */
const MERGE_WINDOW_MS = 30_000;

/**
 * Unicode characters used by `FilterIncompleteTurns` on the server to mark
 * turn completion status. The LLM emits one of these as the very first
 * character of every response:
 *
 *   ✓ (U+2713) — complete turn
 *   ○ (U+25CB) — incomplete short
 *   ◐ (U+25D0) — incomplete long
 *
 * They must be stripped before the text reaches conversation state.
 */
const TURN_COMPLETION_MARKERS = new Set(["\u2713", "\u25CB", "\u25D0"]);

/**
 * Strip a leading turn-completion marker (and any trailing space) from `text`.
 * Returns the cleaned string, which may be empty.
 */
export function stripTurnCompletionMarker(text: string): string {
  if (text.length === 0) return text;
  if (TURN_COMPLETION_MARKERS.has(text[0])) {
    // Remove marker and optional single trailing space
    return text[1] === " " ? text.slice(2) : text.slice(1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Public utility functions (exported for consumers)
// ---------------------------------------------------------------------------

export const sortByCreatedAt = (
  a: ConversationMessage,
  b: ConversationMessage
): number => {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
};

export const isMessageEmpty = (message: ConversationMessage): boolean => {
  if (message.role === "function_call") return false;
  const parts = message.parts || [];
  if (parts.length === 0) return true;
  return parts.every((p) => {
    if (typeof p.text === "string") {
      return p.text.trim().length === 0;
    }
    // Check BotOutputText objects
    if (
      typeof p.text === "object" &&
      p.text !== null &&
      "spoken" in p.text &&
      "unspoken" in p.text
    ) {
      const botText = p.text as BotOutputText;
      return (
        botText.spoken.trim().length === 0 &&
        botText.unspoken.trim().length === 0
      );
    }
    // For ReactNode, consider it non-empty
    return false;
  });
};

export const filterEmptyMessages = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  return messages.filter((message, index, array) => {
    if (!isMessageEmpty(message)) return true;

    // For empty messages, keep only if no following non-empty message with same role
    const nextMessageWithSameRole = array
      .slice(index + 1)
      .find((m) => m.role === message.role && !isMessageEmpty(m));

    return !nextMessageWithSameRole;
  });
};

export const mergeMessages = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  const mergedMessages: ConversationMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const currentMessage = messages[i];
    const lastMerged = mergedMessages[mergedMessages.length - 1];

    const timeDiff = lastMerged
      ? Math.abs(
          new Date(currentMessage.createdAt).getTime() -
            new Date(lastMerged.createdAt).getTime()
        )
      : Infinity;

    const shouldMerge =
      lastMerged &&
      lastMerged.role === currentMessage.role &&
      currentMessage.role !== "system" &&
      currentMessage.role !== "function_call" &&
      !lastMerged.final &&
      timeDiff < MERGE_WINDOW_MS;

    if (shouldMerge) {
      mergedMessages[mergedMessages.length - 1] = {
        ...lastMerged,
        parts: [...(lastMerged.parts || []), ...(currentMessage.parts || [])],
        updatedAt: currentMessage.updatedAt || currentMessage.createdAt,
        final: currentMessage.final !== false,
      };
    } else {
      mergedMessages.push(currentMessage);
    }
  }

  return mergedMessages;
};

const statusPriority: Record<string, number> = {
  started: 0,
  in_progress: 1,
  completed: 2,
};

/**
 * Deduplicate function call messages that share the same tool_call_id,
 * keeping the entry with the most advanced status.
 */
export const deduplicateFunctionCalls = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  const bestByToolCallId = new Map<string, number>();
  const toRemove = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tcid = msg.functionCall?.tool_call_id;
    if (msg.role !== "function_call" || !tcid) continue;

    const existingIdx = bestByToolCallId.get(tcid);
    if (existingIdx !== undefined) {
      const existingPriority =
        statusPriority[messages[existingIdx].functionCall!.status] ?? 0;
      const currentPriority = statusPriority[msg.functionCall!.status] ?? 0;

      if (currentPriority >= existingPriority) {
        toRemove.add(existingIdx);
        bestByToolCallId.set(tcid, i);
      } else {
        toRemove.add(i);
      }
    } else {
      bestByToolCallId.set(tcid, i);
    }
  }

  if (toRemove.size === 0) return messages;
  return messages.filter((_, i) => !toRemove.has(i));
};

const normalizeMessagesForUI = (
  messages: ConversationMessage[]
): ConversationMessage[] => {
  return mergeMessages(
    deduplicateFunctionCalls(
      filterEmptyMessages([...messages].sort(sortByCreatedAt))
    )
  );
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const callCallbacks = (
  callbacksMap: Map<string, MessageCallbacks>,
  type: keyof MessageCallbacks,
  message: ConversationMessage
) => {
  callbacksMap.forEach((callbacks) => {
    try {
      callbacks[type]?.(message);
    } catch (error) {
      console.error(`Error in ${type} callback:`, error);
    }
  });
};

// ---------------------------------------------------------------------------
// Action functions  –  (get, set, …params) => void
// ---------------------------------------------------------------------------

export function registerMessageCallback(
  get: Getter,
  set: Setter,
  id: string,
  callbacks: MessageCallbacks
) {
  const map = new Map(get(messageCallbacksAtom));
  map.set(id, callbacks);
  set(messageCallbacksAtom, map);
}

export function unregisterMessageCallback(
  get: Getter,
  set: Setter,
  id: string
) {
  const map = new Map(get(messageCallbacksAtom));
  map.delete(id);
  set(messageCallbacksAtom, map);
}

export function clearMessages(_get: Getter, set: Setter) {
  set(messagesAtom, []);
  set(botOutputMessageStateAtom, new Map());
  set(botOutputEventsAtom, new Map());
}

export function addMessage(
  get: Getter,
  set: Setter,
  messageData: Omit<ConversationMessage, "createdAt" | "updatedAt">
) {
  const now = new Date();
  const message: ConversationMessage = {
    ...messageData,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const current = get(messagesAtom);
  const updatedMessages = [...current, message];
  const processedMessages = normalizeMessagesForUI(updatedMessages);

  callCallbacks(get(messageCallbacksAtom), "onMessageCreated", message);
  set(messagesAtom, processedMessages);
}

export function updateLastMessage(
  get: Getter,
  set: Setter,
  role: "user" | "assistant",
  updates: Partial<ConversationMessage>
) {
  const messages = [...get(messagesAtom)];
  const lastMessageIndex = findLastIndex(messages,(msg) => msg.role === role);

  if (lastMessageIndex === -1) return;

  const existing = messages[lastMessageIndex];
  const updatedMessage = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  } as ConversationMessage;

  messages[lastMessageIndex] = updatedMessage;
  const processedMessages = normalizeMessagesForUI(messages);

  callCallbacks(get(messageCallbacksAtom), "onMessageUpdated", updatedMessage);
  set(messagesAtom, processedMessages);
}

/**
 * Snap the speech-progress cursor of the last assistant message to the end of
 * all its parts, marking every part as fully spoken.
 *
 * Used on a normal, uninterrupted turn boundary: the bot finished speaking, so
 * all text should render as "spoken". Without this, text from the last
 * sentence can remain grey if the spoken BotOutput event didn't match the
 * unspoken text exactly.
 *
 * Deliberately *not* used on the interruption path (UserStartedSpeaking),
 * where unspoken text should stay unspoken.
 */
export function snapSpeechCursorToEnd(get: Getter, set: Setter) {
  const messages = get(messagesAtom);
  const last = findLast(
    messages,
    (m: ConversationMessage) => m.role === "assistant"
  );
  if (!last) return;

  const cursorMap = new Map(get(botOutputMessageStateAtom));
  const cursor = cursorMap.get(last.createdAt);
  if (!cursor || !last.parts || last.parts.length === 0) return;

  const lastPartIdx = last.parts.length - 1;
  const lastPartText = last.parts[lastPartIdx]?.text;
  cursor.currentPartIndex = lastPartIdx;
  cursor.currentCharIndex =
    typeof lastPartText === "string" ? lastPartText.length : 0;
  for (let i = 0; i <= lastPartIdx; i++) {
    cursor.partFinalFlags[i] = true;
  }
  set(botOutputMessageStateAtom, cursorMap);
}

export function finalizeLastMessage(
  get: Getter,
  set: Setter,
  role: "user" | "assistant"
) {
  const messages = [...get(messagesAtom)];
  const lastMessageIndex = findLastIndex(messages,(msg) => msg.role === role);

  if (lastMessageIndex === -1) return;

  const lastMessage = messages[lastMessageIndex];

  // Check if message is empty
  if (isMessageEmpty(lastMessage)) {
    // Remove empty message only if it has no text in streams either
    messages.splice(lastMessageIndex, 1);
  } else {
    // Finalize message and its last part
    const parts = [...(lastMessage.parts || [])];
    if (parts.length > 0) {
      parts[parts.length - 1] = {
        ...parts[parts.length - 1],
        final: true,
      };
    }
    messages[lastMessageIndex] = {
      ...lastMessage,
      parts,
      final: true,
      updatedAt: new Date().toISOString(),
    };
    callCallbacks(
      get(messageCallbacksAtom),
      "onMessageUpdated",
      messages[lastMessageIndex]
    );
  }

  const processedMessages = normalizeMessagesForUI(messages);
  set(messagesAtom, processedMessages);
}

export function removeEmptyLastMessage(
  get: Getter,
  set: Setter,
  role: "user" | "assistant"
) {
  const messages = [...get(messagesAtom)];
  const lastMessageIndex = findLastIndex(messages,(msg) => msg.role === role);

  if (lastMessageIndex === -1) return;

  const lastMessage = messages[lastMessageIndex];

  if (isMessageEmpty(lastMessage)) {
    messages.splice(lastMessageIndex, 1);
    const processedMessages = normalizeMessagesForUI(messages);
    set(messagesAtom, processedMessages);
  }
}

export function injectMessage(
  get: Getter,
  set: Setter,
  messageData: {
    role: "user" | "assistant" | "system";
    parts: ConversationMessagePart[];
  }
) {
  const now = new Date();
  const current = get(messagesAtom);

  // If the most recent message is an active (non-final) assistant message,
  // backdate the injected message so it sorts before the assistant's createdAt.
  // This prevents the injected message from splitting the bot's response across
  // two bubbles and breaking the karaoke cursor.
  const lastMessage = current[current.length - 1];
  const lastAssistant =
    lastMessage?.role === "assistant" ? lastMessage : undefined;
  let timestamp: string;
  if (
    lastAssistant &&
    lastAssistant.final === false &&
    messageData.role === "system"
  ) {
    const assistantTime = new Date(lastAssistant.createdAt);
    timestamp = new Date(assistantTime.getTime() - 1).toISOString();
  } else {
    timestamp = now.toISOString();
  }

  const message: ConversationMessage = {
    role: messageData.role,
    final: true,
    parts: [...messageData.parts],
    createdAt: timestamp,
    updatedAt: now.toISOString(),
  };

  const updatedMessages = [...current, message];
  const processedMessages = normalizeMessagesForUI(updatedMessages);

  callCallbacks(get(messageCallbacksAtom), "onMessageCreated", message);
  set(messagesAtom, processedMessages);
}

export function upsertUserTranscript(
  get: Getter,
  set: Setter,
  text: string | ReactNode,
  final: boolean
) {
  const now = new Date();
  const messages = [...get(messagesAtom)];

  // Find last user message
  const lastUserIndex = findLastIndex(messages,(m) => m.role === "user");

  if (lastUserIndex !== -1 && !messages[lastUserIndex].final) {
    // Update existing user message
    const target = { ...messages[lastUserIndex] };
    const parts: ConversationMessagePart[] = Array.isArray(target.parts)
      ? [...target.parts]
      : [];

    const lastPart = parts[parts.length - 1];
    if (!lastPart || lastPart.final) {
      // Start a new part
      parts.push({ text, final, createdAt: now.toISOString() });
    } else {
      // Update in-progress part
      parts[parts.length - 1] = {
        ...lastPart,
        text,
        final,
      };
    }

    const updatedMessage: ConversationMessage = {
      ...target,
      parts,
      updatedAt: now.toISOString(),
    };

    messages[lastUserIndex] = updatedMessage;

    const processedMessages = normalizeMessagesForUI(messages);

    callCallbacks(get(messageCallbacksAtom), "onMessageUpdated", updatedMessage);
    set(messagesAtom, processedMessages);
    return;
  }

  // Create a new user message initialized with this transcript
  const newMessage: ConversationMessage = {
    role: "user",
    final: false,
    parts: [
      {
        text,
        final,
        createdAt: now.toISOString(),
      },
    ],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const updatedMessages = [...messages, newMessage];
  const processedMessages = normalizeMessagesForUI(updatedMessages);
  callCallbacks(get(messageCallbacksAtom), "onMessageCreated", newMessage);
  set(messagesAtom, processedMessages);
}

type BotOutputPayloadLegacy = {
  protocol: "legacy";
  /** @deprecated Protocol 1.4.x only. */
  spoken: boolean;
};

type BotOutputPayloadV2 = {
  protocol: "v2";
  will_be_spoken: boolean;
  spoken_status?: "new" | "in-progress" | "completed";
  spoken_progress?: { accumulated_text: string; remaining_text: string };
  segment_id?: number;
};

export type BotOutputPayload = BotOutputPayloadLegacy | BotOutputPayloadV2;

export function updateAssistantBotOutput(
  get: Getter,
  set: Setter,
  text: string,
  final: boolean,
  payload: BotOutputPayload,
  aggregatedBy?: string
) {
  // Strip turn-completion markers emitted by FilterIncompleteTurns before
  // the text enters conversation state.
  text = stripTurnCompletionMarker(text);
  if (text.length === 0) return;

  const now = new Date();
  const messages = [...get(messagesAtom)];
  const botOutputMessageState = new Map(get(botOutputMessageStateAtom));

  const lastAssistantIndex = findLastIndex(messages,
    (msg) => msg.role === "assistant"
  );

  let messageId: string;
  let isNewMessage = false;

  if (lastAssistantIndex === -1) {
    // Create new assistant message
    isNewMessage = true;
    messageId = now.toISOString();
    const newMessage: ConversationMessage = {
      role: "assistant",
      final,
      parts: [],
      createdAt: messageId,
      updatedAt: messageId,
    };
    messages.push(newMessage);
    // Initialize message state
    botOutputMessageState.set(messageId, {
      currentPartIndex: 0,
      currentCharIndex: 0,
      partFinalFlags: [],
      partSpokenOnly: [],
      hasReceivedUnspoken: false,
    });
  } else {
    // Update existing assistant message
    const lastMessage = messages[lastAssistantIndex];
    messageId = lastMessage.createdAt;

    messages[lastAssistantIndex] = {
      ...lastMessage,
      final: final ? true : lastMessage.final,
      updatedAt: now.toISOString(),
    };

    // Ensure message state exists
    if (!botOutputMessageState.has(messageId)) {
      botOutputMessageState.set(messageId, {
        currentPartIndex: 0,
        currentCharIndex: 0,
        partFinalFlags: [],
        partSpokenOnly: [],
        hasReceivedUnspoken: false,
      });
    }
  }

  // Store raw event for debugging/replay
  const botOutputEvents = new Map(get(botOutputEventsAtom));
  const existingEvents = botOutputEvents.get(messageId) || [];
  const rawEvent: BotOutputEvent =
    payload.protocol === "v2"
      ? {
          text,
          spoken: false, // legacy field unused in v2
          aggregatedBy,
          receivedAt: now.toISOString(),
          will_be_spoken: payload.will_be_spoken,
          spoken_status: payload.spoken_status,
          spoken_progress: payload.spoken_progress,
          segment_id: payload.segment_id,
        }
      : {
          text,
          spoken: payload.spoken,
          aggregatedBy,
          receivedAt: now.toISOString(),
        };
  botOutputEvents.set(messageId, [...existingEvents, rawEvent]);

  const messageState = botOutputMessageState.get(messageId)!;
  const message =
    messages[
      lastAssistantIndex === -1 ? messages.length - 1 : lastAssistantIndex
    ];
  const parts = [...(message.parts || [])];

  if (payload.protocol === "v2") {
    // -------------------------------------------------------------------------
    // RTVI Protocol 2.x.x path
    // -------------------------------------------------------------------------
    const { will_be_spoken, spoken_status, spoken_progress, segment_id } =
      payload;

    if (!will_be_spoken || spoken_status === "new") {
      // Each v2 event is a self-contained segment — always a new part.
      // Word-level aggregation does not exist in Protocol 2.0.0.
      const isDefaultType = aggregatedBy === "sentence" || !aggregatedBy;
      const newPart: ConversationMessagePart = {
        text,
        final: false,
        createdAt: now.toISOString(),
        aggregatedBy,
        displayMode: isDefaultType ? "inline" : undefined,
        segment_id,
        // Signal to the renderer that a separator space should precede this part.
        // The stored text is always the original segment text from the server.
        needsSeparator: parts.length > 0,
      };
      parts.push(newPart);
      messageState.partFinalFlags.push(false);
      messageState.partSpokenOnly.push(false);

      if (will_be_spoken) {
        messageState.hasReceivedUnspoken = true;
      }

      messages[
        lastAssistantIndex === -1 ? messages.length - 1 : lastAssistantIndex
      ] = { ...message, parts };
    } else if (spoken_status === "in-progress" && spoken_progress) {
      // TTS is actively speaking: the server gives us the exact split.
      applySpokenProgressV2(
        messageState,
        parts,
        spoken_progress.accumulated_text,
        segment_id
      );
    } else if (spoken_status === "completed") {
      // TTS finished this segment: advance cursor to end of current part.
      applySpokenProgressV2(
        messageState,
        parts,
        spoken_progress?.accumulated_text ?? (parts[messageState.currentPartIndex]?.text as string ?? ""),
        segment_id
      );
    }
  } else {
    // -------------------------------------------------------------------------
    // RTVI Protocol 1.4.x (legacy) path
    // -------------------------------------------------------------------------
    const spoken = payload.spoken;

    if (!spoken) {
      // UNSPOKEN EVENT: Create/update message parts immediately
      // Only append when both current and last part are word-level; sentence-level
      // and other types each get their own part so spoken events can match 1:1.
      const isDefaultType =
        aggregatedBy === "sentence" ||
        aggregatedBy === "word" ||
        !aggregatedBy;
      const lastPart = parts[parts.length - 1];
      const shouldAppend =
        lastPart &&
        aggregatedBy === "word" &&
        lastPart.aggregatedBy === "word" &&
        typeof lastPart.text === "string" &&
        !messageState.partSpokenOnly[parts.length - 1];

      if (shouldAppend) {
        // Append to last part (word-level only)
        const lastPartText = lastPart.text as string;
        const separator =
          lastPartText && !lastPartText.endsWith(" ") && !text.startsWith(" ")
            ? " "
            : "";
        parts[parts.length - 1] = {
          ...lastPart,
          text: lastPartText + separator + text,
        };
      } else {
        // Before creating a new unspoken part, check whether the trailing run
        // of spoken-only fallback parts forms a word-prefix of this new text.
        // If so, absorb them: S2S pipelines can emit word-level spoken events
        // for a sentence before the sentence-level unspoken event arrives.
        let scanStart = parts.length;
        while (
          scanStart > 0 &&
          messageState.partSpokenOnly[scanStart - 1] &&
          typeof parts[scanStart - 1].text === "string"
        ) {
          scanStart--;
        }

        // Character-level prefix match: concatenate the alphanumeric chars
        // of each trailing spoken-only part in order and check that the
        // running concatenation is a prefix of the new text's alphanumeric
        // chars. This handles TTS sub-word splits (e.g. "Pi"/"pec"/"at"
        // speaking "Pipecat") that a word-level matcher can't reconcile.
        let absorbed = 0;
        let absorbedAlnumCount = 0;
        if (scanStart < parts.length) {
          const alnumOnly = (s: string): string =>
            s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
          const textAlnum = alnumOnly(text);
          let running = 0;
          for (let i = scanStart; i < parts.length; i++) {
            const partAlnum = alnumOnly(parts[i].text as string);
            if (partAlnum.length === 0) {
              // Pure-punctuation fragment: absorb silently without extending
              // the running prefix (same semantics as applySpokenBotOutputProgress).
              absorbed++;
              continue;
            }
            const next = running + partAlnum.length;
            if (
              next <= textAlnum.length &&
              textAlnum.slice(running, next) === partAlnum
            ) {
              running = next;
              absorbedAlnumCount = running;
              absorbed++;
            } else {
              break;
            }
          }
        }

        // Translate the absorbed alphanumeric prefix count into a char
        // index inside the original (non-normalized) unspoken text,
        // advancing past any trailing punctuation and whitespace so the
        // cursor sits at the start of the next unspoken word.
        let absorbedCharIndex = 0;
        if (absorbedAlnumCount > 0) {
          const isAlnum = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
          let count = 0;
          for (let i = 0; i < text.length; i++) {
            if (isAlnum(text[i])) {
              count++;
              if (count === absorbedAlnumCount) {
                let j = i + 1;
                while (j < text.length && !isAlnum(text[j])) j++;
                absorbedCharIndex = j;
                break;
              }
            }
          }
        }

        // Create new part (sentence-level, custom types, or first word chunk)
        // Default to inline; custom types get displayMode from metadata in the hook
        const defaultDisplayMode = isDefaultType ? "inline" : undefined;
        const newPart: ConversationMessagePart = {
          text: text, // Store full text as string
          final: false, // Will be evaluated in hook based on metadata
          createdAt: now.toISOString(),
          aggregatedBy,
          displayMode: defaultDisplayMode,
        };

        if (absorbed > 0) {
          // Replace the absorbed spoken-only parts in place so the new
          // unspoken part sits where its spoken fragments originally landed
          // (before any trailing fallback parts that belong to later turns).
          const insertAt = scanStart;
          parts.splice(insertAt, absorbed, newPart);
          messageState.partFinalFlags.splice(insertAt, absorbed, false);
          messageState.partSpokenOnly.splice(insertAt, absorbed, false);

          if (absorbedCharIndex > 0) {
            messageState.currentPartIndex = insertAt;
            messageState.currentCharIndex = absorbedCharIndex;
            if (absorbedCharIndex >= text.length) {
              messageState.partFinalFlags[insertAt] = true;
            }
          }
        } else {
          parts.push(newPart);
          messageState.partFinalFlags.push(false);
          messageState.partSpokenOnly.push(false);
        }
      }

      messageState.hasReceivedUnspoken = true;

      // Update message with new parts
      messages[
        lastAssistantIndex === -1 ? messages.length - 1 : lastAssistantIndex
      ] = {
        ...message,
        parts,
      };
    } else {
      // SPOKEN EVENT: advance cursor into existing text, or add as new part
      // if there is none. Multi-word events (e.g. TTS emitting "Hello! I'm"
      // as a single chunk that crosses a sentence boundary) are split into
      // whitespace-separated tokens and processed one at a time so the
      // cursor can advance across unspoken-part boundaries.
      const tokens = text.trim().split(/\s+/).filter(Boolean);
      const leadingSpace = /^\s/.test(text) ? " " : "";
      const isDefaultType =
        aggregatedBy === "sentence" ||
        aggregatedBy === "word" ||
        !aggregatedBy;
      const defaultDisplayMode = isDefaultType ? "inline" : undefined;

      let partsMutated = false;
      for (let tokenIdx = 0; tokenIdx < tokens.length; tokenIdx++) {
        const tokenText =
          (tokenIdx === 0 ? leadingSpace : " ") + tokens[tokenIdx];
        const advanced =
          parts.length > 0 &&
          applySpokenBotOutputProgress(messageState, parts, tokenText);

        if (advanced) continue;

        if (messageState.hasReceivedUnspoken) {
          if (hasUnspokenContent(messageState, parts)) {
            // Mid-stream: the unspoken stream is authoritative for this
            // message and still has pending content to be spoken. An
            // unmatched spoken token here is TTS-granularity noise (e.g.
            // "Pi" / "pec" / "at" tokenization of "Pipecat"). Drop.
            continue;
          }
          if (normalizeForMatching(tokenText).trim().length === 0) {
            // Trailing punctuation after every part has been consumed has
            // nothing to attach to. Drop silently.
            continue;
          }
        }

        // Either no unspoken content has ever been seen (spoken-only bot),
        // or every part has been fully consumed and this token likely
        // belongs to the next sentence — whose unspoken event hasn't arrived
        // yet. Add as a spoken-only fallback so a later unspoken event can
        // absorb it.
        const newPart: ConversationMessagePart = {
          text: tokenText,
          final: false,
          createdAt: now.toISOString(),
          aggregatedBy,
          displayMode: defaultDisplayMode,
        };
        parts.push(newPart);
        messageState.partFinalFlags.push(true);
        messageState.partSpokenOnly.push(true);
        messageState.currentPartIndex = parts.length - 1;
        messageState.currentCharIndex = tokenText.length;
        partsMutated = true;
      }

      if (partsMutated) {
        messages[
          lastAssistantIndex === -1 ? messages.length - 1 : lastAssistantIndex
        ] = {
          ...message,
          parts,
        };
      }
    }
  }

  const processedMessages = normalizeMessagesForUI(messages);

  const cbs = get(messageCallbacksAtom);
  const updatedMsg =
    messages[
      lastAssistantIndex === -1 ? messages.length - 1 : lastAssistantIndex
    ];
  if (isNewMessage) {
    callCallbacks(cbs, "onMessageCreated", updatedMsg);
  } else {
    callCallbacks(cbs, "onMessageUpdated", updatedMsg);
  }

  set(messagesAtom, processedMessages);
  set(botOutputMessageStateAtom, botOutputMessageState);
  set(botOutputEventsAtom, botOutputEvents);
}

export function addFunctionCall(
  get: Getter,
  set: Setter,
  data: {
    function_name?: string;
    tool_call_id?: string;
    parent_tool_call_id?: string;
    args?: Record<string, unknown>;
  }
) {
  const messages = get(messagesAtom);

  // If a tool_call_id is provided, check for an existing entry to avoid duplicates
  if (data.tool_call_id) {
    const existingIndex = findLastIndex(messages,
      (msg) =>
        msg.role === "function_call" &&
        msg.functionCall?.tool_call_id === data.tool_call_id
    );
    if (existingIndex !== -1) return;
  }

  const now = new Date();

  // If the most recent message is an active (non-final) assistant message,
  // backdate the function call so it sorts before the assistant's createdAt.
  // This prevents the function call from splitting the bot's response across
  // two bubbles and breaking the karaoke cursor.
  const lastMessage = messages[messages.length - 1];
  let timestamp: string;
  if (
    lastMessage?.role === "assistant" &&
    lastMessage.final === false
  ) {
    const assistantTime = new Date(lastMessage.createdAt);
    timestamp = new Date(assistantTime.getTime() - 1).toISOString();
  } else {
    timestamp = now.toISOString();
  }

  const message: ConversationMessage = {
    role: "function_call",
    final: false,
    parts: [],
    createdAt: timestamp,
    updatedAt: now.toISOString(),
    functionCall: {
      function_name: data.function_name,
      tool_call_id: data.tool_call_id,
      parent_tool_call_id: data.parent_tool_call_id,
      args: data.args,
      status: "started",
    },
  };

  const updatedMessages = [...messages, message];
  const processedMessages = normalizeMessagesForUI(updatedMessages);
  callCallbacks(get(messageCallbacksAtom), "onMessageCreated", message);
  set(messagesAtom, processedMessages);
}

export function updateFunctionCall(
  get: Getter,
  set: Setter,
  tool_call_id: string,
  updates: Partial<
    Pick<
      FunctionCallData,
      | "status"
      | "result"
      | "cancelled"
      | "args"
      | "function_name"
      | "tool_call_id"
      | "parent_tool_call_id"
    >
  >
): boolean {
  const messages = [...get(messagesAtom)];
  const index = findLastIndex(messages,
    (msg) =>
      msg.role === "function_call" &&
      msg.functionCall?.tool_call_id === tool_call_id
  );
  if (index === -1) return false;

  const existing = messages[index];
  const updated: ConversationMessage = {
    ...existing,
    updatedAt: new Date().toISOString(),
    final: updates.status === "completed" ? true : existing.final,
    functionCall: {
      ...existing.functionCall!,
      ...updates,
      // parent_tool_call_id is kept once set; a later event without it does
      // not clear it.
      parent_tool_call_id:
        updates.parent_tool_call_id ?? existing.functionCall?.parent_tool_call_id,
    },
  };
  messages[index] = updated;

  const processedMessages = normalizeMessagesForUI(messages);
  callCallbacks(get(messageCallbacksAtom), "onMessageUpdated", updated);
  set(messagesAtom, processedMessages);
  return true;
}

/**
 * Update the most recent function call message that has status "started"
 * and no tool_call_id yet. Used when transitioning from Started → InProgress.
 */
export function updateLastStartedFunctionCall(
  get: Getter,
  set: Setter,
  updates: Partial<
    Pick<
      FunctionCallData,
      "status" | "tool_call_id" | "parent_tool_call_id" | "args" | "function_name"
    >
  >
): boolean {
  const messages = [...get(messagesAtom)];
  const index = findLastIndex(messages,
    (msg) =>
      msg.role === "function_call" &&
      msg.functionCall?.status === "started" &&
      !msg.functionCall?.tool_call_id
  );
  if (index === -1) return false;

  const existing = messages[index];
  const updated: ConversationMessage = {
    ...existing,
    updatedAt: new Date().toISOString(),
    functionCall: {
      ...existing.functionCall!,
      ...updates,
      // parent_tool_call_id is kept once set; a later event without it does
      // not clear it.
      parent_tool_call_id:
        updates.parent_tool_call_id ?? existing.functionCall?.parent_tool_call_id,
    },
  };
  messages[index] = updated;

  const processedMessages = normalizeMessagesForUI(messages);
  callCallbacks(get(messageCallbacksAtom), "onMessageUpdated", updated);
  set(messagesAtom, processedMessages);
  return true;
}

// ---------------------------------------------------------------------------
// High-level function call lifecycle handlers
// ---------------------------------------------------------------------------

export function handleFunctionCallStarted(
  get: Getter,
  set: Setter,
  data: { function_name?: string; parent_tool_call_id?: string }
) {
  const messages = get(messagesAtom);
  const lastFc = findLast(messages,
    (m: ConversationMessage) => m.role === "function_call"
  );

  // Check if InProgress already created an entry (events arrived out of order).
  if (
    lastFc?.functionCall &&
    lastFc.functionCall.status !== "started" &&
    Date.now() - new Date(lastFc.updatedAt ?? lastFc.createdAt).getTime() < 2000
  ) {
    if (
      data.function_name &&
      !lastFc.functionCall.function_name &&
      lastFc.functionCall.tool_call_id
    ) {
      updateFunctionCall(get, set, lastFc.functionCall.tool_call_id, {
        function_name: data.function_name,
        parent_tool_call_id: data.parent_tool_call_id,
      });
    }
    return;
  }

  addFunctionCall(get, set, {
    function_name: data.function_name,
    parent_tool_call_id: data.parent_tool_call_id,
  });
}

export function handleFunctionCallInProgress(
  get: Getter,
  set: Setter,
  data: {
    function_name?: string;
    tool_call_id: string;
    parent_tool_call_id?: string;
    args?: Record<string, unknown>;
  }
) {
  // Tier 1: Try to update the last "started" entry (from LLMFunctionCallStarted)
  const updated = updateLastStartedFunctionCall(get, set, {
    function_name: data.function_name,
    tool_call_id: data.tool_call_id,
    parent_tool_call_id: data.parent_tool_call_id,
    args: data.args,
    status: "in_progress",
  });

  if (!updated) {
    // Tier 2: Try updating an existing entry by tool_call_id
    const found = updateFunctionCall(get, set, data.tool_call_id, {
      function_name: data.function_name,
      parent_tool_call_id: data.parent_tool_call_id,
      args: data.args,
      status: "in_progress",
    });

    if (!found) {
      // Tier 3: No existing entry at all; create a new one as in_progress
      addFunctionCall(get, set, {
        function_name: data.function_name,
        tool_call_id: data.tool_call_id,
        parent_tool_call_id: data.parent_tool_call_id,
        args: data.args,
      });
      updateFunctionCall(get, set, data.tool_call_id, {
        status: "in_progress",
      });
    }
  }
}

export function handleFunctionCallStopped(
  get: Getter,
  set: Setter,
  data: {
    function_name?: string;
    tool_call_id: string;
    parent_tool_call_id?: string;
    result?: unknown;
    cancelled?: boolean;
  }
) {
  // Tier 1: Try updating by tool_call_id
  const found = updateFunctionCall(get, set, data.tool_call_id, {
    function_name: data.function_name,
    parent_tool_call_id: data.parent_tool_call_id,
    status: "completed",
    result: data.result,
    cancelled: data.cancelled,
  });

  if (!found) {
    // Tier 2: No match by tool_call_id (e.g. InProgress was skipped).
    const matched = updateLastStartedFunctionCall(get, set, {
      function_name: data.function_name,
      tool_call_id: data.tool_call_id,
      parent_tool_call_id: data.parent_tool_call_id,
    });
    if (matched) {
      updateFunctionCall(get, set, data.tool_call_id, {
        status: "completed",
        result: data.result,
        cancelled: data.cancelled,
      });
    }
  }
}
