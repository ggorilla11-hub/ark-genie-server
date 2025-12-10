const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 10000;

// 환경변수
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY || 'f997b74fe39e51f2ee49e5ee0d12b8d8';

// Twilio 클라이언트
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// 미들웨어
app.use(cors());
app.use(express.json());

// 기본 라우트
app.get('/', (req, res) => {
  res.json({ 
    status: 'AI지니 서버 실행 중!',
    version: '2.0',
    endpoints: ['/api/chat', '/api/call', '/api/sms', '/api/kakao', '/api/email']
  });
});

// GPT 채팅 API
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
          {
            role: 'system',
            content: `당신은 AI지니입니다. 보험설계사를 돕는 AI 비서입니다.
- 친절하고 전문적으로 답변합니다
- 한국어로 간결하게 2-3문장으로 답변합니다
- 항상 "네, 대표님!" 또는 "네, 알겠습니다!"로 시작합니다
- 보험, 금융, 고객 관리에 대해 전문적인 조언을 제공합니다`
          },
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
app.post('/api/call', async (req, res) => {
  try {
    const { to, customerName } = req.body;
    
    // 전화번호 포맷 정리
    let phoneNumber = to.replace(/[-\s]/g, '');
    if (phoneNumber.startsWith('010')) {
      phoneNumber = '+82' + phoneNumber.slice(1);
    }
    
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_NUMBER,
      twiml: `<Response>
        <Say language="ko-KR" voice="Google.ko-KR-Wavenet-A">
          안녕하세요, ${customerName || '고객'}님. AI지니입니다. 
          오상열 CFP님께서 상담 일정을 잡고 싶어하십니다.
          편하신 시간을 말씀해 주시면 일정을 잡아드리겠습니다.
        </Say>
        <Pause length="3"/>
        <Say language="ko-KR" voice="Google.ko-KR-Wavenet-A">
          감사합니다. 좋은 하루 되세요.
        </Say>
      </Response>`
    });
    
    console.log('Call SID:', call.sid);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('Call error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// SMS 발송 API
app.post('/api/sms', async (req, res) => {
  try {
    const { to, customerName, message } = req.body;
    
    // 전화번호 포맷 정리
    let phoneNumber = to.replace(/[-\s]/g, '');
    if (phoneNumber.startsWith('010')) {
      phoneNumber = '+82' + phoneNumber.slice(1);
    }
    
    const smsMessage = message || `[AI지니] 안녕하세요 ${customerName || '고객'}님, 오상열 CFP입니다. 상담 예약 확인 안내드립니다.`;
    
    const result = await twilioClient.messages.create({
      to: phoneNumber,
      from: TWILIO_NUMBER,
      body: smsMessage
    });
    
    console.log('SMS SID:', result.sid);
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('SMS error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 카카오톡 알림톡 API (시뮬레이션)
app.post('/api/kakao', async (req, res) => {
  try {
    const { customerName, message, phone } = req.body;
    
    // 실제 카카오 알림톡은 비즈니스 채널 승인 후 사용 가능
    // 현재는 시뮬레이션으로 처리
    console.log('카카오톡 발송 요청:', { customerName, message, phone });
    
    // TODO: 카카오 비즈니스 채널 승인 후 실제 API 연동
    // const kakaoResponse = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${ACCESS_TOKEN}`,
    //     'Content-Type': 'application/x-www-form-urlencoded'
    //   },
    //   body: new URLSearchParams({
    //     template_object: JSON.stringify({...})
    //   })
    // });
    
    res.json({ 
      success: true, 
      message: '카카오톡 발송 완료 (시뮬레이션)',
      customerName,
      sentMessage: message || '상담 예약 확인 안내'
    });
  } catch (error) {
    console.error('Kakao error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 이메일 발송 API (시뮬레이션)
app.post('/api/email', async (req, res) => {
  try {
    const { to, customerName, subject, body } = req.body;
    
    // TODO: Gmail API 또는 SMTP 연동
    console.log('이메일 발송 요청:', { to, customerName, subject });
    
    res.json({ 
      success: true, 
      message: '이메일 발송 완료 (시뮬레이션)',
      customerName,
      subject: subject || '상담 예약 안내'
    });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 구글 시트 기록 API (시뮬레이션)
app.post('/api/sheet', async (req, res) => {
  try {
    const { customerName, content, date } = req.body;
    
    // TODO: Google Sheets API 연동
    console.log('시트 기록 요청:', { customerName, content, date });
    
    res.json({ 
      success: true, 
      message: '고객현황판 기록 완료 (시뮬레이션)',
      customerName,
      content
    });
  } catch (error) {
    console.error('Sheet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 구글 캘린더 등록 API (시뮬레이션)
app.post('/api/calendar', async (req, res) => {
  try {
    const { title, date, time, customerName } = req.body;
    
    // TODO: Google Calendar API 연동
    console.log('캘린더 등록 요청:', { title, date, time, customerName });
    
    res.json({ 
      success: true, 
      message: '캘린더 일정 등록 완료 (시뮬레이션)',
      title,
      dateTime: `${date} ${time}`
    });
  } catch (error) {
    console.error('Calendar error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`AI지니 서버 시작! (포트 ${PORT})`);
  console.log('사용 가능한 API:');
  console.log('- POST /api/chat (GPT 대화)');
  console.log('- POST /api/call (전화 발신)');
  console.log('- POST /api/sms (문자 발송)');
  console.log('- POST /api/kakao (카카오톡)');
  console.log('- POST /api/email (이메일)');
  console.log('- POST /api/sheet (구글시트)');
  console.log('- POST /api/calendar (캘린더)');
});
