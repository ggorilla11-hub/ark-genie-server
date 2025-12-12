// ============================================
// ARK-Genie Server v6.1
// 전화지니 프롬프트 개선 (경청, 복명복창)
// VAD 설정은 원본 유지 (0.5, 300, 800)
// ============================================

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

// ============================================
// 환경변수
// ============================================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERVER_DOMAIN = process.env.SERVER_DOMAIN || 'ark-genie-server.onrender.com';

const callStatusMap = new Map();
const callContextMap = new Map(); // 전화 컨텍스트 저장 (고객명, 목적 등)

// ============================================
// 프롬프트 정의
// ============================================

// 앱지니 프롬프트 (기존 유지)
const APP_PROMPT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서입니다.

절대 규칙:
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 짧고 간결하게 1-2문장으로 답하세요

명령 처리:
- "지니야" 호출: "네, 대표님!"
- 전화 요청: "네, [이름]님께 전화합니다."`;

// 🆕 전화지니 프롬프트 v2.0 - 경청 + 복명복창 강화
const PHONE_GENIE_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 전화비서입니다.

## 🚨 최우선 규칙: 경청하기
1. 고객이 말할 때 절대 끊지 마세요
2. 고객이 말을 마칠 때까지 기다리세요
3. 고객 말이 끝나면 잠시 멈추고 응답하세요
4. 절대로 고객의 말 위에 덮어서 말하지 마세요

## 🔄 복명복창 필수
고객이 무언가 말하면, 반드시 다음 순서를 지키세요:
1. "네, 알겠습니다" (수긍)
2. "[고객이 말한 내용]이시군요" (복창)
3. "맞으실까요?" 또는 "제가 맞게 이해했을까요?" (확인)
4. 고객이 "네" 하면 그때서야 다음 단계로 진행

예시:
- 고객: "목요일 오후 3시 어때요?"
- 지니: "네, 알겠습니다. 목요일 오후 3시를 말씀하시는 거죠? 맞으실까요?"
- 고객: "네"
- 지니: "좋습니다. 그럼 목요일 오후 3시로 예약 도와드리겠습니다."

## ❌ 절대 하지 말 것
1. 고객이 말하기 전에 시간을 먼저 제안하지 마세요
2. 고객이 확인하기 전에 예약을 확정짓지 마세요
3. "그럼 5시로 할까요?", "4시는 어떠세요?" 같이 먼저 시간을 정하지 마세요
4. 고객 말을 중간에 끊지 마세요

## ✅ 올바른 대화 흐름
1. 인사: "안녕하세요, {{CUSTOMER_NAME}}님! 저는 오원트금융연구소 AI비서 지니입니다."
2. 목적: "{{CALL_PURPOSE}}으로 연락드렸습니다."
3. 질문: "혹시 편하신 시간이 있으실까요?" (여기서 멈추고 기다림)
4. 경청: (고객 말 끝까지 듣기)
5. 복창: "네, [고객 말] 말씀이시군요. 맞으실까요?"
6. 확인: (고객 "네" 기다림)
7. 진행: "좋습니다. 그렇게 진행하겠습니다."
8. 마무리: "{{CUSTOMER_NAME}}님, 감사합니다. 좋은 하루 되세요!"

## 상황별 대응
- 고객이 바쁘다: "네, 알겠습니다. 언제 다시 연락드리면 될까요?" (시간 물어보기)
- 고객이 거절: "네, 알겠습니다. 필요하시면 언제든 연락주세요. 좋은 하루 되세요!"
- 고객이 질문: 답변 후 "더 궁금하신 점 있으실까요?"

## 통화 종료
대화가 자연스럽게 마무리되면:
1. "감사합니다, {{CUSTOMER_NAME}}님. 좋은 하루 되세요!"
2. 고객이 "네" 또는 "감사합니다" 하면 조용히 대기

## 현재 통화 정보
고객명: {{CUSTOMER_NAME}}
전화 목적: {{CALL_PURPOSE}}
`;

// ============================================
// 기존 엔드포인트 (v5.0 그대로 유지)
// ============================================

app.get('/', (req, res) => {
  res.json({
    status: 'AI지니 서버 실행 중!',
    version: '6.1 - 전화지니 프롬프트 개선 (경청, 복명복창)',
    endpoints: {
      existing: ['/api/chat', '/api/call', '/api/call-status/:callSid', '/incoming-call'],
      new: ['/api/call-realtime', '/media-stream']
    }
  });
});

// 기존 텍스트 채팅 (유지)
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.json({ reply: '네, 대표님!' });

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
        max_tokens: 200
      })
    });

    const data = await response.json();
    res.json({ reply: data.choices?.[0]?.message?.content || '네, 대표님!' });
  } catch (error) {
    res.json({ reply: '네, 대표님!' });
  }
});

// 기존 전화 발신 - TTS 방식 (백업용으로 유지)
app.post('/api/call', async (req, res) => {
  const { to, customerName } = req.body;
  console.log('📞 [기존방식] /api/call 요청:', customerName, to);

  if (!to) return res.json({ success: false, error: '전화번호가 필요합니다' });

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
      url: `https://${SERVER_DOMAIN}/incoming-call?customerName=${encodeURIComponent(customerName || '고객')}`,
      to: phoneNumber,
      from: TWILIO_NUMBER,
      statusCallback: `https://${SERVER_DOMAIN}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    console.log('✅ [기존방식] 전화 발신 성공:', call.sid);
    callStatusMap.set(call.sid, 'ringing');
    res.json({ success: true, callSid: call.sid, mode: 'legacy-tts' });
  } catch (error) {
    console.error('❌ 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// 기존 통화 상태 조회 (유지)
app.get('/api/call-status/:callSid', (req, res) => {
  const { callSid } = req.params;
  const status = callStatusMap.get(callSid) || 'unknown';
  res.json({ callSid, status });
});

// 기존 통화 상태 콜백 (유지)
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log('📊 통화 상태 업데이트:', CallSid, CallStatus);
  callStatusMap.set(CallSid, CallStatus);
  res.sendStatus(200);
});

// 기존 TTS 방식 incoming-call (백업용 유지)
app.post('/incoming-call', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  console.log('📞 [기존방식] 전화 연결됨! 고객:', customerName);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 오상열 대표님께서 ${customerName}님과 상담 일정을 잡고 싶다고 하셔서 연락드렸습니다. 편하신 시간이 있으실까요?</Say>
  <Gather input="speech" language="ko-KR" timeout="5" action="/handle-response?customerName=${encodeURIComponent(customerName)}" method="POST">
    <Say voice="Google.ko-KR-Standard-A" language="ko-KR">말씀해 주세요.</Say>
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">응답이 없으시네요. 나중에 다시 연락드리겠습니다. 좋은 하루 되세요!</Say>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// 기존 TTS 방식 handle-response (백업용 유지)
app.post('/handle-response', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  const speechResult = req.body.SpeechResult || '';
  console.log('👤 [기존방식] 고객 응답:', speechResult);

  let gptReply = '네, 알겠습니다. 오상열 대표님께 전달드리겠습니다. 좋은 하루 되세요!';

  try {
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
            content: `당신은 오원트금융연구소의 AI 전화비서 지니입니다.
고객과 상담 일정을 잡는 중입니다.
고객 이름: ${customerName}

- 반드시 한국어로만 답하세요
- 짧고 친절하게 1-2문장으로 답하세요
- 고객이 시간을 말하면 확인하고 감사인사
- 고객이 거절하면 공손히 마무리`
          },
          { role: 'user', content: speechResult }
        ],
        max_tokens: 100
      })
    });

    const data = await response.json();
    gptReply = data.choices?.[0]?.message?.content || gptReply;
    console.log('🤖 [기존방식] 지니 응답:', gptReply);
  } catch (error) {
    console.error('GPT 에러:', error);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">${gptReply}</Say>
  <Gather input="speech" language="ko-KR" timeout="5" action="/handle-response?customerName=${encodeURIComponent(customerName)}" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">네, 감사합니다. 좋은 하루 되세요!</Say>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// ============================================
// 🆕 새로운 전화지니 (Realtime API 방식)
// ============================================

// 새 전화 발신 엔드포인트 (Realtime API 사용)
app.post('/api/call-realtime', async (req, res) => {
  const { to, customerName, purpose } = req.body;
  console.log('📞 [Realtime] /api/call-realtime 요청:', customerName, to, purpose);

  if (!to) return res.json({ success: false, error: '전화번호가 필요합니다' });

  let phoneNumber = to.replace(/[-\s]/g, '');
  if (phoneNumber.startsWith('010')) {
    phoneNumber = '+82' + phoneNumber.slice(1);
  }
  if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+82' + phoneNumber;
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  try {
    // 전화 컨텍스트 저장 (나중에 WebSocket에서 사용)
    const callContext = {
      customerName: customerName || '고객',
      purpose: purpose || '상담 일정 예약',
      startTime: new Date().toISOString()
    };

    const call = await client.calls.create({
      url: `https://${SERVER_DOMAIN}/incoming-call-realtime?customerName=${encodeURIComponent(customerName || '고객')}&purpose=${encodeURIComponent(purpose || '상담 일정 예약')}`,
      to: phoneNumber,
      from: TWILIO_NUMBER,
      statusCallback: `https://${SERVER_DOMAIN}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    console.log('✅ [Realtime] 전화 발신 성공:', call.sid);
    callStatusMap.set(call.sid, 'ringing');
    callContextMap.set(call.sid, callContext);

    res.json({ success: true, callSid: call.sid, mode: 'realtime-api' });
  } catch (error) {
    console.error('❌ [Realtime] 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// 🆕 Realtime API용 incoming-call (Media Stream 연결)
app.post('/incoming-call-realtime', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  const purpose = req.query.purpose || '상담 일정 예약';
  console.log('📞 [Realtime] 전화 연결됨! 고객:', customerName, '목적:', purpose);

  // TwiML: Media Stream으로 연결
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">잠시만 기다려주세요. AI 비서 지니가 연결됩니다.</Say>
  <Connect>
    <Stream url="wss://${SERVER_DOMAIN}/media-stream?customerName=${encodeURIComponent(customerName)}&amp;purpose=${encodeURIComponent(purpose)}" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// ============================================
// 서버 시작 및 WebSocket 설정
// ============================================

const PORT = process.env.PORT || 10000;

const server = app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('🚀 AI지니 서버 시작!');
  console.log(`📍 포트: ${PORT}`);
  console.log('📡 버전: 6.1 - 전화지니 프롬프트 개선 (경청, 복명복창)');
  console.log('='.repeat(50));
});

// ============================================
// WebSocket 서버 설정
// ============================================

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `https://${SERVER_DOMAIN}`);
  const pathname = url.pathname;

  console.log('🔌 WebSocket 연결됨! 경로:', pathname);

  // ============================================
  // 🆕 전화지니용 Media Stream (Twilio ↔ OpenAI)
  // ============================================
  if (pathname === '/media-stream') {
    const customerName = url.searchParams.get('customerName') || '고객';
    const purpose = url.searchParams.get('purpose') || '상담 일정 예약';

    console.log('📞 [Realtime] Media Stream 시작 - 고객:', customerName, '목적:', purpose);

    let openaiWs = null;
    let streamSid = null;

    // 프롬프트에 고객 정보 삽입
    const phonePrompt = PHONE_GENIE_PROMPT
      .replace('{{CUSTOMER_NAME}}', customerName)
      .replace('{{CALL_PURPOSE}}', purpose);

    // OpenAI Realtime API 연결
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('✅ [Realtime] OpenAI 연결됨! 고객:', customerName);

      // 세션 설정
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: phonePrompt,
          voice: 'shimmer', // 여성 음성
          input_audio_format: 'g711_ulaw', // Twilio 형식
          output_audio_format: 'g711_ulaw', // Twilio 형식
          input_audio_transcription: { model: 'whisper-1', language: 'ko' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800 // 대화 자연스럽게
          }
        }
      }));

      // AI가 먼저 인사 (전화 발신이므로)
      setTimeout(() => {
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: `전화가 연결되었습니다. ${customerName}님께 인사하고 ${purpose}에 대해 이야기를 시작하세요.`
            }]
          }
        }));
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }, 500);
    });

    // OpenAI → Twilio (AI 응답을 고객에게 전달)
    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        // 오디오 델타 → Twilio로 전송
        if (event.type === 'response.audio.delta' && event.delta) {
          if (streamSid) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta }
            }));
          }
        }

        // 디버깅용 로그
        if (event.type === 'response.audio_transcript.done') {
          console.log('🤖 [Realtime] 지니:', event.transcript);
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('👤 [Realtime] 고객:', event.transcript);
        }
        if (event.type === 'error') {
          console.error('❌ [Realtime] OpenAI 에러:', event.error);
        }
      } catch (e) {
        console.error('OpenAI 메시지 파싱 에러:', e);
      }
    });

    openaiWs.on('error', (err) => {
      console.error('❌ [Realtime] OpenAI WebSocket 에러:', err.message);
    });

    openaiWs.on('close', () => {
      console.log('🔌 [Realtime] OpenAI 연결 종료');
    });

    // Twilio → OpenAI (고객 음성을 AI에게 전달)
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log('📞 [Realtime] Twilio Stream 시작:', streamSid);
            break;

          case 'media':
            // 고객 음성 → OpenAI로 전달
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              }));
            }
            break;

          case 'stop':
            console.log('📞 [Realtime] Twilio Stream 종료');
            if (openaiWs) openaiWs.close();
            break;
        }
      } catch (e) {
        console.error('Twilio 메시지 파싱 에러:', e);
      }
    });

    ws.on('close', () => {
      console.log('📞 [Realtime] 통화 종료');
      if (openaiWs) openaiWs.close();
    });

    return; // Media Stream 처리 완료
  }

  // ============================================
  // 기존 앱지니용 WebSocket (유지)
  // ============================================
  let openaiWs = null;
  let lastAssistantItem = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'start_app') {
        console.log('📱 앱 Realtime 시작');

        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        openaiWs.on('open', () => {
          console.log('✅ OpenAI Realtime API 연결됨! 모드: 앱');

          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: APP_PROMPT,
              voice: 'shimmer',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1', language: 'ko' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 1500
              }
            }
          }));

          ws.send(JSON.stringify({ type: 'session_started' }));
        });

        openaiWs.on('message', (data) => {
          try {
            const event = JSON.parse(data.toString());

            if (event.type === 'response.audio.delta' && event.delta) {
              ws.send(JSON.stringify({ type: 'audio', data: event.delta }));
            }

            if (event.type === 'response.output_item.added') {
              lastAssistantItem = event.item.id;
            }

            if (event.type === 'input_audio_buffer.speech_started') {
              if (lastAssistantItem) {
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.truncate',
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms: 0
                }));
              }
              ws.send(JSON.stringify({ type: 'interrupt' }));
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
            console.error('OpenAI 메시지 에러:', e);
          }
        });

        openaiWs.on('error', (err) => {
          console.error('❌ OpenAI 에러:', err.message);
          ws.send(JSON.stringify({ type: 'error', error: err.message }));
        });

        openaiWs.on('close', () => {
          console.log('🔌 OpenAI 연결 종료 (앱)');
        });
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
      console.error('앱 메시지 에러:', e);
    }
  });

  ws.on('close', () => {
    console.log('📱 앱 WebSocket 종료');
    if (openaiWs) openaiWs.close();
  });
});

console.log('✅ 서버 초기화 완료!');
