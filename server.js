const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `[신원]
- 이름: 지니
- 소속: 오원트금융연구소
- 역할: 오상열 대표님(CFP, 국제공인재무설계사)의 AI 개인비서
- 성격: 친절하고 따뜻하며 전문적인 성숙한 여성

[통화 규칙]
1. 항상 한국어로 답변
2. 짧고 간결하게 (1-2문장)
3. 상대방 말을 끝까지 듣고 응답
4. 상담 예약 요청시 이름, 연락처, 희망 일시 확인
5. 자연스럽고 따뜻한 대화 유지

[첫 인사]
"안녕하세요! 오원트금융연구소 오상열 대표님의 AI비서 지니입니다. 무엇을 도와드릴까요?"`;

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ 
    status: 'AI지니 서버 실행 중!',
    version: '3.0 - OpenAI Realtime API',
    endpoints: ['/make-call', '/incoming-call', '/api/chat']
  });
});

// GPT 채팅 API (텍스트용)
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '네, 알겠습니다!';
    
    res.json({ reply });
  } catch (error) {
    console.error('Chat error:', error);
    res.json({ reply: '네, 알겠습니다! 무엇을 도와드릴까요?' });
  }
});

// 전화 발신 API
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

// POST 방식 전화 발신
app.post('/api/call', async (req, res) => {
  const { to, customerName } = req.body;
  if (!to) {
    return res.json({ success: false, error: '전화번호가 필요합니다' });
  }
  
  let phoneNumber = to.replace(/[-\s]/g, '');
  if (phoneNumber.startsWith('010')) {
    phoneNumber = '+82' + phoneNumber.slice(1);
  }
  
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/incoming-call`,
      to: phoneNumber,
      from: TWILIO_NUMBER
    });
    console.log('전화 발신:', call.sid, '고객:', customerName);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio 웹훅 - 전화 연결시 WebSocket으로 연결
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
  console.log('OpenAI Realtime API 연동 준비 완료');
});

// WebSocket 서버 (Twilio Media Stream + OpenAI Realtime API)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('WebSocket 연결됨!', req.url);
  
  let openaiWs = null;
  let streamSid = null;
  let lastAssistantItem = null;

  // OpenAI Realtime API 연결
  const connectOpenAI = (isPhone = false) => {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('OpenAI Realtime API 연결됨!');
      
      // 세션 설정
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'shimmer', // 성숙한 여성 음성
          input_audio_format: isPhone ? 'g711_ulaw' : 'pcm16',
          output_audio_format: isPhone ? 'g711_ulaw' : 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          }
        }
      }));

      // 첫 인사 (전화일 경우)
      if (isPhone) {
        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: '첫 인사를 해주세요: "안녕하세요! 오원트금융연구소 오상열 대표님의 AI비서 지니입니다. 무엇을 도와드릴까요?"'
            }
          }));
        }, 500);
      }
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        // 음성 응답 전송
        if (event.type === 'response.audio.delta' && event.delta) {
          if (streamSid) {
            // Twilio 전화로 전송
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta }
            }));
          } else {
            // 웹 클라이언트로 전송
            ws.send(JSON.stringify({
              type: 'audio',
              data: event.delta
            }));
          }
        }

        // 응답 아이템 추적 (Barge-in용)
        if (event.type === 'response.output_item.added') {
          lastAssistantItem = event.item.id;
        }

        // 사용자 말하기 시작 - AI 중단 (Barge-in)
        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('사용자 말하기 시작 - AI 중단');
          if (lastAssistantItem) {
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.truncate',
              item_id: lastAssistantItem,
              content_index: 0,
              audio_end_ms: 0
            }));
          }
          if (streamSid) {
            ws.send(JSON.stringify({
              event: 'clear',
              streamSid: streamSid
            }));
          }
        }

        // 지니 응답 텍스트 로그
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

      } catch (e) {
        console.error('OpenAI 메시지 파싱 에러:', e);
      }
    });

    openaiWs.on('error', (err) => console.error('OpenAI 에러:', err.message));
    openaiWs.on('close', () => console.log('OpenAI 연결 종료'));
  };

  // 클라이언트 메시지 처리
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      // Twilio Media Stream 시작
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('Twilio Stream 시작:', streamSid);
        connectOpenAI(true); // 전화 모드
      }
      
      // Twilio 오디오 데이터
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      // 웹 클라이언트 시작 요청
      if (msg.type === 'start') {
        connectOpenAI(false); // 웹 모드
      }

      // 웹 클라이언트 오디오 데이터
      if (msg.type === 'audio' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.data
        }));
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

console.log('서버 준비 완료!');
