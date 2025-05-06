// server/orchestrator.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import wav from "wav";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const recordingsDir = path.join(__dirname, "..", "recordings");
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

class ArenaOrchestrator extends EventEmitter {
  constructor(apiKey, model = "gpt-4o-realtime-preview") {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.sessions = {};         // WebSocket per label
    this.sessionIds = {};       // real session.id per label
    this.events = { A: [], B: [] };  // timestamped audio
    this.forwardQueues = { A: Promise.resolve(), B: Promise.resolve() };
    this.startTime = null;
  }

  async start() {
    this.startTime = Date.now();
    await Promise.all([this._createSession("A"), this._createSession("B")]);
    const seed = fs.readFileSync("seed_hello.pcm");
    this._streamTo("A", seed);
  }

  stop() {
    ["A", "B"].forEach(label => {
      const ws = this.sessions[label];
      if (ws?.readyState === WebSocket.OPEN) ws.close();
      this.emit("log", { session: label, event: "stopped" });
    });
    this._writeConversationFiles();
  }

  async _createSession(label) {
    return new Promise((resolve, reject) => {
      const clientSessionId = uuidv4();
      const url = new URL("wss://api.openai.com/v1/realtime");
      url.searchParams.set("model", this.model);
      url.searchParams.set("session_id", clientSessionId);

      const ws = new WebSocket(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      ws.once("open", () => {
        this.emit("log", { session: label, event: "connected", clientSessionId });
      });

      ws.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw); }
        catch (err) { return this.emit("error", err); }

        // 1) Session created → configure voice & VAD
        if (msg.type === "session.created") {
          const sid = msg.session.id;
          this.sessionIds[label] = sid;
          this.emit("log", { session: label, event: "session.created", sessionId: sid });

          // Choose distinct voices per session
          const voice = label === "A" ? "alloy" : "echo";

          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              modalities: ["audio","text"],
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: false
              },
              voice
            }
          }));
          this.emit("log", { session: label, event: "session.update.sent", voice });

          this.sessions[label] = ws;
          return resolve();
        }

        // 2) Model audio → record timestamp + forward
        if (msg.type === "response.audio_chunk" || msg.type === "response.audio.delta") {
          const b64 = msg.data ?? msg.delta;
          const chunk = Buffer.from(b64, "base64");
          const t = Date.now() - this.startTime;
          this.events[label].push({ t, data: chunk });
          this.emit("log", { session: label, event: "audio_chunk", byteLength: chunk.length });

          const other = label === "A" ? "B" : "A";
          this.forwardQueues[other] = this.forwardQueues[other]
            .then(() => this._streamTo(other, chunk));
          return;
        }

        // 3) Other events → log
        this.emit("log", { session: label, event: msg.type, payload: msg });
      });

      ws.once("close", () => {
        this.emit("log", { session: label, event: "closed" });
      });

      ws.on("error", err => {
        this.emit("error", err);
        reject(err);
      });
    });
  }

  /** Stream a PCM buffer in 20ms frames at real-time pace */
  async _streamTo(label, buffer) {
    const ws = this.sessions[label];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.emit("error", new Error(`Session ${label} not ready`));
      return;
    }
    const frameSize = 960; // 20ms @48kHz mono
    for (let i = 0; i < buffer.length; i += frameSize) {
      const frame = buffer.slice(i, i + frameSize);
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: frame.toString("base64"),
      }));
      await new Promise(r => setTimeout(r, 20));
    }
  }

  _writeConversationFiles() {
    const sampleRate = 24000, bitDepth = 16, channels = 1;
    const bytesPerMs = (sampleRate * (bitDepth/8)) / 1000;

    const build = (events, name) => {
      const file = path.join(recordingsDir, name);
      const writer = new wav.Writer({ sampleRate, channels, bitDepth });
      writer.pipe(fs.createWriteStream(file));
      let cursor = 0;
      events.sort((a,b) => a.t - b.t);
      for (const {t, data} of events) {
        const gap = t - cursor;
        if (gap > 0) writer.write(Buffer.alloc(Math.round(gap * bytesPerMs)));
        writer.write(data);
        cursor = t + (data.length / bytesPerMs);
      }
      writer.end();
      console.log(`[Orchestrator] Wrote ${name}`);
    };

    build(this.events.A, "sessionA_full.wav");
    build(this.events.B, "sessionB_full.wav");
    const merged = [...this.events.A, ...this.events.B].sort((a,b)=>a.t-b.t);
    build(merged, "conversation.wav");
  }
}

// Export singleton
let orchestrator = null;
export function initOrchestrator() {
  if (!orchestrator) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    orchestrator = new ArenaOrchestrator(apiKey);
  }
  return orchestrator;
}
