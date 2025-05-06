// server/orchestrator.js
import fs from "fs";
import { EventEmitter } from "events";
import wav from "wav";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

class ArenaOrchestrator extends EventEmitter {
  constructor(apiKey, model = "gpt-4o-realtime-preview") {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.sessions = {};       // WebSocket per label
    this.wavWriters = {};     // wav.Writer per label
    this.sessionIds = {};     // real session.id per label
    // Queues to serialize and throttle forwards per label
    this.forwardQueues = {
      A: Promise.resolve(),
      B: Promise.resolve(),
    };
  }

  async start() {
    // Launch A & B in parallel
    await Promise.all([this._createSession("A"), this._createSession("B")]);
    // Seed session A
    const seedBuffer = fs.readFileSync("seed_hello.pcm");
    this._sendAudio("A", seedBuffer);
  }

  stop() {
    for (const label of ["A", "B"]) {
      const ws = this.sessions[label];
      const writer = this.wavWriters[label];
      if (ws?.readyState === WebSocket.OPEN) ws.close();
      writer?.end();
      this.emit("log", { session: label, event: "stopped" });
    }
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
        this.emit("log", {
          session: label,
          event: "connected",
          clientSessionId,
        });
      });

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); }
        catch (err) { return this.emit("error", err); }

        // 1) session.created
        if (msg.type === "session.created") {
          const sid = msg.session.id;
          this.sessionIds[label] = sid;
          this.emit("log", { session: label, event: "session.created", sessionId: sid });

          // Configure: audio-only input, audio+text output, server VAD + auto-response
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              modalities: ["audio", "text"],
              turn_detection: {
                type: "server_vad",
                create_response: true
              }
            }
          }));
          this.emit("log", { session: label, event: "session.update.sent" });

          // Prepare WAV writer & store ws
          this.wavWriters[label] = this._createWavWriter(`session${label}.wav`);
          this.sessions[label] = ws;
          return resolve();
        }

        // 2) model's audio responses → record + forward with throttling
        if (msg.type === "response.audio_chunk" || msg.type === "response.audio.delta") {
          const b64 = msg.data ?? msg.delta;
          const chunk = Buffer.from(b64, "base64");
          this.wavWriters[label].write(chunk);
          this.emit("log", { session: label, event: "audio_chunk", byteLength: chunk.length });

          const other = label === "A" ? "B" : "A";
          const target = this.sessions[other];
          if (target?.readyState === WebSocket.OPEN) {
            // Throttle by queuing
            this.forwardQueues[other] = this.forwardQueues[other].then(() => {
              // Send chunk
              target.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: b64
              }));
              // Compute delay: bytes / (48000 bytes/sec) => ms
              const delayMs = (chunk.length / 48000) * 1000;
              return new Promise((res) => setTimeout(res, delayMs));
            });
          }
          return;
        }

        // 3) all other events → log
        this.emit("log", { session: label, event: msg.type, payload: msg });
      });

      ws.once("close", () => {
        this.wavWriters[label]?.end();
        this.emit("log", { session: label, event: "closed" });
      });

      ws.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
    });
  }

  _sendAudio(label, buffer) {
    const ws = this.sessions[label];
    if (ws?.readyState === WebSocket.OPEN) {
      // Seed doesn't need real-time pacing
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: buffer.toString("base64"),
      }));
      this.emit("log", { session: label, event: "seed_sent" });
    } else {
      this.emit("error", new Error(`Session ${label} not ready`));
    }
  }

  _createWavWriter(path) {
    const fileStream = fs.createWriteStream(path);
    const writer = new wav.Writer({ sampleRate: 24000, channels: 1, bitDepth: 16 });
    writer.pipe(fileStream);
    return writer;
  }
}

// Singleton export
let orchestrator = null;
export function initOrchestrator() {
  if (!orchestrator) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    orchestrator = new ArenaOrchestrator(apiKey);
  }
  return orchestrator;
}
