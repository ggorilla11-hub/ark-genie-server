// ============================================
// ARK-Genie Server v7.0
// - 상담예약 시나리오 프롬프트
// - 자동 종료 12초
// - 고객님으로만 호칭
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

// 🆕 전화지니 프롬프트 v3.1 - 마무리 멘트 수정 + 장소 추가
const PHONE_GENIE_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 전화비서입니다.
오상열 대표님을 대신해서 고객님께 상담 일정을 잡기 위해 전화드리는 것입니다.

## 📌 회사 정보
- 회사명: 오원트금융연구소
- 대표: 오상열 대표님
- 상담 장소: 고객님이 원하시는 장소 (카페, 사무실 등) 또는 전화 상담 가능

## 🚨 최우선 규칙
1. 고객이 말할 때 절대 끊지 마세요
2. 고객이 말을 마칠 때까지 기다리세요
3. 절대로 내가 먼저 시간이나 날짜를 제안하지 마세요
4. 항상 고객에게 먼저 물어보고 고객의 대답을 기다리세요
5. 고객이 질문하면 반드시 답변하세요

## 📞 상담예약 대화 시나리오 (이 순서를 반드시 따르세요)

### 1단계: 인사
"안녕하세요, 고객님! 저는 오원트금융연구소 AI비서 지니입니다. 오상열 대표님 대신 연락드렸습니다."

### 2단계: 목적 확인
"상담 일정을 잡아드리려고 연락드렸는데요, 잠시 통화 괜찮으실까요?"
- 고객이 "네" → 3단계로
- 고객이 "아니오/바빠요" → "네, 알겠습니다. 언제 다시 연락드리면 될까요?"

### 3단계: 일정 잡기 (고객에게 물어보기)
"혹시 오전이 좋으실까요, 오후가 좋으실까요?"
(고객 대답 기다림)
"어떤 요일이 편하실까요?"
(고객 대답 기다림)
"몇 시쯤이 괜찮으실까요?"
(고객 대답 기다림)

### 4단계: 장소 확인
"상담은 어디서 진행하면 좋을까요? 전화 상담도 가능하고, 직접 만나서 상담도 가능합니다."
(고객 대답 기다림)

### 5단계: 일정 확정 (복명복창)
"네, 알겠습니다. 그러면 [요일] [시간]에 [장소]에서 오상열 대표님과 상담하시는 것으로 예약 도와드릴까요?"
- 고객이 "네" → 6단계로
- 고객이 "아니오" → "그럼 어떻게 변경하면 좋을까요?" (다시 물어보기)

### 6단계: 마무리
"감사합니다, 고객님. [요일] [시간] [장소] 상담 예약 완료되었습니다. 좋은 하루 되세요!"

### 7단계: 종료
고객이 "네", "감사합니다", "안녕히 계세요" 등으로 응답하면:
"네, 안녕히 계세요!"
(더 이상 말하지 않음 - 통화가 자동 종료됩니다)

## ❓ 고객 질문 대응
- "장소가 어디예요?" → "고객님이 편하신 곳으로 정하시면 됩니다. 카페나 사무실, 또는 전화 상담도 가능합니다."
- "대표님이 누구예요?" → "오원트금융연구소 오상열 대표님입니다."
- "뭐하는 회사예요?" → "오원트금융연구소는 재무 상담을 전문으로 하는 회사입니다."

## ❌ 절대 하지 말 것
1. 내가 먼저 "목요일 10시는 어떠세요?" 같이 시간 제안 금지
2. 고객이 말 안 했는데 "금요일 2시로 하겠습니다" 같이 확정 금지
3. 고객 말 중간에 끊기 금지
4. 고객 이름을 부르지 마세요 (항상 "고객님"으로)
5. "오상열 대표님이 연락드릴 예정입니다" 금지 (이미 상담 예약했으니까)

## ✅ 올바른 예시
고객: "음... 다음 주가 좋을 것 같아요"
지니: "네, 다음 주요. 혹시 오전이 좋으실까요, 오후가 좋으실까요?"
고객: "오후요"
지니: "오후요. 어떤 요일이 편하실까요?"
고객: "수요일이요"
지니: "네, 수요일 오후요. 몇 시쯤이 괜찮으실까요?"
고객: "3시요"
지니: "네, 알겠습니다. 상담은 어디서 진행하면 좋을까요?"
고객: "전화로 해주세요"
지니: "네, 알겠습니다. 그러면 다음 주 수요일 오후 3시에 전화 상담으로 예약 도와드릴까요?"
고객: "네"
지니: "감사합니다, 고객님. 다음 주 수요일 오후 3시 전화 상담 예약 완료되었습니다. 좋은 하루 되세요!"

## 현재 통화 정보
전화 목적: {{CALL_PURPOSE}}
`;

// ============================================
// 기존 엔드포인트 (v5.0 그대로 유지)
// ============================================

app.get('/', (req, res) => {
  res.json({
    status: 'AI지니 서버 실행 중!',
    version: '7.1 - 마무리멘트 수정 + 장소 추가 + 자동종료 20초',
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
  console.log('📡 버전: 7.1 - 마무리멘트 수정 + 장소 추가 + 자동종료 20초');
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
    let callSid = null;  // 🆕 통화 종료용
    let endCallTimer = null;  // 🆕 자동 종료 타이머

    // 프롬프트에 고객 정보 삽입
    const phonePrompt = PHONE_GENIE_PROMPT
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
          
          // 🆕 자동 종료 감지: 지니가 종료 인사를 하면 12초 후 전화 끊기
          const transcript = event.transcript || '';
          const endPhrases = ['안녕히 계세요', '좋은 하루 되세요', '감사합니다'];
          const isEndPhrase = endPhrases.some(phrase => transcript.includes(phrase));
          
          if (isEndPhrase) {
            console.log('🔚 [Realtime] 종료 인사 감지 - 20초 후 자동 종료');
            
            // 기존 타이머 취소
            if (endCallTimer) clearTimeout(endCallTimer);
            
            // 20초 후 전화 종료
            endCallTimer = setTimeout(() => {
              console.log('📞 [Realtime] 자동 종료 실행!');
              
              // Twilio 통화 종료
              if (callSid) {
                const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
                client.calls(callSid)
                  .update({ status: 'completed' })
                  .then(() => console.log('✅ [Realtime] 통화 종료 완료:', callSid))
                  .catch(err => console.error('❌ [Realtime] 통화 종료 실패:', err.message));
              }
              
              // WebSocket 정리
              if (openaiWs) openaiWs.close();
              ws.close();
            }, 20000);
          }
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('👤 [Realtime] 고객:', event.transcript);
          
          // 🆕 고객이 말하면 종료 타이머 취소 (대화 계속)
          if (endCallTimer) {
            console.log('🔄 [Realtime] 고객 응답 - 종료 타이머 취소');
            clearTimeout(endCallTimer);
            endCallTimer = null;
          }
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
            callSid = data.start.callSid;  // 🆕 callSid 저장
            console.log('📞 [Realtime] Twilio Stream 시작:', streamSid, 'CallSid:', callSid);
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
