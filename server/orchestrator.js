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
    this.sessions = {};
    this.wavWriters = {};
    this.sessionIds = {};
    this.topicNarrative = '';
    this.transcripts = {};
    this.outputDir = '';
    // Delay before pinging Speaker B (ms)
    this.pingDelayMs = 1000;
    // Assign distinct voices
    this.voices = { A: 'alloy', B: 'echo' };
  }

  /**
   * Generate a creative conversation topic using GPT-4o (text-only) via REST
   */
  async _generateTopic() {
    const topicSystem = 'You are a creative assistant who invents conversation topics.';
    const topicUser =
      'Generate a creative and expressive conversation topic with clear and specific character settings. ' +
      'Describe a scenario with two people (Speaker 1 and Speaker 2) in a specific setting, ' +
      'discussing a topic, with both speakers having an ultimate goal to convince each other or achieve a certain goal. ' +
      'The two speakers should be competing with each other, and the conversation should be intense and engaging. ' +
      'It should be in about 100 words.';

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: topicSystem },
          { role: 'user', content: topicUser }
        ]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Topic generation failed: ${err}`);
    }
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

  /**
   * Start two realtime sessions and initiate conversation with ordered pings
   */
  async start() {
    // 1) Generate topic narrative
    this.topicNarrative = await this._generateTopic();
    this.emit('log', { event: 'topic_generated', topic: this.topicNarrative });

    // 2) Create output folder named by timestamp
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    this.outputDir = timestamp;
    fs.mkdirSync(this.outputDir, { recursive: true });
    // Initialize transcripts
    this.transcripts = { A: '', B: '' };

    // 3) Create both sessions in parallel
    await Promise.all([
      this._createSession('A'),
      this._createSession('B')
    ]);

    // 4) Prepare combined wav writer
    this.wavWriters['combined'] = this._createWavWriter(`${this.outputDir}/conversation.wav`);

    // 5) Define prompts for each speaker
    const prompts = {
      A: {
        system: `Conversation Topic:\n${this.topicNarrative}\n\nYou are Speaker 1. Respond to the conversation in character.`,
        user: 'Speak now.\n(no more than 30 words)'
      },
      B: {
        system: `Conversation Topic:\n${this.topicNarrative}\n\nYou are Speaker 2. Respond to the conversation in character.`,
        user: 'Speak now.\n(no more than 30 words)'
      }
    };

    // 6) Ping Speaker A first
    this._sendInitialPrompts('A', prompts['A']);
    // 7) Delay then ping Speaker B
    await new Promise(resolve => setTimeout(resolve, this.pingDelayMs));
    this._sendInitialPrompts('B', prompts['B']);
  }

  /**
   * Helper to send prompts and response.create
   */
  _sendInitialPrompts(label, prompt) {
    // System message
    this.sessions[label].send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: prompt.system }]
        }
      })
    );
    this.emit('log', { session: label, event: 'system_prompt_sent' });

    // User message
    this.sessions[label].send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt.user }]
        }
      })
    );
    this.emit('log', { session: label, event: 'user_prompt_sent' });

    // Request response with audio and text
    this.sessions[label].send(
      JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio', 'text'], instructions: '' }
      })
    );
    this.emit('log', { session: label, event: 'response_create_sent' });
  }

  stop() {
    for (const label of ['A', 'B', 'combined']) {
      const ws = this.sessions[label];
      const writer = this.wavWriters[label];
      if (ws?.readyState === WebSocket.OPEN) ws.close();
      writer?.end();
      this.emit('log', { session: label, event: 'stopped' });
    }
    // 8) Save conversation details
    const record =
      `Topic:\n${this.topicNarrative}\n\nTranscript:\nSpeaker 1:\n${this.transcripts['A']}\n\nSpeaker 2:\n${this.transcripts['B']}`;
    fs.writeFileSync(`${this.outputDir}/conversation_details.txt`, record);
    this.emit('log', { event: 'transcript_saved', path: `${this.outputDir}/conversation_details.txt` });
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
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      ws.once('open', () => {
        this.emit('log', { session: label, event: 'connected', clientSessionId });
      });

      ws.on('message', raw => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (err) {
          return this.emit('error', err);
        }

        // Handle text streaming
        if (msg.type === 'response.text.delta') {
          this.transcripts[label] += msg.delta;
          return;
        }
        if (msg.type === 'response.text.done') {
          this.transcripts[label] += msg.text;
          return;
        }

        // Handle session.created
        if (msg.type === 'session.created') {
          this.sessionIds[label] = msg.session.id;
          this.emit('log', { session: label, event: 'session.created', sessionId: msg.session.id });

          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                modalities: ['audio', 'text'],
                voice: this.voices[label],
                turn_detection: {
                  type: 'server_vad',
                  create_response: true,
                  interrupt_response: false
                }
              }
            })
          );

          this.wavWriters[label] = this._createWavWriter(`${this.outputDir}/session${label}.wav`);
          this.sessions[label] = ws;
          resolve();
          return;
        }

        // Handle audio chunks/deltas
        if (msg.type === 'response.audio_chunk' || msg.type === 'response.audio.delta') {
          const b64 = msg.data ?? msg.delta;
          const chunk = Buffer.from(b64, 'base64');
          const silence = Buffer.alloc(chunk.length, 0);

          // Write individual tracks
          if (label === 'A') {
            this.wavWriters['A'].write(chunk);
            this.wavWriters['B'].write(silence);
          } else {
            this.wavWriters['B'].write(chunk);
            this.wavWriters['A'].write(silence);
          }
          // Write combined track
          this.wavWriters['combined'].write(chunk);

          // Forward audio
          const other = label === 'A' ? 'B' : 'A';
          const target = this.sessions[other];
          if (target?.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
          }
          this.emit('log', { session: label, event: 'audio_chunk', byteLength: chunk.length });
          return;
        }

        // Handle user commits
        if (msg.type === 'conversation.item.created' && msg.payload?.item.role === 'user') {
          this.emit('log', { session: label, event: 'user_committed' });
          ws.send(JSON.stringify({ type: 'response.create', session: this.sessionIds[label] }));
          this.emit('log', { session: label, event: 'response.create.sent' });
          return;
        }

        // Log other events
        this.emit('log', { session: label, event: msg.type, payload: msg });
      });

      ws.once('close', () => {
        Object.values(this.wavWriters).forEach(writer => writer?.end());
        this.emit('log', { session: label, event: 'closed' });
      });

      ws.on('error', err => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  _createWavWriter(path) {
    const fileStream = fs.createWriteStream(path);
    const writer = new wav.Writer({ sampleRate: 24000, channels: 1, bitDepth: 16 });
    writer.pipe(fileStream);
    return writer;
  }
}

// Export singleton
let orchestrator = null;
export function initOrchestrator() {
  if (!orchestrator) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment');
    orchestrator = new ArenaOrchestrator(apiKey);
  }
  return orchestrator;
}
