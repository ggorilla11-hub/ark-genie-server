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

const SYSTEM_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 개인비서입니다.
- 오상열 대표님의 AI 비서
- 항상 "네, 대표님!"으로 응답 시작
- 짧고 친근하게 대화
- 전화, 일정, 기록 등 명령 수행`;

// 기본 라우트
app.get('/', (req, res) => {
  res.send('AI지니 서버 실행 중!');
});

// 전화 발신
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
    console.log('전화 발신:', call.sid);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio 웹훅
app.post('/incoming-call', (req, res) => {
  console.log('전화 연결됨!');
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

// WebSocket 서버
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('WebSocket 연결됨!');
  
  let openaiWs = null;
  let streamSid = null;

  // OpenAI Realtime API 연결
  const connectOpenAI = () => {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('OpenAI Realtime API 연결됨!');
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }));
    });

    openaiWs.on('message', (data) => {
      const event = JSON.parse(data.toString());
      
      // 음성 응답을 클라이언트로 전송
      if (event.type === 'response.audio.delta' && event.delta) {
        ws.send(JSON.stringify({
          type: 'audio',
          data: event.delta
        }));
      }
      
      // 텍스트 응답
      if (event.type === 'response.audio_transcript.done') {
        console.log('지니:', event.transcript);
        ws.send(JSON.stringify({
          type: 'transcript',
          text: event.transcript,
          role: 'assistant'
        }));
      }

      // 사용자 음성 인식 결과
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        console.log('사용자:', event.transcript);
        ws.send(JSON.stringify({
          type: 'transcript',
          text: event.transcript,
          role: 'user'
        }));
      }

      // Barge-in (사용자가 말하면 AI 중단)
      if (event.type === 'input_audio_buffer.speech_started') {
        console.log('사용자 말하기 시작 - AI 중단');
      }
    });

    openaiWs.on('error', (err) => console.error('OpenAI 에러:', err.message));
    openaiWs.on('close', () => console.log('OpenAI 연결 종료'));
  };

  // 클라이언트 메시지 처리
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      // Twilio Media Stream
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('Twilio Stream 시작:', streamSid);
        connectOpenAI();
      }
      
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      // 웹 클라이언트 오디오
      if (msg.type === 'audio' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.data
        }));
      }

      // 연결 시작 요청
      if (msg.type === 'start') {
        connectOpenAI();
      }

    } catch (e) {
      console.error('메시지 파싱 에러:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket 연결 종료');
    if (openaiWs) openaiWs.close();
  });
});

console.log('서버 초기화 완료!');
