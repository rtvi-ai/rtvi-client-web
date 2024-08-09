import { createRoot } from "react-dom/client";
import {
  PipecatMetrics,
  Transcript,
  VoiceClient,
  VoiceEvent,
} from "realtime-ai";
import { VoiceClientProvider } from "realtime-ai-react";

import { DemoApp } from "./DemoApp";

const voiceClient = new VoiceClient({
  baseUrl: import.meta.env.VITE_BASE_URL,
  timeout: 3 * 1000,
  enableMic: true,
  callbacks: {
    onConnected: () => {
      console.log("[CALLBACK] Connected");
    },
    onDisconnected: () => {
      console.log("[CALLBACK] Disconnected");
    },
    onTransportStateChanged: (state: string) => {
      console.log("[CALLBACK] State change:", state);
    },
    onBotConnected: () => {
      console.log("[CALLBACK] Bot connected");
    },
    onBotReady: () => {
      console.log("[CALLBACK] Bot ready");
    },
    onBotDisconnected: () => {
      console.log("[CALLBACK] Bot disconnected");
    },
    onBotStartedTalking: () => {
      console.log("[CALLBACK] Bot started talking");
    },
    onBotStoppedTalking: () => {
      console.log("[CALLBACK] Bot stopped talking");
    },
    onLocalStartedTalking: () => {
      console.log("[CALLBACK] Local started talking");
    },
    onLocalStoppedTalking: () => {
      console.log("[CALLBACK] Local stopped talking");
    },
    onJsonCompletion: (jsonString: string) => {
      console.log("[CALLBACK] JSON Completion: ", jsonString);
    },
    onMetrics: (data: PipecatMetrics) => {
      console.log("[METRICS]:", data);
    },
    onUserTranscript: (data: Transcript) => {
      console.log("[USER TRANSCRIPT]:", data);
    },
    onBotTranscript: (text: string) => {
      console.log("[BOT TRANSCRIPT]:", text);
    },
  },
  config: {
    llm: {
      model: "llama3-70b-8192",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant named Gary. Briefly say hello!",
        },
      ],
    },
    tts: {
      voice: "79a125e8-cd45-4c13-8a67-188112f4dd22",
    },
  },
});

/**
 * Note: you can override the transport type for future interoperability
 *
 * import { StubTransport } from "./grok-voice-sdk/transport";
 * const voiceClient = new VoiceClient({
 *  config: {
 *    transport: StubTransport
 *  }
 * });
 */

// Some convenience events
// These are not required, but can be useful for debugging
voiceClient.on(VoiceEvent.TransportStateChanged, (state) => {
  console.log("[EVENT] Transport state change:", state);
});
voiceClient.on(VoiceEvent.BotReady, () => {
  console.log("[EVENT] Bot is ready");
});
voiceClient.on(VoiceEvent.Connected, () => {
  console.log("[EVENT] Voice client session has started");
});
voiceClient.on(VoiceEvent.Disconnected, () => {
  console.log("[EVENT] Disconnected");
});

const rootContainer = document.querySelector("#app") ?? document.body;

const root = createRoot(rootContainer);

root.render(
  <VoiceClientProvider voiceClient={voiceClient}>
    <DemoApp />
  </VoiceClientProvider>
);
