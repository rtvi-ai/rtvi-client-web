# Real-Time Voice Inference Web SDK

[![Docs](https://img.shields.io/badge/documentation-blue)](https://docs.rtvi.ai)
![NPM Version](https://img.shields.io/npm/v/realtime-ai)

RTVI Web provides a browser client for real-time voice and video inference.

## Overview 
RTVI is an open standard that aims to support a wide variety of use cases.

The core functionality of the SDK has a fairly small footprint:

- Device and media stream management
- Managing bot configuration
- Sending generic actions to the bot
- Handling bot messages and responses
- Managing session state and errors

To connect to a bot, you will need both this SDK and a transport implementation.

It’s also recommended for you to stand up your own server-side endpoints to handle authentication, and passing your bot process secrets (such as service API keys, etc) that would otherwise be compromised on the client.

The entry point for creating a client can be found via:

- [RTVI JS](/rtvi-client-js/) `realtime-ai`

React context, hooks and components:

- [RTVI React](/rtvi-client-react/) `realtime-ai-react`

**Transport packages:**

For connected use-cases, you must pass a transport instance to the constructor for your chosen protocol or provider.

For example, if you were looking to use WebRTC as a transport layer, you may use a provider like [Daily](https://daily.co). In this scenario, you’d construct a transport instance and pass it to the client accordingly:

```ts
import { RTVIClient } from "realtime-ai";
import { DailyTransport } from "realtime-ai-daily";

const dailyTransport = new DailyTransport();
const rtviClient = new RTVIClient({
  transport: dailyTransport
});

```

RTVI requires a media transport for sending and receiving audio and video data over the internet. RTVI Web does not include any transport capabilities out of the box, so you will need to install the package for your chosen provider.

All transport packages (such as `DailyTransport`) extend from the Transport base class defined in RTVI core. You can extend this class if you are looking to implement your own or add additional functionality.


## Install

```bash
# Install latest package from NPM
npm install realtime-ai realtime-ai-daily
# or 
yarn add realtime-ai realtime-ai-daily
```

## Quickstart

To connect to a bot, you will need both this SDK and a transport implementation.

It’s also recommended for you to stand up your own server-side endpoints to handle authentication, and passing your bot process secrets (such as service API keys, etc) that would otherwise be compromised on the client.

#### Starter projects:

Creating and starting a session with RTVI Web (using Daily as transport):

```typescript
import { RTVIEvent, RTVIMessage, RTVIClient } from "realtime-ai";
import { DailyTransport } from "realtime-ai-daily";

const dailyTransport = new DailyTransport();

const rtviClient = new RTVIClient({
  transport: dailyTransport,
  params: {
    baseUrl: "https://your-server-side-url",
    services: {
      llm: "together",
      tts: "cartesia",
    },
    config: [
      {
        service: "tts",
        options: [
          { name: "voice", value: "79a125e8-cd45-4c13-8a67-188112f4dd22" }
        ]
      },
      {
        service: "llm",
        options: [
          { name: "model", value: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" },
          {
            name: "messages",
            value: [
              {
                role: "system",
                content:
                  "You are a assistant called ExampleBot. You can ask me anything. Keep responses brief and legible. Your responses will be converted to audio, so please avoid using any special characters except '!' or '?'.",
              }
            ]
          }
        ]
      }
    ]
  },
  enableMic: true,
  enableCam: false,
  timeout: 15 * 1000,
  callbacks: {
    onConnected: () => {
      console.log("[CALLBACK] User connected");
    },
    onDisconnected: () => {
      console.log("[CALLBACK] User disconnected");
    },
    onTransportStateChanged: (state: string) => {
      console.log("[CALLBACK] State change:", state);
    },
    onBotConnected: () => {
      console.log("[CALLBACK] Bot connected");
    },
    onBotDisconnected: () => {
      console.log("[CALLBACK] Bot disconnected");
    },
    onBotReady: () => {
      console.log("[CALLBACK] Bot ready to chat!");
    },
  },
});

try {
  await rtviClient.connect();
} catch (e) {
  console.error(e.message);
}

// Events
rtviClient.on(RTVIEvent.TransportStateChanged, (state) => {
  console.log("[EVENT] Transport state change:", state);
});
rtviClient.on(RTVIEvent.BotReady, () => {
  console.log("[EVENT] Bot is ready");
});
rtviClient.on(RTVIEvent.Connected, () => {
  console.log("[EVENT] User connected");
});
rtviClient.on(RTVIEvent.Disconnected, () => {
  console.log("[EVENT] User disconnected");
});
```

## Documentation

RTVI projects implement a client instance that:

- Facilitates web requests to an endpoint you create.
- Dispatches single-turn actions to a HTTP bot service when disconnected.
- Provides methods that handle the connectivity state and realtime interaction with your bot service.
- Manages media transport (such as audio and video).
- Provides callbacks and events for handling bot messages and actions.
- Optionally configures your AI services and pipeline.

Docs and API reference can be found at https://docs.rtvi.ai

## Hack on the framework

Install a provider transport

```bash
yarn
yarn workspace realtime-ai build
```

Watch for file changes:

```bash
yarn workspace realtime-ai run dev
```