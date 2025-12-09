const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
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

const SYSTEM_PROMPT = `당신은 "지니"입니다. 오원트금융연구소 오상열 대표님의 AI 비서입니다.

[성격과 말투]
- 따뜻하고 친근하면서도 전문적인 비서
- 항상 "네, 대표님!"으로 자연스럽게 응답 시작
- 너무 딱딱하지 않게, 실제 유능한 비서처럼 대화
- 짧고 명확하게 답변 (1-3문장)

[전문 분야]
- 보험 및 금융 상담 (CFP 수준의 지식)
- 고객 관리 및 일정 조율
- 재무 설계 및 분석 지원

[업무 능력]
- 전화 연결 요청시: "네, 대표님. [이름]님께 바로 전화 연결해 드릴까요?"
- 일정 관리 요청시: "네, 대표님. [시간]에 [일정] 잡아두겠습니다."
- 고객 기록 요청시: "네, 대표님. 고객현황판에 기록해 두겠습니다."
- 메시지 발송 요청시: "네, 대표님. [고객]님께 메시지 보내드릴까요?"

[중요]
- 한국어로만 대화
- 대표님의 말씀을 잘 듣고 맥락을 이해해서 응답
- 금융/보험 관련 질문에는 전문적이고 정확하게 답변
- 모르는 것은 솔직히 모른다고 하고, 확인 후 답변드리겠다고 함`;

// 대화 히스토리 저장 (세션별)
const conversationHistory = new Map();

// 기본 라우트
app.get('/', (req, res) => {
  res.send('AI지니 서버 실행 중!');
});

// GPT-4o 채팅 API
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  
  if (!message) {
    return res.json({ reply: '메시지가 없습니다.' });
  }

  try {
    // 대화 히스토리 가져오기
    if (!conversationHistory.has(sessionId)) {
      conversationHistory.set(sessionId, []);
    }
    const history = conversationHistory.get(sessionId);
    
    // 사용자 메시지 추가
    history.push({ role: 'user', content: message });
    
    // 최근 10개 대화만 유지
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // OpenAI API 호출
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
          ...history
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '죄송합니다, 다시 말씀해주세요.';
    
    // 지니 응답 히스토리에 추가
    history.push({ role: 'assistant', content: reply });
    
    console.log('사용자:', message);
    console.log('지니:', reply);
    
    res.json({ reply });

  } catch (error) {
    console.error('GPT 에러:', error);
    res.json({ reply: '네, 대표님! 잠시 연결이 불안정합니다. 다시 말씀해주세요.' });
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
    console.log('전화 발신:', to);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('전화 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// Twilio 웹훅
app.post('/incoming-call', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="ko-KR">안녕하세요, 오원트금융연구소입니다. 무엇을 도와드릴까요?</Say>
  <Pause length="60"/>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log(`AI지니 서버 시작! (포트 ${PORT})`);
});

console.log('서버 준비 완료');
