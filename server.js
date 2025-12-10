const express = require('express');
const http = require('http');
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

const PHONE_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 전화 비서입니다.

절대 규칙 (반드시 지켜야 함):
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 첫 마디부터 한국어로 시작하세요

당신의 역할:
- 오상열 대표님(CFP, 국제공인재무설계사)의 AI 개인비서
- 고객에게 전화를 걸어 상담 예약을 잡는 것이 목적

첫 인사 (반드시 이렇게):
"안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다."

대화 방식:
- 짧고 간결하게 1-2문장으로
- 친절하고 따뜻하게
- 고객이 응답하면 상담 예약 제안`;

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
    version: '4.3 - WebSocket 경로 수정',
    endpoints: ['/api/chat', '/api/call', '/api/call-status/:callSid', '/incoming-call', '/media-stream']
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

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log('📊 통화 상태 업데이트:', CallSid, CallStatus);
  callStatusMap.set(CallSid, CallStatus);
  res.sendStatus(200);
});

// Twilio 웹훅 - 전화 연결시
app.post('/incoming-call', (req, res) => {
  const customerName = req.query.customerName || '고객';
  console.log('📞 /incoming-call 웹훅 호출됨!');
  console.log('📞 전화 연결됨! 고객:', customerName);
  
  // WebSocket URL을 명확하게 지정
  const wsUrl = `wss://ark-genie-server.onrender.com/media-stream?customerName=${encodeURIComponent(customerName)}`;
  console.log('📡 WebSocket URL:', wsUrl);
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// HTTP 서버 생성
const PORT = process.env.PORT || 10000;
const server = http.createServer(app);

// WebSocket 서버 - 경로별 처리
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = req.url || '';
  console.log('🔌 WebSocket 연결됨!', url);
  
  // 경로 파싱
  const isMediaStream = url.includes('/media-stream') || url.includes('media-stream');
  const isApp = url.includes('mode=app');
  
  const urlParams = new URLSearchParams(url.split('?')[1] || '');
  const customerName = decodeURIComponent(urlParams.get('customerName') || '고객');
  
  if (isMediaStream) {
    console.log('📞 Twilio Media Stream 연결! 고객:', customerName);
    handleTwilioConnection(ws, customerName);
  } else if (isApp) {
    console.log('📱 앱 연결! 고객:', customerName);
    handleAppConnection(ws);
  } else {
    console.log('❓ 알 수 없는 연결:', url);
    // 기본적으로 앱 연결로 처리
    handleAppConnection(ws);
  }
});

// Twilio 전화 연결 처리
function handleTwilioConnection(ws, customerName) {
  let openaiWs = null;
  let streamSid = null;
  let lastAssistantItem = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('📞 Twilio Stream 시작:', streamSid);
        
        // OpenAI Realtime API 연결
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        openaiWs.on('open', () => {
          console.log('✅ OpenAI Realtime API 연결됨! 모드: 전화');
          
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: PHONE_PROMPT,
              voice: 'shimmer',
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              input_audio_transcription: { model: 'whisper-1', language: 'ko' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 800
              }
            }
          }));

          // 첫 인사 요청
          setTimeout(() => {
            console.log('🎤 첫 인사 요청');
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{
                  type: 'input_text',
                  text: '한국어로 인사해주세요. "안녕하세요! 저는 오원트금융연구소 AI비서 지니입니다. 반갑습니다." 라고 말해주세요.'
                }]
              }
            }));
            
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }, 500);
        });

        openaiWs.on('message', (data) => {
          try {
            const event = JSON.parse(data.toString());

            if (event.type === 'response.audio.delta' && event.delta) {
              ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: event.delta }
              }));
            }

            if (event.type === 'response.output_item.added') {
              lastAssistantItem = event.item.id;
            }

            if (event.type === 'input_audio_buffer.speech_started') {
              console.log('🎤 고객 말하기 시작');
              if (lastAssistantItem) {
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.truncate',
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms: 0
                }));
              }
              ws.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
            }

            if (event.type === 'response.audio_transcript.done') {
              console.log('🤖 지니:', event.transcript);
            }

            if (event.type === 'conversation.item.input_audio_transcription.completed') {
              console.log('👤 고객:', event.transcript);
            }

          } catch (e) {
            console.error('OpenAI 메시지 에러:', e);
          }
        });

        openaiWs.on('error', (err) => {
          console.error('❌ OpenAI 에러:', err.message);
        });
        
        openaiWs.on('close', () => {
          console.log('🔌 OpenAI 연결 종료 (전화)');
        });
      }
      
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      if (msg.event === 'stop') {
        console.log('📞 Twilio Stream 종료');
        if (openaiWs) openaiWs.close();
      }

    } catch (e) {
      console.error('Twilio 메시지 에러:', e);
    }
  });

  ws.on('close', () => {
    console.log('📞 Twilio WebSocket 종료');
    if (openaiWs) openaiWs.close();
  });
}

// 앱 연결 처리
function handleAppConnection(ws) {
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
}

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('🚀 AI지니 서버 시작!');
  console.log(`📍 포트: ${PORT}`);
  console.log('📡 버전: 4.3 - WebSocket 경로 수정');
  console.log('='.repeat(50));
  console.log('✅ 서버 초기화 완료!');
});
