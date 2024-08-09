import { useCallback, useRef, useState } from "react";
import {
  useVoiceClient,
  useVoiceClientEvent,
  useVoiceClientMediaDevices,
  useVoiceClientTransportState,
  VoiceClientAudio,
} from "realtime-ai-react";
import {
  PipecatMetrics,
  Transcript,
  RateLimitError,
  TransportState,
  VoiceClientConfigOptions,
  VoiceEvent,
  TransportAuthBundleError,
  ConnectionTimeoutError,
} from "realtime-ai";

export const DemoApp = () => {
  const voiceClient = useVoiceClient()!;
  const [isConnected, setIsConnected] = useState(false);
  const [isBotConnected, setIsBotConnected] = useState(false);
  const [transportState, setTransportState] = useState<TransportState>(
    voiceClient.state
  );
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<VoiceClientConfigOptions>(
    voiceClient.config
  );
  const [llmContext, setLlmContext] = useState<
    { role: string; content: string }[] | undefined
  >(voiceClient.llmContext?.messages);

  const [message, setMessage] = useState<string>("");
  const [role, setRole] = useState<string>("user");
  const [voice, setVoice] = useState<string | undefined>(
    voiceClient.config.tts?.voice
  );

  async function start() {
    try {
      await voiceClient.start();
    } catch (e) {
      if (e instanceof RateLimitError) {
        setError("Demo is currently at capacity. Please try again later.");
      } else if (e instanceof TransportAuthBundleError) {
        setError(e.message);
      } else if (e instanceof ConnectionTimeoutError) {
        setError(e.message);
      } else {
        setError("Unknown error occurred");
      }
    }
  }

  const stateHook = useVoiceClientTransportState();
  console.log("[HOOK]", stateHook);

  useVoiceClientEvent(
    VoiceEvent.Connected,
    useCallback(() => {
      console.log(`[SESSION EXPIRY] ${voiceClient.transportExpiry}`);
      setIsConnected(true);
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.JSONCompletion,
    useCallback((jsonString: string) => {
      console.log("UseVoiceClientEvent json string received:", jsonString);
      const fnData = JSON.parse(jsonString);
      if (fnData) {
        voiceClient.appendLLMContext([
          { role: "user", content: '{"identity": "confirmed"}' },
          {
            role: "user",
            content: "Tell me I'm a secret spy.",
          },
        ]);
      }
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.Disconnected,
    useCallback(() => {
      setIsConnected(false);
      setIsBotConnected(false);
    }, [])
  );
  useVoiceClientEvent(
    VoiceEvent.ParticipantConnected,
    useCallback((p) => {
      if (!p.local) setIsBotConnected(true);
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.TransportStateChanged,
    useCallback((state: TransportState) => {
      setTransportState(state);
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.ParticipantLeft,
    useCallback((p) => {
      if (!p.local) setIsBotConnected(false);
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.ConfigUpdated,
    useCallback((config: VoiceClientConfigOptions) => {
      console.log(config);
      setConfig(config);
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.Metrics,
    useCallback((data: PipecatMetrics) => {
      console.log(
        "UseVoiceClientEvent voice client event with pipecat metrics:",
        data
      );
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.UserTranscript,
    useCallback((data: Transcript) => {
      console.log("UseVoiceClientEvent transcript:", data);
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.BotTranscript,
    useCallback((text: string) => {
      console.log("useVoiceClientEvent bot text:", text);
    }, [])
  );

  const { availableMics, selectedMic, updateMic } =
    useVoiceClientMediaDevices();

  return (
    <div>
      <style scoped>{`
        .participants-wrapper {
          display: flex;
          gap: 8px;
        }
        .meter-wrapper {
          align-items: center;
          display: flex;
          flex-direction: column;
          gap: 8px;
          justify-content: center;
        }
      `}</style>
      <h1>Hello RealtimeAI Sandbox</h1>
      Expiry: {isBotConnected && voiceClient.transportExpiry?.toString()}
      {error}
      <p>
        <strong>
          Bot is {isBotConnected ? "connected" : "not connected"} (
          {transportState})
        </strong>
      </p>
      <div className="participants-wrapper">
        <div className="meter-wrapper">
          <strong>You</strong>
          <MicMeter type={VoiceEvent.LocalAudioLevel} />
        </div>
        {isBotConnected && (
          <div className="meter-wrapper">
            <strong>Bot</strong>
            <MicMeter type={VoiceEvent.RemoteAudioLevel} />
          </div>
        )}
      </div>
      <hr />
      <label htmlFor="mic">
        <strong>Microphone</strong>
        <br />
        <select
          id="mic"
          onChange={(ev) => updateMic(ev.currentTarget.value)}
          value={selectedMic?.deviceId}
        >
          {availableMics.map((mic) => (
            <option key={mic.deviceId} value={mic.deviceId}>
              {mic.label}
            </option>
          ))}
        </select>
      </label>
      <hr />
      <button
        disabled={transportState !== "idle"}
        onClick={() => voiceClient.initDevices()}
      >
        Init devices
      </button>
      <button
        disabled={transportState !== "idle" && transportState !== "initialized"}
        onClick={() => start()}
      >
        Connect
      </button>
      <button disabled={!isConnected} onClick={() => voiceClient.disconnect()}>
        Disconnect
      </button>
      <hr />
      <strong>Config:</strong>
      <textarea
        style={{ width: "100%" }}
        rows={15}
        readOnly
        value={JSON.stringify(config, null, 2)}
      />
      <hr />
      <strong>LLM Context:</strong>
      <textarea
        style={{ width: "100%" }}
        rows={10}
        defaultValue={JSON.stringify(llmContext, null, 2)}
        onChange={(e) => {
          setLlmContext(JSON.parse(e.target.value));
        }}
      />
      <button
        onClick={() => {
          voiceClient.llmContext = {
            messages: llmContext,
          };
        }}
      >
        Update LLM context
      </button>
      <hr />
      Model:
      <select
        defaultValue={voiceClient.llmContext?.model}
        onChange={(e) => {
          voiceClient.updateConfig(
            { llm: { model: e.target.value } },
            { useDeepMerge: true }
          );
        }}
      >
        <option value="llama3-8b-8192">llama3-8b-8192</option>
        <option value="llama3-70b-8192">llama3-70b-8192</option>
      </select>
      <br />
      Voice:{" "}
      <input
        type="text"
        defaultValue={voice}
        onChange={(e) => {
          setVoice(e.target.value);
        }}
      />
      <button
        onClick={() =>
          voiceClient.updateConfig(
            { tts: { voice: voice } },
            { useDeepMerge: false, sendPartial: true }
          )
        }
      >
        Update voice
      </button>
      <hr />
      <button
        onClick={() =>
          voiceClient.say("Can you believe how great Pipecat is?", true)
        }
      >
        Say "Can you believe how great Pipecat is?"
      </button>
      <button onClick={() => voiceClient.interrupt()}>Interrupt</button>
      <hr />
      <input
        type="text"
        defaultValue={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <select defaultValue={role} onChange={(e) => setRole(e.target.value)}>
        <option value="user">User</option>
        <option value="assistant">Assistant</option>
      </select>
      <button
        onClick={() => {
          voiceClient.appendLLMContext({ role: role, content: message });
          setMessage("");
        }}
      >
        Send message
      </button>
      <VoiceClientAudio />
    </div>
  );
};

type MeterType = VoiceEvent.LocalAudioLevel | VoiceEvent.RemoteAudioLevel;

interface MeterProps {
  type: MeterType;
}

const MicMeter: React.FC<MeterProps> = ({ type }) => {
  const meterRef = useRef<HTMLInputElement>(null);

  useVoiceClientEvent(
    type,
    useCallback((level: number) => {
      if (!meterRef.current) return;
      meterRef.current.style.width = 100 * Math.min(1, 3 * level) + "%";
    }, [])
  );

  useVoiceClientEvent(
    VoiceEvent.Disconnected,
    useCallback(() => {
      if (!meterRef.current) return;
      meterRef.current.style.width = "";
    }, [type])
  );

  return (
    <div
      style={{
        background: "#fafafa",
        height: "4px",
        margin: "20px 0",
        position: "relative",
        width: "150px",
      }}
    >
      <div
        ref={meterRef}
        style={{
          background: "blue",
          borderRadius: "4px",
          position: "absolute",
          top: 0,
          left: 0,
          height: "100%",
          transition: "width 100ms ease",
        }}
      />
    </div>
  );
};
