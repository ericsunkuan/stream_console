// server/orchestrator.js
import fs from 'fs';
import { EventEmitter } from 'events';
import wav from 'wav';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

class ArenaOrchestrator extends EventEmitter {
  constructor(apiKey, model = 'gpt-4o-realtime-preview') {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.sessions = {};      // WebSocket per agent
    this.wavWriters = {};    // WAV writer per agent
    this.sessionIds = {};    // Real session.id per agent
  }

  async start() {
    // 1) Spin up both sessions (A & B)
    await Promise.all([this._createSession('A'), this._createSession('B')]);
    // 2) Seed session A with initial audio
    const seed = fs.readFileSync('seed_hello.pcm');
    this._sendAudio('A', seed);
  }

  stop() {
    // Tear down both sessions and finalize files
    for (const label of ['A', 'B']) {
      const ws = this.sessions[label];
      const writer = this.wavWriters[label];
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      if (writer) writer.end();
      this.emit('log', { session: label, event: 'stopped' });
    }
  }

  async _createSession(label) {
    return new Promise((resolve, reject) => {
      const clientSessionId = uuidv4();
      const url = new URL('wss://api.openai.com/v1/realtime');
      url.searchParams.set('model', this.model);
      url.searchParams.set('session_id', clientSessionId);

      const ws = new WebSocket(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.once('open', () => {
        this.emit('log', {
          session: label,
          event: 'connected',
          clientSessionId,
        });
      });

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch (err) {
          return this.emit('error', err);
        }

        // 1. session.created → store real session ID & send session.update
        if (msg.type === 'session.created') {
          const realSid = msg.session.id;
          this.sessionIds[label] = realSid;
          this.emit('log', {
            session: label,
            event: 'session.created',
            sessionId: realSid,
          });

          // configure for audio+text with automatic transcription
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              modalities: ['audio','text'],
              input_audio_transcription: { model: 'whisper-1' }
            }
          }));

          // prepare WAV writer and store session
          this.wavWriters[label] = this._createWavWriter(
            `session${label}.wav`
          );
          this.sessions[label] = ws;
          resolve();
          return;
        }

        // 2. handle both legacy and delta audio events
        if (msg.type === 'response.audio_chunk' || msg.type === 'response.audio.delta') {
          // pick the correct base64 field
          const b64 = msg.data ?? msg.delta;
          const chunk = Buffer.from(b64, 'base64');

          // record locally
          this.wavWriters[label].write(chunk);

          // forward to the other session
          const other = label === 'A' ? 'B' : 'A';
          if (this.sessions[other]?.readyState === WebSocket.OPEN) {
            this.sessions[other].send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: b64
            }));
          }

          this.emit('log', {
            session: label,
            event: 'audio_chunk',
            byteLength: chunk.length
          });
          return;
        }

        // 3. transcript and other events → log
        //    transcripts arrive as response.audio_transcript.delta/done
        this.emit('log', {
          session: label,
          event: msg.type,
          payload: msg,
        });
      });

      ws.once('close', () => {
        this.wavWriters[label]?.end();
        this.emit('log', { session: label, event: 'closed' });
      });

      ws.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  _sendAudio(label, buffer) {
    const ws = this.sessions[label];
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: buffer.toString('base64'),
      }));
      this.emit('log', { session: label, event: 'seed_sent' });
    } else {
      this.emit('error', new Error(`Session ${label} not ready`));
    }
  }

  _createWavWriter(path) {
    const fileStream = fs.createWriteStream(path);
    const writer = new wav.Writer({
      sampleRate: 24000,
      channels: 1,
      bitDepth: 16,
    });
    writer.pipe(fileStream);
    return writer;
  }
}

// Export a singleton orchestrator
let orchestrator = null;
export function initOrchestrator() {
  if (!orchestrator) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment');
    orchestrator = new ArenaOrchestrator(apiKey);
  }
  return orchestrator;
}
