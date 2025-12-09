const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 비서입니다.

[필수 규칙]
1. 반드시 한국어로만 대화하세요
2. 항상 "네, 대표님!"으로 응답을 시작하세요
3. 짧고 친근하게 대화하세요 (1-2문장)
4. 대표님이 말씀하실 때까지 기다리세요
5. 먼저 말하지 마세요
6. 질문에만 대답하세요

[역할]
- 오상열 대표님의 개인 AI 비서
- 전화 연결, 일정 관리, 기록 등 업무 보조

[언어]
- 한국어만 사용
- 영어로 절대 대답하지 마세요`;

app.get('/', (req, res) => {
  res.send('AI지니 서버 실행 중!');
});

app.get('/make-call', async (req, res) => {
  const to = req.query.to;
  if (!to) {
    return res.json({ success: false, error: '전화번호가 필요합니다' });
  }
  
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/incoming-call`,
      to: to,
      from: TWILIO_NUMBER
    });
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/incoming-call', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log(`AI지니 서버 시작! (포트 ${PORT})`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('클라이언트 연결됨');
  
  let openaiWs = null;

  const connectOpenAI = () => {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('OpenAI 연결됨');
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
            language: 'ko'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 1000
          }
        }
      }));

      ws.send(JSON.stringify({ type: 'connected' }));
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('사용자:', event.transcript);
          ws.send(JSON.stringify({
            type: 'transcript',
            text: event.transcript,
            role: 'user'
          }));
        }

        if (event.type === 'response.audio_transcript.done') {
          console.log('지니:', event.transcript);
          ws.send(JSON.stringify({
            type: 'transcript',
            text: event.transcript,
            role: 'assistant'
          }));
        }

        if (event.type === 'response.audio.delta' && event.delta) {
          ws.send(JSON.stringify({
            type: 'audio',
            data: event.delta
          }));
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('사용자 말하기 시작');
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        }

      } catch (e) {
        console.error('OpenAI 메시지 파싱 에러:', e);
      }
    });

    openaiWs.on('error', (err) => console.error('OpenAI 에러:', err.message));
    openaiWs.on('close', () => console.log('OpenAI 연결 종료'));
  };

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.type === 'start') {
        console.log('음성 세션 시작');
        connectOpenAI();
      }

      if (msg.type === 'audio' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.data
        }));
      }

      if (msg.event === 'start') {
        console.log('Twilio 스트림 시작');
        connectOpenAI();
      }
      
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

    } catch (e) {
      console.error('메시지 처리 에러:', e);
    }
  });

  ws.on('close', () => {
    console.log('클라이언트 연결 종료');
    if (openaiWs) openaiWs.close();
  });
});

console.log('서버 준비 완료');
