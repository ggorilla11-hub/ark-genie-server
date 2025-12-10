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
    version: '3.1 - GPT-4o + Realtime API',
    endpoints: ['/api/chat', '/api/call', '/make-call', '/incoming-call']
  });
});

// ⭐ GPT-4o 채팅 API (핵심!)
app.post('/api/chat', async (req, res) => {
  console.log('📨 /api/chat 요청:', req.body.message);
  
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.json({ reply: '메시지가 없습니다.' });
    }
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { 
            role: 'system', 
            content: `당신은 보험설계사의 AI비서 "지니"입니다. 
항상 친절하고 자연스럽게 한국어로 대화하세요.
"네, 대표님!" 또는 "네, 알겠습니다!" 로 응답을 시작하세요.` 
          },
          { role: 'user', content: message }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    console.log('🤖 GPT-4o 응답:', data.choices?.[0]?.message?.content);
    
    const reply = data.choices?.[0]?.message?.content || '네, 알겠습니다! 무엇을 도와드릴까요?';
    
    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat API 에러:', error);
    res.json({ reply: '네, 무엇을 도와드릴까요?' });
  }
});

// 전화 발신 API (GET)
app.get('/make-call', async (req, res) => {
  const to = req.query.to;
  console.log('📞 /make-call 요청:', to);
  
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
    console.log('✅ 전화 발신 성공:', call.sid);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('❌ 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// 전화 발신 API (POST)
app.post('/api/call', async (req, res) => {
  const { to, customerName } = req.body;
  console.log('📞 /api/call 요청:', customerName, to);
  
  if (!to) {
    return res.json({ success: false, error: '전화번호가 필요합니다' });
  }
  
  let phoneNumber = to.replace(/[-\s]/g, '');
  if (phoneNumber.startsWith('010')) {
    phoneNumber = '+82' + phoneNumber.slice(1);
  }
  if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+82' + phoneNumber;
  }
  
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/incoming-call`,
      to: phoneNumber,
      from: TWILIO_NUMBER
    });
    console.log('✅ 전화 발신 성공:', call.sid, '고객:', customerName);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('❌ 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio 웹훅 - 전화 연결시 WebSocket으로 연결
app.post('/incoming-call', (req, res) => {
  console.log('📞 전화 연결됨!');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

// 서버 시작
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('🚀 AI지니 서버 시작!');
  console.log(`📍 포트: ${PORT}`);
  console.log('📡 엔드포인트: /api/chat, /api/call, /make-call');
  console.log('='.repeat(50));
});

// WebSocket 서버 (Twilio Media Stream + OpenAI Realtime API)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket 연결됨!', req.url);
  
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
      console.log('✅ OpenAI Realtime API 연결됨!');
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'shimmer',
          input_audio_format: isPhone ? 'g711_ulaw' : 'pcm16',
          output_audio_format: isPhone ? 'g711_ulaw' : 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          }
        }
      }));

      if (isPhone) {
        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: '첫 인사를 해주세요: "안녕하세요! 오원트금융연구소 AI비서 지니입니다. 무엇을 도와드릴까요?"'
            }
          }));
        }, 500);
      }
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'response.audio.delta' && event.delta) {
          if (streamSid) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta }
            }));
          } else {
            ws.send(JSON.stringify({ type: 'audio', data: event.delta }));
          }
        }

        if (event.type === 'response.output_item.added') {
          lastAssistantItem = event.item.id;
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          console.log('🎤 사용자 말하기 시작 - AI 중단');
          if (lastAssistantItem) {
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.truncate',
              item_id: lastAssistantItem,
              content_index: 0,
              audio_end_ms: 0
            }));
          }
          if (streamSid) {
            ws.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
          }
        }

        if (event.type === 'response.audio_transcript.done') {
          console.log('🤖 지니:', event.transcript);
          ws.send(JSON.stringify({ type: 'transcript', text: event.transcript, role: 'assistant' }));
        }

        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('👤 사용자:', event.transcript);
          ws.send(JSON.stringify({ type: 'transcript', text: event.transcript, role: 'user' }));
        }

      } catch (e) {
        console.error('OpenAI 메시지 파싱 에러:', e);
      }
    });

    openaiWs.on('error', (err) => console.error('❌ OpenAI 에러:', err.message));
    openaiWs.on('close', () => console.log('🔌 OpenAI 연결 종료'));
  };

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('📞 Twilio Stream 시작:', streamSid);
        connectOpenAI(true);
      }
      
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      if (msg.type === 'start') {
        connectOpenAI(false);
      }

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
    console.log('🔌 WebSocket 연결 종료');
    if (openaiWs) openaiWs.close();
  });
});

console.log('✅ 서버 초기화 완료!');
