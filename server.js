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

// 전화 지니용 프롬프트 (고객과 통화)
const PHONE_PROMPT = `[신원]
- 이름: 지니
- 소속: 오원트금융연구소
- 역할: 오상열 대표님(CFP, 국제공인재무설계사)의 AI 개인비서
- 성격: 친절하고 따뜻하며 전문적인 성숙한 여성

[통화 규칙]
1. 항상 한국어로 답변
2. 짧고 간결하게 (1-2문장)
3. 상대방 말을 끝까지 듣고 응답
4. 자연스럽고 따뜻한 대화 유지

[상담 예약 시나리오]
1단계 - 자기소개: "안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 반갑습니다."
2단계 - 고객 응답 대기
3단계 - 목적 전달: "다름이 아니라 오상열 대표님께서 고객님과 상담 약속을 잡고 싶다고 하셔서 전화드렸습니다. 혹시 시간 괜찮으실까요?"
4단계 - 고객 응답에 따라:
  - 긍정: "네, 감사합니다! 편하신 날짜와 시간을 알려주시면 일정 잡아드리겠습니다."
  - 부정: "네, 알겠습니다. 다음에 다시 연락드리겠습니다."
5단계 - 마무리: "네, 감사합니다. 좋은 하루 되세요!"

[중요]
- 첫 인사 후 바로 목적을 말하지 말고, 고객 응답을 기다릴 것
- "무엇을 도와드릴까요"라고 절대 묻지 말 것 (전화를 건 쪽이므로)
- 대화가 끝나면 "좋은 하루 되세요" 인사 후 종료

[첫 인사]
"안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 반갑습니다."`;

// 앱 지니용 프롬프트 (설계사와 대화)
const APP_PROMPT = `[신원]
- 이름: 지니
- 소속: 오원트금융연구소
- 역할: 보험설계사의 AI 개인비서
- 성격: 친절하고 따뜻하며 전문적인 성숙한 여성

[대화 규칙]
1. 항상 한국어로 답변
2. 짧고 간결하게 (1-2문장)
3. 상대방 말을 끝까지 듣고 응답
4. "네, 대표님!" 으로 응답 시작
5. 자연스럽고 따뜻한 대화 유지

[명령 처리]
- "지니야" 호출: "네, 대표님!" 이라고만 짧게 대답
- 전화 요청: "네, [이름]님께 전화합니다." 라고 복명복창
- 일반 질문: 친절하고 간결하게 답변

[중요]
- 설계사님을 "대표님"이라고 호칭
- 응답은 최대 2문장으로 짧게
- 전화번호, 이름이 언급되면 전화 명령으로 인식`;

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ 
    status: 'AI지니 서버 실행 중!',
    version: '4.0 - 앱 Realtime API 적용',
    endpoints: ['/api/chat', '/api/call', '/app-realtime', '/incoming-call']
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
      statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer']
    });
    console.log('✅ 전화 발신 성공:', call.sid, '고객:', customerName);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('❌ 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// 통화 상태 콜백
app.post('/call-status', (req, res) => {
  console.log('📊 통화 상태:', req.body.CallStatus, req.body.CallSid);
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
  console.log('📡 버전: 4.0 - 앱 Realtime API 적용');
  console.log('='.repeat(50));
});

// WebSocket 서버 (Twilio + 앱 공용)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket 연결됨!', req.url);
  
  // URL 파라미터 파싱
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const mode = urlParams.get('mode') || 'app';
  const customerName = decodeURIComponent(urlParams.get('customerName') || '고객');
  
  console.log('📱 모드:', mode, '/ 고객:', customerName);
  
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
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: isPhone ? 800 : 1500
          }
        }
      }));

      // 첫 인사
      if (isPhone) {
        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: '첫 인사를 해주세요: "안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 반갑습니다." 그리고 고객의 응답을 기다리세요.'
            }
          }));
        }, 500);
      }
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        // 오디오 전송
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

        // Barge-in: 사용자가 말하기 시작하면 AI 중단
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

        // 지니 응답 텍스트
        if (event.type === 'response.audio_transcript.done') {
          console.log('🤖 지니:', event.transcript);
          ws.send(JSON.stringify({ type: 'transcript', text: event.transcript, role: 'assistant' }));
        }

        // 사용자 음성 텍스트
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('👤 사용자:', event.transcript);
          ws.send(JSON.stringify({ type: 'transcript', text: event.transcript, role: 'user' }));
        }

        // 응답 완료
        if (event.type === 'response.done') {
          ws.send(JSON.stringify({ type: 'response_done' }));
        }

      } catch (e) {
        console.error('OpenAI 메시지 파싱 에러:', e);
      }
    });

    openaiWs.on('error', (err) => console.error('❌ OpenAI 에러:', err.message));
    openaiWs.on('close', () => {
      console.log('🔌 OpenAI 연결 종료');
      ws.send(JSON.stringify({ type: 'openai_closed' }));
    });
  };

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      // Twilio 전화 시작
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('📞 Twilio Stream 시작:', streamSid);
        connectOpenAI(true);
      }
      
      // Twilio 오디오
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      // 앱 시작
      if (msg.type === 'start_app') {
        console.log('📱 앱 Realtime 시작');
        connectOpenAI(false);
      }

      // 앱 오디오
      if (msg.type === 'audio' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.data
        }));
      }

      // 앱 종료
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
