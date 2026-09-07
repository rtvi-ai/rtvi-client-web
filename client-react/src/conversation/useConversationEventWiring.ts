/**
 * Copyright (c) 2024, Daily.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

import {
  BotOutputData,
  BotReadyData,
  type LLMFunctionCallInProgressData,
  type LLMFunctionCallStartedData,
  type LLMFunctionCallStoppedData,
  RTVIEvent,
} from "@pipecat-ai/client-js";
import { useAtomCallback } from "jotai/utils";
import { useCallback, useEffect, useRef } from "react";

import { useRTVIClientEvent } from "../useRTVIClientEvent";
import { hasUnspokenContent } from "./botOutput";
import {
  addMessage,
  type BotOutputPayload,
  clearMessages,
  finalizeLastMessage,
  handleFunctionCallInProgress,
  handleFunctionCallStarted,
  handleFunctionCallStopped,
  removeEmptyLastMessage,
  snapSpeechCursorToEnd,
  updateAssistantBotOutput,
  updateLastMessage,
  upsertUserTranscript,
} from "./conversationActions";
import {
  botOutputMessageStateAtom,
  botOutputProtocolAtom,
  botOutputSupportedAtom,
  messagesAtom,
} from "./conversationAtoms";
import type { ConversationMessage } from "./types";
import { findLast, findLastIndex } from "./utils";

/**
 * Checks if a version meets a minimum version requirement.
 * Inlined to avoid adding a `semver` dependency.
 */
function isMinVersion(
  currentVersion: string,
  minVersion: [number, number, number]
): boolean {
  // Strip pre-release suffix (e.g. "1.1.0-beta.1" -> "1.1.0")
  const parts = currentVersion.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) > minVersion[i]) return true;
    if ((parts[i] || 0) < minVersion[i]) return false;
  }
  return true; // equal
}

/** Delay (ms) before finalizing the assistant message after bot stops speaking. */
const BOT_STOPPED_FINALIZE_DELAY_MS = 2500;

/**
 * Internal hook that wires RTVI events to conversation state atoms.
 * Called once inside PipecatConversationProvider.
 */
export function useConversationEventWiring() {
  const userStoppedTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const botStoppedSpeakingTimeoutRef =
    useRef<ReturnType<typeof setTimeout>>(undefined);
  const assistantStreamResetRef = useRef<number>(0);
  const botOutputLastChunkRef = useRef<{ spoken: string; unspoken: string }>({
    spoken: "",
    unspoken: "",
  });

  // Clean up pending timeouts on unmount
  useEffect(() => {
    return () => {
      clearTimeout(userStoppedTimeout.current);
      clearTimeout(botStoppedSpeakingTimeoutRef.current);
    };
  }, []);

  // -- helpers ---------------------------------------------------------------

  /** Cancel any pending delayed finalize, leaving no timer armed. */
  const cancelFinalizeTimer = useCallback(() => {
    clearTimeout(botStoppedSpeakingTimeoutRef.current);
    botStoppedSpeakingTimeoutRef.current = undefined;
  }, []);

  const finalizeLastAssistantMessageIfPending = useAtomCallback(
    useCallback((get, set) => {
      cancelFinalizeTimer();
      const messages = get(messagesAtom);
      const lastAssistant = findLast(messages,
        (m: ConversationMessage) => m.role === "assistant"
      );
      if (lastAssistant && !lastAssistant.final) {
        finalizeLastMessage(get, set, "assistant");
      }
    }, [cancelFinalizeTimer])
  );

  const ensureAssistantMessage = useAtomCallback(
    useCallback((get, set) => {
      const messages = get(messagesAtom);
      const lastAssistantIndex = findLastIndex(messages,
        (msg: ConversationMessage) => msg.role === "assistant"
      );
      const lastAssistant =
        lastAssistantIndex !== -1 ? messages[lastAssistantIndex] : undefined;

      if (!lastAssistant || lastAssistant.final) {
        // If the message was finalized but still has unspoken content, it was
        // finalized prematurely (e.g. BotStoppedSpeaking timer fired during a
        // TTS pause mid-response). Un-finalize it instead of creating a new
        // message bubble — but only when no user message followed.
        if (
          lastAssistant?.final &&
          lastAssistantIndex === messages.length - 1
        ) {
          const messageId = lastAssistant.createdAt;
          const botOutputState = get(botOutputMessageStateAtom);
          const cursor = botOutputState.get(messageId);
          if (
            cursor &&
            hasUnspokenContent(cursor, lastAssistant.parts || [])
          ) {
            updateLastMessage(get, set, "assistant", { final: false });
            return false;
          }
        }

        addMessage(get, set, {
          role: "assistant",
          final: false,
          parts: [],
        });
        assistantStreamResetRef.current += 1;
        return true;
      }
      return false;
    }, [])
  );

  /**
   * Arms (or re-arms) the delayed finalize for the in-flight assistant turn.
   *
   * Finalizing is deferred rather than immediate because the bot may just be
   * pausing mid-turn; BotStartedSpeaking cancels the timer when that happens.
   * On RTVI 2.0.0+ this timer and UserStartedSpeaking are the *only* things
   * that end an assistant turn, so any path that cancels the timer has to
   * re-arm it here rather than dropping it on the floor.
   */
  const armBotStoppedFinalizeTimer = useAtomCallback(
    useCallback((get, set) => {
      cancelFinalizeTimer();

      const messages = get(messagesAtom);
      const lastAssistant = findLast(messages,
        (m: ConversationMessage) => m.role === "assistant"
      );
      if (!lastAssistant || lastAssistant.final) return;

      botStoppedSpeakingTimeoutRef.current = setTimeout(() => {
        botStoppedSpeakingTimeoutRef.current = undefined;

        // The bot finished speaking normally (not interrupted), so all
        // text should render as "spoken".
        snapSpeechCursorToEnd(get, set);

        finalizeLastMessage(get, set, "assistant");
      }, BOT_STOPPED_FINALIZE_DELAY_MS);
    }, [cancelFinalizeTimer])
  );

  // -- event handlers --------------------------------------------------------

  useRTVIClientEvent(
    RTVIEvent.Connected,
    useAtomCallback(
      useCallback((get, set) => {
        clearMessages(get, set);
        set(botOutputSupportedAtom, null);
        set(botOutputProtocolAtom, null);
        cancelFinalizeTimer();
        botOutputLastChunkRef.current = { spoken: "", unspoken: "" };
      }, [cancelFinalizeTimer])
    )
  );

  useRTVIClientEvent(
    RTVIEvent.BotReady,
    useAtomCallback(
      useCallback((_get, set, botData: BotReadyData) => {
        const rtviVersion = botData.version;
        const supportsBotOutput = isMinVersion(rtviVersion, [1, 1, 0]);
        const isV2 = isMinVersion(rtviVersion, [2, 0, 0]);
        set(botOutputSupportedAtom, supportsBotOutput);
        set(botOutputProtocolAtom, isV2 ? "v2" : "legacy");
        if (isV2) {
          console.debug(`[Pipecat Client] Bot protocol version ${rtviVersion} — using RTVI 2.0.0 path (server-side speech progress).`);
        } else if (supportsBotOutput) {
          console.debug(`[Pipecat Client] Bot protocol version ${rtviVersion} — using legacy RTVI path (client-side speech progress).`);
        } else {
          console.debug(`[Pipecat Client] Bot protocol version ${rtviVersion} — BotOutput events not supported (requires RTVI 1.1.0+).`);
        }
      }, [])
    )
  );

  useRTVIClientEvent(
    RTVIEvent.BotOutput,
    useAtomCallback(
      useCallback(
        (get, set, data: BotOutputData) => {
          const protocol = get(botOutputProtocolAtom) ?? "legacy";

          if (protocol === "v2") {
            // Protocol 2.0.0: progress events (in-progress/completed) carry no
            // new text to display — they only advance the cursor. Skip
            // ensureAssistantMessage and spacing for those.
            const spoken_status = data.spoken_status;
            const isProgressEvent =
              spoken_status === "in-progress" || spoken_status === "completed";

            if (!isProgressEvent) {
              ensureAssistantMessage();
            }

            const payload: BotOutputPayload = {
              protocol: "v2",
              will_be_spoken: data.will_be_spoken ?? false,
              spoken_status: data.spoken_status,
              spoken_progress: data.spoken_progress,
              segment_id: data.segment_id,
            };

            // `aggregated_by` describes how the text was chunked, not whether
            // the turn is over: a turn contains many sentences. Marking each
            // sentence final ends the message after the first one, and the
            // next segment then opens a new bubble instead of continuing the
            // turn. On 2.0.0 the turn is finalized by BotStoppedSpeaking (or
            // by the user starting a new turn), so leave it open here.
            updateAssistantBotOutput(
              get,
              set,
              data.text,
              false,
              payload,
              data.aggregated_by
            );
          } else {
            // Protocol 1.4.x (legacy): use spoken boolean with inter-chunk spacing.
            ensureAssistantMessage();

            const isSpoken = data.will_be_spoken ?? data.spoken ?? false;

            // Handle spacing for BotOutput chunks
            let textToAdd = data.text;
            const lastChunk = isSpoken
              ? botOutputLastChunkRef.current.spoken
              : botOutputLastChunkRef.current.unspoken;

            if (lastChunk) {
              textToAdd = " " + textToAdd;
            }

            if (isSpoken) {
              botOutputLastChunkRef.current.spoken = textToAdd;
            } else {
              botOutputLastChunkRef.current.unspoken = textToAdd;
            }

            const payload: BotOutputPayload = {
              protocol: "legacy",
              spoken: isSpoken,
            };

            // Deliberately kept, and deliberately asymmetric with the 2.0.0
            // path above: on 1.4.x an unspoken event precedes the spoken one
            // for each sentence, so `hasUnspokenContent` is true and
            // `ensureAssistantMessage` reopens the message rather than
            // splitting it. The per-sentence `final` is effectively inert
            // here, so there is no turn-splitting bug to fix on this branch —
            // and passing `false` would change shipped behavior for nothing.
            const isFinal = data.aggregated_by === "sentence";
            updateAssistantBotOutput(
              get,
              set,
              textToAdd,
              isFinal,
              payload,
              data.aggregated_by
            );
          }

          // A BotOutput event means the response is still active, so push a
          // pending finalize deadline back rather than letting it fire
          // mid-turn. It is postponed, not dropped: on 2.0.0 nothing else ends
          // the turn, so cancelling outright for a trailing event would leave
          // the message non-final until the user speaks again. This handler is
          // synchronous, so a pending timer cannot have fired before here.
          // Re-arming is a no-op once the message is final (legacy path).
          if (botStoppedSpeakingTimeoutRef.current) {
            armBotStoppedFinalizeTimer();
          }
        },
        [armBotStoppedFinalizeTimer, ensureAssistantMessage]
      )
    )
  );

  useRTVIClientEvent(
    RTVIEvent.BotStoppedSpeaking,
    useCallback(() => {
      // Don't finalize immediately; start a timer. Bot may start speaking again (pause).
      armBotStoppedFinalizeTimer();
    }, [armBotStoppedFinalizeTimer])
  );

  useRTVIClientEvent(
    RTVIEvent.BotStartedSpeaking,
    useCallback(() => {
      // Bot is speaking again; reset the finalize timer (bot was just pausing).
      cancelFinalizeTimer();
    }, [cancelFinalizeTimer])
  );

  useRTVIClientEvent(
    RTVIEvent.UserStartedSpeaking,
    useAtomCallback(
      useCallback(
        (get, set) => {
          // User started a new turn; bot's turn is done. Fast-forward: finalize immediately.
          finalizeLastAssistantMessageIfPending();
          clearTimeout(userStoppedTimeout.current);

          // Only finalize the previous user message if the bot has responded since
          // the user last spoke. This prevents finalizing during VAD gaps (brief
          // breathing pauses within the same user turn where UserStoppedSpeaking/
          // UserStartedSpeaking fire without an actual turn change).
          const messages = get(messagesAtom);
          const lastUserIdx = findLastIndex(
            messages,
            (m: ConversationMessage) => m.role === "user"
          );
          if (lastUserIdx !== -1 && !messages[lastUserIdx].final) {
            const hasBotActivityAfterUser = messages
              .slice(lastUserIdx + 1)
              .some((m: ConversationMessage) => m.role === "assistant");
            if (hasBotActivityAfterUser) {
              finalizeLastMessage(get, set, "user");
            }
          }
        },
        [finalizeLastAssistantMessageIfPending]
      )
    )
  );

  useRTVIClientEvent(
    RTVIEvent.UserTranscript,
    useAtomCallback(
      useCallback((get, set, data) => {
        const text = data.text ?? "";
        const final = Boolean(data.final);
        upsertUserTranscript(get, set, text, final);

        // If we got any transcript, cancel pending cleanup
        clearTimeout(userStoppedTimeout.current);
      }, [])
    )
  );

  // user-llm-text fires when the user's input reaches the LLM — both in voice
  // mode (after STT) and in chat mode (typed text, no STT). In voice mode
  // user-transcription has already created an in-progress user message, so we
  // only need to finalize it. In chat mode no user message exists yet, so we
  // create one from the LLM text first, then finalize.
  useRTVIClientEvent(
    RTVIEvent.UserLlmText,
    useAtomCallback(
      useCallback((get, set, data) => {
        const messages = get(messagesAtom);
        const lastUserIdx = findLastIndex(
          messages,
          (m: ConversationMessage) => m.role === "user"
        );

        if (lastUserIdx === -1 || messages[lastUserIdx].final) {
          upsertUserTranscript(get, set, data.text ?? "", true);
        }
        finalizeLastMessage(get, set, "user");
      }, [])
    )
  );

  useRTVIClientEvent(
    RTVIEvent.UserStoppedSpeaking,
    useAtomCallback(
      useCallback((get, set) => {
        clearTimeout(userStoppedTimeout.current);
        // If no transcript ends up arriving, ensure any accidental empty placeholder is removed.
        userStoppedTimeout.current = setTimeout(() => {
          // Re-read state at timeout time
          const messages = get(messagesAtom);
          const lastUser = findLast(messages,
            (m: ConversationMessage) => m.role === "user"
          );
          const hasParts =
            Array.isArray(lastUser?.parts) && lastUser!.parts.length > 0;
          if (!lastUser || !hasParts) {
            removeEmptyLastMessage(get, set, "user");
          } else if (!lastUser.final) {
            finalizeLastMessage(get, set, "user");
          }
        }, 3000);
      }, [])
    )
  );

  // LLM Function Call lifecycle events
  useRTVIClientEvent(
    RTVIEvent.LLMFunctionCallStarted,
    useAtomCallback(
      useCallback((get, set, data: LLMFunctionCallStartedData) => {
        handleFunctionCallStarted(get, set, {
          function_name: data.function_name,
        });
      }, [])
    )
  );

  useRTVIClientEvent(
    RTVIEvent.LLMFunctionCallInProgress,
    useAtomCallback(
      useCallback((get, set, data: LLMFunctionCallInProgressData) => {
        handleFunctionCallInProgress(get, set, {
          function_name: data.function_name,
          tool_call_id: data.tool_call_id,
          args: data.arguments,
        });
      }, [])
    )
  );

  useRTVIClientEvent(
    RTVIEvent.LLMFunctionCallStopped,
    useAtomCallback(
      useCallback((get, set, data: LLMFunctionCallStoppedData) => {
        handleFunctionCallStopped(get, set, {
          function_name: data.function_name,
          tool_call_id: data.tool_call_id,
          result: data.result,
          cancelled: data.cancelled,
        });
      }, [])
    )
  );
}
