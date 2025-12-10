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

// 통화 상태 저장
const callStatusMap = new Map();

// 전화 지니용 프롬프트 (고객과 통화) - 한국어 강화
const PHONE_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 전화 비서입니다.

중요 규칙:
1. 반드시 한국어로만 말하세요. 절대 영어를 사용하지 마세요.
2. 친절하고 따뜻한 성숙한 여성 목소리로 말하세요.
3. 짧고 간결하게 1-2문장으로 말하세요.

당신의 역할:
- 오상열 대표님(CFP, 국제공인재무설계사)의 AI 개인비서입니다.
- 고객에게 전화를 걸어 상담 예약을 잡는 것이 목적입니다.

대화 시나리오:
1. 첫 인사: "안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 반갑습니다."
2. 고객이 응답하면: "다름이 아니라 오상열 대표님께서 고객님과 상담 약속을 잡고 싶다고 하셔서 전화드렸습니다. 혹시 시간 괜찮으실까요?"
3. 고객이 긍정하면: "네, 감사합니다! 편하신 날짜와 시간을 알려주시면 일정 잡아드리겠습니다."
4. 고객이 부정하면: "네, 알겠습니다. 다음에 다시 연락드리겠습니다."
5. 마무리: "네, 감사합니다. 좋은 하루 되세요!"

절대 하지 말아야 할 것:
- 영어로 말하기
- "무엇을 도와드릴까요?" 라고 묻기 (전화를 건 쪽이므로)
- 길게 말하기`;

// 앱 지니용 프롬프트 (설계사와 대화)
const APP_PROMPT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서입니다.

중요 규칙:
1. 반드시 한국어로만 말하세요. 절대 영어를 사용하지 마세요.
2. 친절하고 따뜻한 성숙한 여성 목소리로 말하세요.
3. 짧고 간결하게 1-2문장으로 말하세요.
4. 설계사님을 "대표님"이라고 호칭하세요.
5. 응답은 "네, 대표님!"으로 시작하세요.

명령 처리:
- "지니야" 호출: "네, 대표님!" 이라고만 짧게 대답
- 전화 요청: "네, [이름]님께 전화합니다." 라고 복명복창
- 일반 질문: 친절하고 간결하게 답변

절대 하지 말아야 할 것:
- 영어로 말하기
- 길게 말하기`;

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ 
    status: 'AI지니 서버 실행 중!',
    version: '4.2 - 전화지니 한국어 강화 + 통화상태 API',
    endpoints: ['/api/chat', '/api/call', '/api/call-status/:callSid', '/incoming-call']
  });
});

// GPT-4o 채팅 API (백업용)
app.post('/api/chat', async (req, res) => {
  console.log('📨 /api/chat 요청:', req.body.message);
  
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.json({ reply: '네, 대표님!' });
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
          { role: 'system', content: APP_PROMPT },
          { role: 'user', content: message }
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '네, 대표님!';
    
    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat API 에러:', error);
    res.json({ reply: '네, 대표님!' });
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
    callStatusMap.set(call.sid, 'ringing');
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
      url: `https://${req.headers.host}/incoming-call?customerName=${encodeURIComponent(customerName || '고객')}`,
      to: phoneNumber,
      from: TWILIO_NUMBER,
      statusCallback: `https://${req.headers.host}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'failed', 'busy', 'no-answer']
    });
    console.log('✅ 전화 발신 성공:', call.sid, '고객:', customerName);
    callStatusMap.set(call.sid, 'ringing');
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('❌ 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// 통화 상태 조회 API (앱에서 폴링용)
app.get('/api/call-status/:callSid', (req, res) => {
  const { callSid } = req.params;
  const status = callStatusMap.get(callSid) || 'unknown';
  console.log('📊 통화 상태 조회:', callSid, status);
  res.json({ callSid, status });
});

// 통화 상태 콜백 (Twilio에서 호출)
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log('📊 통화 상태 업데이트:', CallSid, CallStatus);
  callStatusMap.set(CallSid, CallStatus);
  
  // 종료된 통화는 5분 후 정리
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    setTimeout(() => {
      callStatusMap.delete(CallSid);
    }, 5 * 60 * 1000);
  }
  
  res.sendStatus(200);
});

// Twilio 웹훅 - 전화 연결시 WebSocket으로 연결
app.post('/incoming-call', (req, res) => {
  const customerName = req.query.customerName || '고객';
  console.log('📞 전화 연결됨! 고객:', customerName);
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream?customerName=${encodeURIComponent(customerName)}&mode=phone" />
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
  console.log('📡 버전: 4.2 - 전화지니 한국어 강화 + 통화상태 API');
  console.log('='.repeat(50));
});

// WebSocket 서버 (Twilio + 앱 공용)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket 연결됨!', req.url);
  
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const mode = urlParams.get('mode') || 'app';
  const customerName = decodeURIComponent(urlParams.get('customerName') || '고객');
  
  console.log('📱 모드:', mode, '/ 고객:', customerName);
  
  let openaiWs = null;
  let streamSid = null;
  let lastAssistantItem = null;

  const connectOpenAI = (isPhone = false) => {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('✅ OpenAI Realtime API 연결됨! 모드:', isPhone ? '전화' : '앱');
      
      const prompt = isPhone ? PHONE_PROMPT : APP_PROMPT;
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: prompt,
          voice: 'shimmer',
          input_audio_format: isPhone ? 'g711_ulaw' : 'pcm16',
          output_audio_format: isPhone ? 'g711_ulaw' : 'pcm16',
          input_audio_transcription: { 
            model: 'whisper-1',
            language: 'ko'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: isPhone ? 800 : 1500
          }
        }
      }));

      // 세션 시작 알림
      ws.send(JSON.stringify({ type: 'session_started' }));

      // 첫 인사 (전화일 때만)
      if (isPhone) {
        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: '한국어로 첫 인사를 해주세요: "안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 반갑습니다." 반드시 한국어로만 말하세요.'
            }
          }));
        }, 500);
      }
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'response.audio.delta' && event.delta) {
          if (isPhone && streamSid) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta }
            }));
          } else if (!isPhone) {
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
          if (isPhone && streamSid) {
            ws.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
          } else if (!isPhone) {
            ws.send(JSON.stringify({ type: 'interrupt' }));
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

        if (event.type === 'response.done') {
          ws.send(JSON.stringify({ type: 'response_done' }));
        }

        if (event.type === 'error') {
          console.error('❌ OpenAI 에러:', event.error);
          ws.send(JSON.stringify({ type: 'error', error: event.error }));
        }

      } catch (e) {
        console.error('OpenAI 메시지 파싱 에러:', e);
      }
    });

    openaiWs.on('error', (err) => {
      console.error('❌ OpenAI 연결 에러:', err.message);
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    });
    
    openaiWs.on('close', () => {
      console.log('🔌 OpenAI 연결 종료');
      ws.send(JSON.stringify({ type: 'openai_closed' }));
    });
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

      if (msg.type === 'start_app') {
        console.log('📱 앱 Realtime 시작');
        connectOpenAI(false);
      }

      if (msg.type === 'audio' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.data
        }));
      }

      if (msg.type === 'stop') {
        console.log('📱 앱 Realtime 종료');
        if (openaiWs) openaiWs.close();
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
