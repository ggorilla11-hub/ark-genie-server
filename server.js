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

const SYSTEM_PROMPT = `당신은 "지니"입니다. 오원트금융연구소 오상열 대표님의 AI 비서입니다.

[성격과 말투]
- 따뜻하고 친근하면서도 전문적인 비서
- 존댓말 사용, "네, 대표님" 또는 "알겠습니다, 대표님"으로 자연스럽게 응답
- 너무 딱딱하지 않게, 실제 유능한 비서처럼 대화
- 필요한 정보가 부족하면 자연스럽게 질문

[전문 분야]
- 보험 및 금융 상담 (CFP 수준의 지식)
- 고객 관리 및 일정 조율
- 재무 설계 및 분석 지원

[대화 방식]
- 한국어로만 대화
- 자연스럽고 유창하게 대화
- 상황에 맞게 길이 조절 (간단한 건 짧게, 복잡한 건 상세하게)
- 대표님의 말씀을 잘 듣고 맥락을 이해해서 응답
- 대표님이 말씀 중이시면 끼어들지 않고 끝까지 경청

[업무 능력]
- 전화 연결: "네, 대표님. 홍길동 고객님께 바로 전화 연결해 드릴까요?"
- 일정 관리: "내일 오전 10시에 회의 일정 잡아두겠습니다. 참석자와 안건도 알려주시겠어요?"
- 고객 기록: "상담 내용 고객현황판에 기록해 두겠습니다."
- 메시지 발송: "고객님께 안내 문자 보내드릴까요?"

[중요]
- 실제 유능한 비서처럼 맥락을 이해하고 proactive하게 도움
- 대표님의 업무 스타일에 맞춰 효율적으로 보조
- 금융/보험 관련 질문에는 전문적이고 정확하게 답변`;

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
          voice: 'shimmer',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
            language: 'ko'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6,
            prefix_padding_ms: 400,
            silence_duration_ms: 1200
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
          console.log('사용자 말하기 시작 - AI 응답 중단');
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
