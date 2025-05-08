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
    this.pingDelayMs = 1000; // Delay before pinging Speaker B
    this.voices = { A: 'alloy', B: 'echo' };
  }

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

  async start() {
    this.topicNarrative = await this._generateTopic();
    this.emit('log', { event: 'topic_generated', topic: this.topicNarrative });

    // Setup output folder and transcripts
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    this.outputDir = `session_${timestamp}`;
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.transcripts = { A: '', B: '' };

    await Promise.all([
      this._createSession('A'),
      this._createSession('B')
    ]);

    // Combined conversation writer
    this.wavWriters['combined'] = this._createWavWriter(`${this.outputDir}/conversation.wav`);

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

    // Ping A then B after delay
    this._sendInitialPrompts('A', prompts.A);
    await new Promise(r => setTimeout(r, this.pingDelayMs));
    this._sendInitialPrompts('B', prompts.B);
  }

  _sendInitialPrompts(label, prompt) {
    this.sessions[label].send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: prompt.system }] }
    }));
    this.emit('log', { session: label, event: 'system_prompt_sent' });

    this.sessions[label].send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt.user }] }
    }));
    this.emit('log', { session: label, event: 'user_prompt_sent' });

    this.sessions[label].send(JSON.stringify({
      type: 'response.create',
      response: { modalities: ['audio', 'text'], instructions: '' }
    }));
    this.emit('log', { session: label, event: 'response_create_sent' });
  }

  async stop() {
    // Close sessions and writers
    for (const label of ['A', 'B', 'combined']) {
      const ws = this.sessions[label];
      if (ws?.readyState === WebSocket.OPEN) ws.close();
      this.wavWriters[label]?.end();
      this.emit('log', { session: label, event: 'stopped' });
    }

    // Save transcripts record
    const recordPath = `${this.outputDir}/conversation_details.txt`;
    const recordContent =
      `Topic:\n${this.topicNarrative}\n\nSpeaker 1 Transcript:\n${this.transcripts.A}\n\nSpeaker 2 Transcript:\n${this.transcripts.B}`;
    fs.writeFileSync(recordPath, recordContent);
    this.emit('log', { event: 'transcript_saved', path: recordPath });

    // Prepare evaluation prompt and user content
    const evaluationSystem =
      'You are an expert speech coach evaluating a conversation between two speakers. ' +
      'Assess each speakers performance on the following metrics:\n' +
      '1. Rhythm Control (flow and pace of speech)\n' +
      '2. Emotional Expression (conveying feeling and tone)\n' +
      '3. Pronunciation (clarity and correctness of speech sounds)\n' +
      '4. Semantic Clarity and Relevance (clarity of meaning and relevance of response)\n' +
      '5. Persuasiveness of the argument and the ability to convince the other speaker.\n' +
      'Provide detailed feedback for each speaker on each metric, then give a score out of 10 for each metric for each speaker. ' +
      'Finally, provide a brief overall impression of each speaker speaking style.';
    const userContent = [];

    // Speaker 1 audio & transcript
    const audioA = fs.readFileSync(`${this.outputDir}/sessionA.wav`);
    userContent.push({ type: 'text', text: 'Speaker 1 Audio:' });
    userContent.push({ type: 'input_audio', input_audio: { data: audioA.toString('base64'), format: 'wav' } });
    userContent.push({ type: 'text', text: `(Transcript: "${this.transcripts.A}")` });

    // Speaker 2 audio & transcript
    const audioB = fs.readFileSync(`${this.outputDir}/sessionB.wav`);
    userContent.push({ type: 'text', text: 'Speaker 2 Audio:' });
    userContent.push({ type: 'input_audio', input_audio: { data: audioB.toString('base64'), format: 'wav' } });
    userContent.push({ type: 'text', text: `(Transcript: "${this.transcripts.B}")` });

    // Call OpenAI for evaluation
    const evalRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model: 'gpt-4o-audio-preview', messages: [
          { role: 'system', content: evaluationSystem },
          { role: 'user', content: userContent }
        ]
      })
    });
    if (!evalRes.ok) throw new Error(`Evaluation API error: ${await evalRes.text()}`);
    const evalData = await evalRes.json();
    const report = evalData.choices[0].message.content.trim();

    // Save evaluation report
    const evalPath = `${this.outputDir}/evaluation_report.txt`;
    fs.writeFileSync(evalPath, report);
    this.emit('log', { event: 'evaluation_saved', path: evalPath });
  }

  async _createSession(label) {
    return new Promise((resolve, reject) => {
      const clientSessionId = uuidv4();
      const url = new URL('wss://api.openai.com/v1/realtime');
      url.searchParams.set('model', this.model);
      url.searchParams.set('session_id', clientSessionId);

      const ws = new WebSocket(url.toString(), {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'OpenAI-Beta': 'realtime=v1' }
      });

      ws.once('open', () => this.emit('log', { session: label, event: 'connected', clientSessionId }));

      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return this.emit('error', e); }

        // Text streaming
        if (msg.type === 'response.text.delta') {
          this.transcripts[label] += msg.delta;
          return;
        }
        if (msg.type === 'response.text.done') {
          this.transcripts[label] += msg.text;
          return;
        }

        // Session created
        if (msg.type === 'session.created') {
          this.sessionIds[label] = msg.session.id;
          ws.send(JSON.stringify({ type: 'session.update', session: {
            input_audio_format: 'pcm16', output_audio_format: 'pcm16', modalities: ['audio', 'text'],
            voice: this.voices[label], turn_detection: { type: 'server_vad', create_response: true, interrupt_response: false }
          }}));
          this.wavWriters[label] = this._createWavWriter(`${this.outputDir}/session${label}.wav`);
          this.sessions[label] = ws;
          return resolve();
        }

        // Audio chunks
        if (msg.type === 'response.audio_chunk' || msg.type === 'response.audio.delta') {
          const chunk = Buffer.from(msg.data ?? msg.delta, 'base64');
          const silence = Buffer.alloc(chunk.length);
          if (label === 'A') { this.wavWriters.A.write(chunk); this.wavWriters.B.write(silence); }
          else { this.wavWriters.B.write(chunk); this.wavWriters.A.write(silence); }
          this.wavWriters.combined.write(chunk);

          const other = label === 'A' ? 'B' : 'A';
          const target = this.sessions[other];
          if (target?.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.data ?? msg.delta }));
          }
          return;
        }

        // User committed
        if (msg.type === 'conversation.item.created' && msg.payload?.item.role === 'user') {
          ws.send(JSON.stringify({ type: 'response.create', session: this.sessionIds[label] }));
          return;
        }

        this.emit('log', { session: label, event: msg.type, payload: msg });
      });

      ws.once('close', () => Object.values(this.wavWriters).forEach(w => w?.end()));
      ws.on('error', e => { this.emit('error', e); reject(e); });
    });
  }

  _createWavWriter(path) {
    const stream = fs.createWriteStream(path);
    const writer = new wav.Writer({ sampleRate: 24000, channels: 1, bitDepth: 16 });
    writer.pipe(stream);
    return writer;
  }
}

let orchestrator = null;
export function initOrchestrator() {
  if (!orchestrator) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    orchestrator = new ArenaOrchestrator(key);
  }
  return orchestrator;
}
