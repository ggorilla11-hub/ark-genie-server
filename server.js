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

const callStatusMap = new Map();

const APP_PROMPT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서입니다.

절대 규칙:
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 짧고 간결하게 1-2문장으로 답하세요

명령 처리:
- "지니야" 호출: "네, 대표님!"
- 전화 요청: "네, [이름]님께 전화합니다."`;

app.get('/', (req, res) => {
  res.json({ 
    status: 'AI지니 서버 실행 중!',
    version: '5.1 - 대화 속도 개선',
    endpoints: ['/api/chat', '/api/call', '/api/call-status/:callSid', '/api/end-call/:callSid', '/incoming-call']
  });
});

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

app.post('/api/call', async (req, res) => {
  const { to, customerName } = req.body;
  console.log('📞 /api/call 요청:', customerName, to);
  
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
      url: `https://ark-genie-server.onrender.com/incoming-call?customerName=${encodeURIComponent(customerName || '고객')}`,
      to: phoneNumber,
      from: TWILIO_NUMBER,
      statusCallback: `https://ark-genie-server.onrender.com/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
    console.log('✅ 전화 발신 성공:', call.sid, '고객:', customerName);
    callStatusMap.set(call.sid, 'ringing');
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('❌ 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/call-status/:callSid', (req, res) => {
  const { callSid } = req.params;
  const status = callStatusMap.get(callSid) || 'unknown';
  res.json({ callSid, status });
});

// 통화 강제 종료 API (앱에서 호출)
app.post('/api/end-call/:callSid', async (req, res) => {
  const { callSid } = req.params;
  console.log('📴 통화 종료 요청:', callSid);
  
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  try {
    await client.calls(callSid).update({ status: 'completed' });
    callStatusMap.set(callSid, 'completed');
    console.log('✅ 통화 종료 성공:', callSid);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ 통화 종료 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log('📊 통화 상태 업데이트:', CallSid, CallStatus);
  callStatusMap.set(CallSid, CallStatus);
  res.sendStatus(200);
});

// Twilio 웹훅 - 전화 연결시 (Twilio TTS 방식)
app.post('/incoming-call', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  console.log('📞 전화 연결됨! 고객:', customerName);
  
  // 첫 인사 TwiML (timeout 3초로 단축)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 오상열 대표님께서 ${customerName}님과 상담 일정을 잡고 싶다고 하셔서 연락드렸습니다. 편하신 시간이 있으실까요?</Say>
  <Gather input="speech" language="ko-KR" timeout="3" action="/handle-response?customerName=${encodeURIComponent(customerName)}" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">응답이 없으시네요. 나중에 다시 연락드리겠습니다. 좋은 하루 되세요!</Say>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// 고객 응답 처리
app.post('/handle-response', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  const speechResult = req.body.SpeechResult || '';
  console.log('👤 고객 응답:', speechResult);
  
  // GPT로 응답 생성
  let gptReply = '네, 알겠습니다. 오상열 대표님께 전달드리겠습니다. 감사합니다. 좋은 하루 되세요!';
  let shouldEnd = false;
  
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

규칙:
- 반드시 한국어로만 답하세요
- 짧고 친절하게 1-2문장으로 답하세요
- 고객이 시간을 말하면 확인하고 감사인사
- 고객이 거절하면 공손히 마무리
- 대화가 끝나면 "감사합니다. 좋은 하루 되세요!" 로 마무리

응답 형식:
[END]가 포함되면 대화 종료 신호입니다.
예: "네, 12월 17일 오후 2시로 예약하겠습니다. 감사합니다. 좋은 하루 되세요! [END]"
예: "네, 알겠습니다. 다음에 다시 연락드리겠습니다. 좋은 하루 되세요! [END]"`
          },
          { role: 'user', content: speechResult }
        ],
        max_tokens: 100
      })
    });
    
    const data = await response.json();
    gptReply = data.choices?.[0]?.message?.content || gptReply;
    
    // [END] 태그 확인
    if (gptReply.includes('[END]')) {
      shouldEnd = true;
      gptReply = gptReply.replace('[END]', '').trim();
    }
    
    console.log('🤖 지니 응답:', gptReply, shouldEnd ? '(종료)' : '');
  } catch (error) {
    console.error('GPT 에러:', error);
    shouldEnd = true;
  }
  
  let twiml;
  
  if (shouldEnd) {
    // 대화 종료 - 인사 후 3초 대기 후 끊기
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">${gptReply}</Say>
  <Pause length="2"/>
  <Hangup/>
</Response>`;
  } else {
    // 대화 계속 (timeout 3초로 단축)
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">${gptReply}</Say>
  <Gather input="speech" language="ko-KR" timeout="3" action="/handle-response?customerName=${encodeURIComponent(customerName)}" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">네, 감사합니다. 좋은 하루 되세요!</Say>
  <Hangup/>
</Response>`;
  }
  
  res.type('text/xml');
  res.send(twiml);
});

// 서버 시작
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('🚀 AI지니 서버 시작!');
  console.log(`📍 포트: ${PORT}`);
  console.log('📡 버전: 5.1 - 대화 속도 개선 + 자동 종료');
  console.log('='.repeat(50));
});

// WebSocket 서버 (앱지니 전용 - Realtime API)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket 연결됨! (앱)');
  
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
