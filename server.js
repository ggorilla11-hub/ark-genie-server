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
    version: '5.2 - 전화지니 정중한 대화 + 충분한 대기',
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

// Twilio 웹훅 - 전화 연결시 (정중하고 천천히)
app.post('/incoming-call', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  console.log('📞 전화 연결됨! 고객:', customerName);
  
  // 첫 인사 - 천천히, 정중하게, 충분한 대기시간
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">
      안녕하세요, ${customerName}님. 저는 오원트금융연구소의 AI비서 지니입니다. 
      오상열 대표님께서 고객님과 상담 일정을 잡고 싶다고 하셔서 연락드렸습니다. 
      편하신 시간이 있으시면 말씀해 주세요. 천천히 생각하셔도 괜찮습니다.
    </prosody>
  </Say>
  <Gather input="speech" language="ko-KR" timeout="15" speechTimeout="3" action="/handle-response?customerName=${encodeURIComponent(customerName)}&turn=1" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">
      아직 생각 중이시면 천천히 말씀해 주세요. 기다리고 있겠습니다.
    </prosody>
  </Say>
  <Gather input="speech" language="ko-KR" timeout="15" speechTimeout="3" action="/handle-response?customerName=${encodeURIComponent(customerName)}&turn=2" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">
      ${customerName}님, 지금 통화가 어려우신 것 같습니다. 
      나중에 편하실 때 오상열 대표님께서 다시 연락드리도록 하겠습니다. 
      전화 받아주셔서 감사합니다. 좋은 하루 되세요.
    </prosody>
  </Say>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// 고객 응답 처리
app.post('/handle-response', async (req, res) => {
  const customerName = req.query.customerName || '고객';
  const turn = parseInt(req.query.turn) || 1;
  const speechResult = req.body.SpeechResult || '';
  console.log('👤 고객 응답 (턴', turn, '):', speechResult);
  
  // GPT로 응답 생성
  let gptReply = '네, 알겠습니다. 오상열 대표님께 전달드리겠습니다. 감사합니다.';
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

당신의 성격:
- 매우 정중하고 예의 바름
- 차분하고 따뜻한 말투
- 고객을 존중하고 배려함
- 절대 서두르지 않음

규칙:
- 반드시 한국어로만 답하세요
- 정중하고 따뜻하게 2-3문장으로 답하세요
- 고객님이라고 호칭하세요
- 고객이 시간을 말하면 확인하고 정중히 감사인사
- 고객이 거절하면 "전혀 괜찮습니다"라고 하고 공손히 마무리
- 고객이 바쁘다고 하면 이해한다고 하고 나중에 연락드리겠다고 함

마무리 인사 (대화가 끝날 때):
"${customerName}님, 소중한 시간 내주셔서 정말 감사합니다. 좋은 하루 되세요. [END]"

응답 형식:
[END]가 포함되면 대화 종료 신호입니다.`
          },
          { role: 'user', content: speechResult }
        ],
        max_tokens: 150
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
    gptReply = `${customerName}님, 소중한 시간 내주셔서 감사합니다. 오상열 대표님께서 다시 연락드리겠습니다. 좋은 하루 되세요.`;
  }
  
  let twiml;
  
  if (shouldEnd) {
    // 대화 종료 - 정중히 인사 후 3초 대기 후 끊기
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">${gptReply}</prosody>
  </Say>
  <Pause length="3"/>
  <Hangup/>
</Response>`;
  } else {
    // 대화 계속 - 충분한 대기시간
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">${gptReply}</prosody>
  </Say>
  <Gather input="speech" language="ko-KR" timeout="15" speechTimeout="3" action="/handle-response?customerName=${encodeURIComponent(customerName)}&turn=${turn + 1}" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">
      ${customerName}님, 더 필요하신 말씀이 있으시면 편하게 말씀해 주세요.
    </prosody>
  </Say>
  <Gather input="speech" language="ko-KR" timeout="10" speechTimeout="3" action="/handle-response?customerName=${encodeURIComponent(customerName)}&turn=${turn + 1}" method="POST">
  </Gather>
  <Say voice="Google.ko-KR-Standard-A" language="ko-KR">
    <prosody rate="slow">
      ${customerName}님, 소중한 시간 내주셔서 정말 감사합니다. 
      오상열 대표님께서 확인 후 다시 연락드리겠습니다. 
      좋은 하루 되세요.
    </prosody>
  </Say>
  <Pause length="2"/>
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
  console.log('📡 버전: 5.2 - 전화지니 정중한 대화 + 충분한 대기');
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
