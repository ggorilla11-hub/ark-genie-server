// ============================================
// ARK-Genie Server v21.1 - 보험 전문가 OCR (오상열 CFP 감수)
// - 🆕 계약자/피보험자/수익자 정보 추출
// - 🆕 총보험료 vs 개별보험료 구분
// - 🆕 납입기간/보험기간 구분
// - 🆕 주계약 vs 특약 명확 구분
// - 🆕 사망보험금 종류 (일반/질병/재해·상해)
// - 🆕 장해보험금 종류 (질병장해/재해·상해장해)
// - 오상열 CFP 적정 보험금액 공식 적용
// ============================================

const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const { google } = require('googleapis'); // 🆕 v19: 구글 API
const app = express();

app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

// 🆕 v19: 구글시트 환경변수
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

const callStatusMap = new Map();
const callContextMap = new Map();

// ============================================
// 🆕 v19: 구글시트 인증 설정
// ============================================
let sheets = null;
let sheetsAuth = null;

if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY && GOOGLE_SPREADSHEET_ID) {
  try {
    sheetsAuth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    
    sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
    console.log('📊 [Google Sheets] 연동 설정 완료!');
    console.log('   - 스프레드시트 ID:', GOOGLE_SPREADSHEET_ID);
  } catch (e) {
    console.error('❌ [Google Sheets] 인증 설정 실패:', e.message);
  }
} else {
  console.log('⚠️ [Google Sheets] 환경변수 미설정 - 구글시트 기능 비활성화');
}

// ============================================
// 🆕 v7.8: RAG 지식 베이스 로드
// ============================================
let ragChunks = [];
try {
  const ragData = fs.readFileSync('./rag_chunks.json', 'utf-8');
  ragChunks = JSON.parse(ragData);
  console.log(`📚 [RAG] 지식 베이스 로드 완료: ${ragChunks.length}개 청크`);
} catch (e) {
  console.log('📚 [RAG] 지식 베이스 파일 없음 - RAG 비활성화');
}

// 🆕 v7.8: 키워드 기반 RAG 검색 함수
const searchRAG = (query, topK = 5) => {
  if (ragChunks.length === 0) return [];
  
  const keywords = query.toLowerCase()
    .replace(/[^\w가-힣\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 2);
  
  if (keywords.length === 0) return [];
  
  const scored = ragChunks.map(chunk => {
    const content = chunk.content.toLowerCase();
    let score = 0;
    
    for (const keyword of keywords) {
      const matches = (content.match(new RegExp(keyword, 'g')) || []).length;
      score += matches * 2;
      
      if (chunk.book.toLowerCase().includes(keyword)) {
        score += 5;
      }
    }
    
    return { ...chunk, score };
  });
  
  return scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
};

// 🆕 v7.8: RAG 컨텍스트 포맷팅
const formatRAGContext = (chunks) => {
  if (!chunks || chunks.length === 0) return '';
  
  return chunks.map((chunk, idx) => {
    return `[참고자료 ${idx + 1}] 출처: ${chunk.book}\n${chunk.content.substring(0, 800)}...`;
  }).join('\n\n');
};

// ============================================
// 프롬프트 정의 v20.0 - 오상열 CFP 보험공식 포함
// ============================================

// 🆕 v20: 오상열 CFP 적정 보험금액 공식
const INSURANCE_EXPERT_FORMULA = `
## 💰 오상열 CFP의 적정 보험금액 공식

### 기본 보장금액 기준 (연봉 기준)
- 사망보험금/장해보험금: 연봉 × 3 + 부채 (가장 필수)
- 암진단금: 연봉 × 2 (최소 1억 권장)
- 뇌혈관질환 진단금: 연봉 × 1 (뇌출혈, 뇌경색 등)
- 심혈관질환 진단금: 연봉 × 1 (심근경색, 협심증 등)
- 실손의료비: 5,000만원 (기본 필수)
- 입원/수술/치매/간병 특약: 1개 이상 있으면 OK

### 기본값 (정보 없을 때)
- 연봉: 5,000만원 기준
- 부채: 0원 기준

### 월 보험료 기준
- 기혼자: 소득의 10% 내외
- 미혼자: 소득의 5% 내외

### 분석 예시
"연봉 5,000만원 기준 분석:
- 사망보장: 1.5억 필요 (현재 5천만원 → 1억 부족)
- 암진단금: 1억 필요 (현재 3천만원 → 7천만원 부족)
- 뇌/심장: 각 5천만원 필요
권장 추가 보험료: 월 10~15만원"
`;

// 🆕 v20: 데모용 일정 데이터
const DEMO_SCHEDULE = {
  "2024-12-27": [
    { time: "10:00", content: "홍길동 고객님 상담", icon: "📅" },
    { time: "12:00", content: "성춘향 고객님 점심약속 (강남역)", icon: "🍽️" },
    { time: "15:00", content: "김연우님 증권전달 방문", icon: "📋" }
  ],
  "2024-12-28": [
    { time: "09:00", content: "주간 팀 미팅", icon: "👥" },
    { time: "14:00", content: "신규 고객 박지성님 상담", icon: "📅" },
    { time: "16:30", content: "보험사 세미나 참석", icon: "🎓" }
  ]
};

// 🆕 v20: 일정 안내 기능
const SCHEDULE_INSTRUCTION = `
## 📅 일정 관리 기능
대표님이 "오늘 일정", "내 스케줄", "약속", "일정 알려줘" 등을 물어보면:
- 오늘 일정: "오전 10시 홍길동 고객님 상담, 오후 12시 성춘향 고객님 점심약속 강남역, 오후 3시 김연우님 증권전달 방문. 총 3건입니다!"
- 내일 일정: "오전 9시 주간 팀 미팅, 오후 2시 신규 고객 박지성님 상담, 오후 4시 30분 보험사 세미나 참석. 총 3건입니다!"
- 일정 없으면: "오늘은 등록된 일정이 없습니다. 여유로운 하루 되세요!"
`;

const APP_PROMPT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 **20년 경력 보험 전문가**입니다.

## 🎯 핵심 역할
- 대한민국 최초 AI보험비서, 오상열 CFP가 개발
- 보험설계사의 영업, 보상 업무를 돕는 전문가
- 고객 상담, 증권 분석, 업무 처리 지원

${INSURANCE_EXPERT_FORMULA}

${SCHEDULE_INSTRUCTION}

## 📌 절대 규칙
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 음성 대화시 짧고 간결하게 1-3문장으로 답하세요
5. 전문적이지만 친근하게 대화하세요

## 🎤 명령 처리
- "지니야" 호출: "네, 대표님! 무엇을 도와드릴까요?"
- 전화 요청: "알겠습니다"라고만 짧게 답하세요. 전화는 앱에서 처리합니다.
- 일정 질문: 저장된 일정 시간순으로 안내
- 보험 질문: 오상열 CFP 공식 기반 전문 답변`;

const APP_PROMPT_WITH_RAG = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 **20년 경력 보험 전문가**입니다.

## 🎯 핵심 역할
- 대한민국 최초 AI보험비서, 오상열 CFP가 개발
- 보험설계사의 영업, 보상 업무를 돕는 전문가

## 📚 학습된 지식
오상열 CFP 대표님의 저서 3권:
1. "소원을 말해봐" - 원트재무설계
2. "빚부터 갚아라" - 10억목돈마련절대법칙
3. "금융집짓기" - 금융의 집을 설계하다

${INSURANCE_EXPERT_FORMULA}

${SCHEDULE_INSTRUCTION}

## 📌 절대 규칙
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 보험/재무 질문: 오상열 CFP 공식과 책 내용 기반 전문 답변
5. 일반 대화: 짧고 친근하게

## 🔥 참고 자료 (오상열 대표님 저서):
{{RAG_CONTEXT}}

위 자료와 보험금액 공식을 바탕으로 전문적으로 답변하세요.
출처: "오상열 대표님의 [책 제목]에 따르면..."`;

const APP_PROMPT_WITH_CONTEXT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 **20년 경력 보험 전문가**입니다.

## 🎯 핵심 역할
- 보험증권 분석 전문가
- 고객 맞춤 보험 추천
- 보상 가능성 판단

${INSURANCE_EXPERT_FORMULA}

${SCHEDULE_INSTRUCTION}

## 📄 분석된 서류 정보
아래는 대표님이 업로드하신 서류 분석 내용입니다.

{{ANALYSIS_CONTEXT}}

## 🔍 분석 시 반드시 포함할 내용

### 보험증권 분석 시:
1. **고객 기본정보**: 이름, 나이, 성별
2. **보유 현황**: 회사, 상품명, 주요 보장
3. **보장 분석** (오상열 CFP 공식 적용):
   - ✅ 충분한 항목
   - ⚠️ 부족한 항목 + 권장 금액
4. **추천 제안**:
   - 추가 필요 보험 종류
   - 예상 월 보험료 범위
   - 영업 포인트 (고객 설득 멘트)

### 의료비 영수증/보상 서류 분석 시:
1. **청구 내용**: 진료 내역, 금액
2. **보상 가능성**: 높음/중간/낮음
3. **필요 서류**: 추가 제출 서류
4. **주의사항**: 면책, 감액 가능성

## 📌 절대 규칙
1. 무조건 한국어로만 말하세요
2. 구체적인 숫자와 근거를 제시하세요
3. "대표님" 호칭 사용`;

const APP_PROMPT_WITH_RAG_AND_CONTEXT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 **20년 경력 보험 전문가**입니다.

## 🎯 핵심 역할
- 대한민국 최초 AI보험비서, 오상열 CFP가 개발
- 보험증권 분석 및 맞춤 추천 전문가
- 보상 판단 및 영업 지원

## 📚 학습된 지식
오상열 CFP 대표님의 저서 3권:
1. "소원을 말해봐" - 원트재무설계
2. "빚부터 갚아라" - 10억목돈마련절대법칙
3. "금융집짓기" - 금융의 집을 설계하다

${INSURANCE_EXPERT_FORMULA}

${SCHEDULE_INSTRUCTION}

## 🔥 참고 자료 (오상열 대표님 저서):
{{RAG_CONTEXT}}

## 📄 분석된 서류 정보:
{{ANALYSIS_CONTEXT}}

## 🔍 보험증권 분석 시 반드시:
1. 오상열 CFP 공식으로 보장 적정성 판단
2. 부족한 보장 구체적 금액 제시
3. 추천 보험과 예상 보험료 안내
4. 영업 포인트 제공

## 📌 절대 규칙
1. 한국어만 사용
2. "대표님" 호칭
3. 구체적 숫자 제시
4. 전문적이지만 친근하게`;

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
// 🆕 v19: 구글시트 API 엔드포인트
// ============================================

// 구글시트 연결 상태 확인
app.get('/api/sheets/status', async (req, res) => {
  try {
    if (!sheets) {
      return res.json({ 
        success: false, 
        connected: false,
        error: '구글시트 연동이 설정되지 않았습니다.' 
      });
    }

    // 연결 테스트 - 시트 정보 가져오기
    const response = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID
    });

    res.json({
      success: true,
      connected: true,
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      title: response.data.properties.title,
      sheets: response.data.sheets.map(s => s.properties.title),
      lastSync: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [Sheets] 상태 확인 에러:', error.message);
    res.json({ 
      success: false, 
      connected: false,
      error: error.message 
    });
  }
});

// 고객 목록 조회
app.get('/api/sheets/customers', async (req, res) => {
  try {
    if (!sheets) {
      return res.json({ success: false, error: '구글시트 연동이 설정되지 않았습니다.' });
    }

    console.log('📊 [Sheets] 고객 목록 조회 요청');

    // 시트에서 데이터 읽기 (A:H = 고객ID, 이름, 전화번호, 이메일, 회사, 직책, 등록일, 메모)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: 'Sheet1!A:H'
    });

    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      return res.json({ 
        success: true, 
        customers: [],
        total: 0,
        message: '등록된 고객이 없습니다.'
      });
    }

    // 첫 번째 행은 헤더
    const headers = rows[0];
    const customers = rows.slice(1).map((row, index) => ({
      id: row[0] || `${index + 1}`,
      name: row[1] || '',
      phone: row[2] || '',
      email: row[3] || '',
      company: row[4] || '',
      position: row[5] || '',
      registeredDate: row[6] || '',
      memo: row[7] || ''
    })).filter(c => c.name); // 이름이 있는 것만

    console.log(`✅ [Sheets] 고객 ${customers.length}명 조회 완료`);

    res.json({
      success: true,
      customers: customers,
      total: customers.length,
      lastSync: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [Sheets] 고객 목록 조회 에러:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// 고객 추가
app.post('/api/sheets/customers', async (req, res) => {
  try {
    if (!sheets) {
      return res.json({ success: false, error: '구글시트 연동이 설정되지 않았습니다.' });
    }

    const { name, phone, email, company, position, memo } = req.body;

    if (!name || !phone) {
      return res.json({ success: false, error: '이름과 전화번호는 필수입니다.' });
    }

    console.log('📊 [Sheets] 고객 추가 요청:', name, phone);

    // 현재 행 수 확인해서 새 ID 생성
    const countResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: 'Sheet1!A:A'
    });
    
    const currentRows = countResponse.data.values || [];
    const newId = currentRows.length; // 헤더 포함해서 다음 번호

    // 오늘 날짜
    const today = new Date().toISOString().split('T')[0];

    // 새 행 추가
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: 'Sheet1!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          newId.toString(),
          name,
          phone,
          email || '',
          company || '',
          position || '',
          today,
          memo || ''
        ]]
      }
    });

    console.log(`✅ [Sheets] 고객 추가 완료: ${name}`);

    res.json({
      success: true,
      message: '고객이 추가되었습니다.',
      customer: {
        id: newId.toString(),
        name,
        phone,
        email: email || '',
        company: company || '',
        position: position || '',
        registeredDate: today,
        memo: memo || ''
      }
    });

  } catch (error) {
    console.error('❌ [Sheets] 고객 추가 에러:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// 고객 수정
app.put('/api/sheets/customers/:id', async (req, res) => {
  try {
    if (!sheets) {
      return res.json({ success: false, error: '구글시트 연동이 설정되지 않았습니다.' });
    }

    const { id } = req.params;
    const { name, phone, email, company, position, memo } = req.body;

    console.log('📊 [Sheets] 고객 수정 요청:', id);

    // ID로 행 찾기
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: 'Sheet1!A:H'
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === id);

    if (rowIndex === -1) {
      return res.json({ success: false, error: '해당 고객을 찾을 수 없습니다.' });
    }

    // 기존 데이터 유지하면서 업데이트
    const existingRow = rows[rowIndex];
    const updatedRow = [
      id,
      name || existingRow[1],
      phone || existingRow[2],
      email !== undefined ? email : existingRow[3],
      company !== undefined ? company : existingRow[4],
      position !== undefined ? position : existingRow[5],
      existingRow[6], // 등록일은 유지
      memo !== undefined ? memo : existingRow[7]
    ];

    // 행 업데이트
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `Sheet1!A${rowIndex + 1}:H${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [updatedRow]
      }
    });

    console.log(`✅ [Sheets] 고객 수정 완료: ${name || existingRow[1]}`);

    res.json({
      success: true,
      message: '고객 정보가 수정되었습니다.',
      customer: {
        id,
        name: updatedRow[1],
        phone: updatedRow[2],
        email: updatedRow[3],
        company: updatedRow[4],
        position: updatedRow[5],
        registeredDate: updatedRow[6],
        memo: updatedRow[7]
      }
    });

  } catch (error) {
    console.error('❌ [Sheets] 고객 수정 에러:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// 고객 삭제
app.delete('/api/sheets/customers/:id', async (req, res) => {
  try {
    if (!sheets) {
      return res.json({ success: false, error: '구글시트 연동이 설정되지 않았습니다.' });
    }

    const { id } = req.params;

    console.log('📊 [Sheets] 고객 삭제 요청:', id);

    // ID로 행 찾기
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: 'Sheet1!A:A'
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === id);

    if (rowIndex === -1) {
      return res.json({ success: false, error: '해당 고객을 찾을 수 없습니다.' });
    }

    // 시트 ID 가져오기
    const sheetInfo = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID
    });
    const sheetId = sheetInfo.data.sheets[0].properties.sheetId;

    // 행 삭제
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        }]
      }
    });

    console.log(`✅ [Sheets] 고객 삭제 완료: ID ${id}`);

    res.json({
      success: true,
      message: '고객이 삭제되었습니다.',
      deletedId: id
    });

  } catch (error) {
    console.error('❌ [Sheets] 고객 삭제 에러:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// 시트 다운로드 (CSV 형식)
app.get('/api/sheets/download', async (req, res) => {
  try {
    if (!sheets) {
      return res.json({ success: false, error: '구글시트 연동이 설정되지 않았습니다.' });
    }

    console.log('📊 [Sheets] 다운로드 요청');

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: 'Sheet1!A:H'
    });

    const rows = response.data.values || [];
    
    // CSV 형식으로 변환
    const csv = rows.map(row => row.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    // UTF-8 BOM 추가 (한글 깨짐 방지)
    const bom = '\uFEFF';
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=AI_genie_customers.csv');
    res.send(bom + csv);

    console.log(`✅ [Sheets] 다운로드 완료: ${rows.length}행`);

  } catch (error) {
    console.error('❌ [Sheets] 다운로드 에러:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 기존 엔드포인트 (v18.0 그대로 유지)
// ============================================

app.get('/', (req, res) => {
  res.json({
    status: 'AI지니 서버 실행 중!',
    version: '19.0 - 구글시트 연동 추가',
    googleSheets: {
      enabled: !!sheets,
      spreadsheetId: GOOGLE_SPREADSHEET_ID ? '설정됨' : '미설정'
    },
    rag: {
      enabled: ragChunks.length > 0,
      chunks: ragChunks.length,
      books: ['소원을 말해봐', '빚부터 갚아라', '금융집짓기']
    },
    endpoints: {
      existing: ['/api/chat', '/api/call', '/api/call-status/:callSid', '/incoming-call'],
      new: ['/api/call-realtime', '/media-stream', '/api/analyze-image', '/api/analyze-file', '/api/rag-search'],
      prospect: ['/api/analyze-prospect', '/api/generate-prospect-message'],
      sheets: ['/api/sheets/status', '/api/sheets/customers', '/api/sheets/download']
    }
  });
});

// 🆕 v7.8: RAG 검색 API
app.post('/api/rag-search', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.json({ success: false, error: '검색어가 없습니다.' });
    }
    
    console.log('🔍 [RAG] 검색 요청:', query);
    
    const results = searchRAG(query, 5);
    
    console.log(`✅ [RAG] 검색 결과: ${results.length}개 청크`);
    
    res.json({
      success: true,
      query: query,
      results: results.map(r => ({
        book: r.book,
        score: r.score,
        preview: r.content.substring(0, 200) + '...'
      })),
      context: formatRAGContext(results)
    });
    
  } catch (error) {
    console.error('❌ [RAG] 검색 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 🆕 v18: 고객발굴 OCR 분석 API
// ============================================
app.post('/api/analyze-prospect', async (req, res) => {
  try {
    const { image, imageType } = req.body;
    
    if (!image) {
      return res.json({ success: false, error: '이미지가 없습니다.' });
    }
    
    console.log('🔍 [Prospect] 고객발굴 OCR 분석 요청:', imageType);
    
    const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
    
    const prospectPrompt = `당신은 보험설계사의 고객발굴을 돕는 AI OCR 전문가입니다.

## 📋 분석 대상
업로드된 이미지는 ${imageType === 'receipt' ? '영수증' : imageType === 'businessCard' ? '명함' : '영수증 또는 명함'}입니다.

## 🎯 추출해야 할 정보

### 영수증인 경우:
1. **사업자등록번호**: (XXX-XX-XXXXX 형식, 없으면 "미확인")
2. **상호명/가게명**: 
3. **대표자명**: (없으면 "미확인")
4. **사업장주소**: (가능한 상세하게)
5. **전화번호**: (일반전화 또는 휴대폰)
6. **업종추정**: (음식점, 카페, 소매업 등)
7. **기타정보**: (영업시간, 특이사항 등)

### 명함인 경우:
1. **사업자등록번호**: (있는 경우만)
2. **회사명/상호**:
3. **대표자명/담당자명**:
4. **직책/직위**:
5. **사업장주소**:
6. **휴대폰번호**: (필수!)
7. **일반전화**:
8. **이메일**:
9. **팩스**:
10. **업종추정**:

## 📊 출력 형식 (반드시 이 JSON 형식으로!)

\`\`\`json
{
  "documentType": "receipt 또는 businessCard",
  "extracted": {
    "businessNumber": "사업자등록번호 또는 미확인",
    "companyName": "상호명",
    "ownerName": "대표자명 또는 미확인",
    "address": "주소",
    "phone": "전화번호 또는 미확인",
    "mobile": "휴대폰번호 또는 미확인",
    "email": "이메일 또는 미확인",
    "businessType": "업종 추정",
    "position": "직책 (명함인 경우)",
    "fax": "팩스 (있는 경우)"
  },
  "confidence": "high/medium/low",
  "insuranceAnalysis": {
    "businessCategory": "다중이용업소/일반사업장/소매업 등",
    "mandatoryInsurance": ["의무보험 목록"],
    "recommendedInsurance": ["추천보험 목록"],
    "riskFactors": ["위험요소 목록"],
    "salesPoints": ["영업포인트 목록"]
  },
  "rawText": "OCR로 읽은 원본 텍스트 전체"
}
\`\`\`

## ⚠️ 중요 규칙
1. 반드시 위 JSON 형식으로만 응답하세요
2. 확인되지 않은 정보는 "미확인"으로 표시
3. 추정인 경우 "(추정)" 표시
4. 사업자등록번호는 정확히 10자리 숫자만 유효
5. 전화번호는 하이픈(-) 포함하여 표시
6. 이미지가 불분명하면 confidence를 "low"로`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: prospectPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: '이 이미지에서 사업자 정보를 추출하고 보험 분석을 해주세요.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
            ]
          }
        ],
        max_tokens: 2000,
        temperature: 0.1
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      const rawResponse = data.choices[0].message.content;
      console.log('✅ [Prospect] OCR 분석 완료');
      
      try {
        let jsonStr = rawResponse;
        if (jsonStr.includes('```json')) {
          jsonStr = jsonStr.split('```json')[1].split('```')[0];
        } else if (jsonStr.includes('```')) {
          jsonStr = jsonStr.split('```')[1].split('```')[0];
        }
        
        const parsedData = JSON.parse(jsonStr.trim());
        
        res.json({
          success: true,
          data: parsedData,
          raw: rawResponse
        });
        
      } catch (parseError) {
        console.log('⚠️ [Prospect] JSON 파싱 실패, raw 응답 반환');
        res.json({
          success: true,
          data: null,
          raw: rawResponse,
          parseError: parseError.message
        });
      }
    } else {
      res.json({ success: false, error: 'OpenAI 응답 없음' });
    }
    
  } catch (error) {
    console.error('❌ [Prospect] OCR 분석 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 🆕 v18: 영업 메시지 생성 API
// ============================================
app.post('/api/generate-prospect-message', async (req, res) => {
  try {
    const { prospectData, messageType } = req.body;
    
    if (!prospectData) {
      return res.json({ success: false, error: '고객발굴 데이터가 없습니다.' });
    }
    
    console.log('📝 [Prospect] 영업 메시지 생성 요청:', messageType);
    
    const messagePrompt = `당신은 보험설계사의 영업 메시지 작성 전문가입니다.

## 📋 고객발굴 데이터
${JSON.stringify(prospectData, null, 2)}

## 🎯 작성할 메시지 유형
${messageType === 'sms' ? 'SMS 문자 메시지 (90자 이내)' : 
  messageType === 'kakao' ? '카카오톡 메시지 (300자 이내)' : 
  'DM/이메일 메시지 (500자 이내)'}

## ✅ 메시지 작성 규칙
1. 업종에 맞는 맞춤형 메시지
2. 의무보험이 있다면 반드시 언급
3. 강압적이지 않고 친근한 톤
4. 구체적인 혜택 제시
5. 연락처/방문 유도 문구 포함

## 📝 출력 형식
\`\`\`json
{
  "message": "작성된 메시지",
  "messageType": "${messageType}",
  "keyPoints": ["핵심 포인트1", "핵심 포인트2"],
  "callToAction": "콜투액션 문구"
}
\`\`\``;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: messagePrompt },
          { role: 'user', content: '이 고객에게 보낼 영업 메시지를 작성해주세요.' }
        ],
        max_tokens: 1000,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      const rawResponse = data.choices[0].message.content;
      console.log('✅ [Prospect] 메시지 생성 완료');
      
      try {
        let jsonStr = rawResponse;
        if (jsonStr.includes('```json')) {
          jsonStr = jsonStr.split('```json')[1].split('```')[0];
        } else if (jsonStr.includes('```')) {
          jsonStr = jsonStr.split('```')[1].split('```')[0];
        }
        
        const parsedData = JSON.parse(jsonStr.trim());
        res.json({ success: true, data: parsedData });
        
      } catch (parseError) {
        res.json({ success: true, message: rawResponse });
      }
    } else {
      res.json({ success: false, error: 'OpenAI 응답 없음' });
    }
    
  } catch (error) {
    console.error('❌ [Prospect] 메시지 생성 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 기존 채팅 API
// ============================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    console.log('💬 [Chat] 요청:', message?.substring(0, 50));
    
    let systemPrompt = APP_PROMPT;
    
    if (ragChunks.length > 0) {
      const ragResults = searchRAG(message, 3);
      if (ragResults.length > 0) {
        const ragContext = formatRAGContext(ragResults);
        systemPrompt = APP_PROMPT_WITH_RAG.replace('{{RAG_CONTEXT}}', ragContext);
        console.log(`📚 [Chat] RAG 적용: ${ragResults.length}개 청크`);
      }
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
          { role: 'system', content: systemPrompt },
          ...(context || []),
          { role: 'user', content: message }
        ],
        max_tokens: 1000,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      res.json({ success: true, response: data.choices[0].message.content });
    } else {
      res.json({ success: false, error: 'OpenAI 응답 없음' });
    }
    
  } catch (error) {
    console.error('❌ [Chat] 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 기존 이미지 분석 API - v20 보험 전문가 프롬프트 적용
// ============================================
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { image, prompt } = req.body;
    
    if (!image) {
      return res.json({ success: false, error: '이미지가 없습니다.' });
    }
    
    console.log('🖼️ [Image] 분석 요청');
    
    const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
    
    // 🆕 v21.1: 보험 전문가 수준 OCR 프롬프트 (오상열 CFP 감수)
    const expertPrompt = prompt || `당신은 20년 경력의 보험증권 분석 전문가입니다. 보험증권 이미지를 정확하게 OCR하고 분석해주세요.

## 🚨 OCR 핵심 규칙 (매우 중요!)

### 1. 보험가입금액 vs 보험료 구분
- **보험가입금액** = 보장받는 금액 (단위: 만원, 천만원, 억원) → 1,000만원 ~ 수억원
- **보험료** = 매월 내는 돈 (단위: 원) → 1만원 ~ 30만원
- 같은 행: 왼쪽=가입금액, 오른쪽=보험료
- 예: "7,000만원 | 96,600원" → 가입금액 7,000만원, 월보험료 96,600원

### 2. 총 보험료 찾기
- 특약별 개별 보험료가 아닌 **"합계", "총보험료", "월납보험료"** 항목을 찾을 것
- 보통 표 하단 또는 별도 영역에 표시됨

### 3. 주계약 vs 특약 구분
- **주계약**: "특약"이라는 단어가 없는 것 = 기본 사망보험금
- **특약**: "특약", "선택특약", "의무특약" 등으로 표시된 것

### 4. 사망보험금 종류 (중요!)
| 표기 | 의미 | 보장 범위 |
|------|------|----------|
| 사망보험금, 일반사망 | (일반)사망 | 자살 포함 모든 사망 |
| 질병사망 | 질병으로 인한 사망 | 암, 심장병 등 |
| 재해사망 (생명보험) | 사고사망 | 교통사고, 재해 등 |
| 상해사망 (손해보험) | 사고사망 | 교통사고, 재해 등 |
※ "사망"만 쓰여있으면 = 일반사망 (가장 넓은 범위)

### 5. 장해보험금 종류
| 표기 | 의미 |
|------|------|
| 장해보험금, 장해급여금 | 질병장해 (일반적 장해) |
| 질병장해 | 질병으로 인한 장해 |
| 재해장해 (생명보험) | 사고로 인한 장해 |
| 상해장해 (손해보험) | 사고로 인한 장해 |

### 6. 납입기간/보험기간
- **납입기간(납기)**: 보험료를 내는 기간 (예: 20년납)
- **보험기간**: 보장받는 기간 (예: 100세만기, 종신)

---

## 📋 필수 추출 항목 (이 순서대로!)

### 1. 계약자 정보
- 이름:
- 생년월일/나이:
- 성별:

### 2. 피보험자 정보
- 이름:
- 생년월일/나이:
- 성별:
- 계약자와 동일 여부:

### 3. 보험수익자
- 사망수익자:
- 만기수익자:

### 4. 보험 기본정보
- 보험회사:
- 상품명:
- 증권번호:
- 계약일:
- 보험기간:
- 납입기간(납기):
- **총 보험료(월납):**

### 5. 보장내역 (표 형식 필수!)

#### 주계약
| 보장명 | 보험가입금액 | 보험기간 | 월보험료 |
|--------|-------------|---------|---------|
| (특약 아닌 것) | O,OOO만원 | OO년/종신 | OO,OOO원 |

#### 특약
| 특약명 | 보험가입금액 | 보험기간 | 월보험료 |
|--------|-------------|---------|---------|
| OO특약 | O,OOO만원 | OO년 | O,OOO원 |

### 6. 사망보장 분석
- 일반사망: O,OOO만원
- 질병사망: O,OOO만원
- 재해/상해사망: O,OOO만원

### 7. 장해보장 분석
- (질병)장해: O,OOO만원
- 재해/상해장해: O,OOO만원

---

## 💰 오상열 CFP 적정 보험금액 기준 분석

### 적정 금액 공식 (연봉 5,000만원 기준)
- 사망보장: 연봉 × 3 + 부채 = **1.5억 이상**
- 암진단금: 연봉 × 2 = **1억 이상**
- 뇌혈관진단금: 연봉 × 1 = **5,000만원**
- 심혈관진단금: 연봉 × 1 = **5,000만원**
- 실손의료비: **5,000만원**

### 현재 vs 적정 비교
| 보장항목 | 현재금액 | 적정금액 | 판정 |
|---------|---------|---------|------|
| 사망보장 | | 1.5억 | ✅/⚠️ |
| 암진단금 | | 1억 | ✅/⚠️ |

### 영업 포인트
- 부족한 보장:
- 추천 추가 보험:
- 고객 설득 멘트:

---

## 📋 기타 문서 분석

### 의료비 영수증
1. 병원명, 진료일
2. 상병명, 진료내용
3. 총진료비, 본인부담금
4. 실손청구 가능 여부

### 명함
1. 이름, 직책
2. 회사명, 연락처

---

⚠️ 정확한 숫자 추출이 가장 중요합니다!
⚠️ 보험가입금액과 보험료를 절대 혼동하지 마세요!`;
    
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
            role: 'user',
            content: [
              { type: 'text', text: expertPrompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
            ]
          }
        ],
        max_tokens: 2000
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      console.log('✅ [Image] 분석 완료');
      res.json({ success: true, analysis: data.choices[0].message.content });
    } else {
      res.json({ success: false, error: 'OpenAI 응답 없음' });
    }
    
  } catch (error) {
    console.error('❌ [Image] 분석 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 기존 파일 분석 API (PDF 포함)
// ============================================
app.post('/api/analyze-file', async (req, res) => {
  try {
    const { file, fileName, fileType, prompt } = req.body;
    
    if (!file) {
      return res.json({ success: false, error: '파일이 없습니다.' });
    }
    
    console.log('📄 [File] 분석 요청:', fileName, fileType);
    
    let textContent = '';
    
    if (fileType === 'application/pdf' || fileName?.endsWith('.pdf')) {
      const base64Data = file.includes('base64,') ? file.split('base64,')[1] : file;
      const pdfBuffer = Buffer.from(base64Data, 'base64');
      const pdfData = await pdfParse(pdfBuffer);
      textContent = pdfData.text;
      console.log('📄 [File] PDF 텍스트 추출 완료:', textContent.length, '자');
    } else {
      const base64Data = file.includes('base64,') ? file.split('base64,')[1] : file;
      textContent = Buffer.from(base64Data, 'base64').toString('utf-8');
    }
    
    // 🆕 v20: 보험 전문가 문서 분석 프롬프트
    const expertSystemPrompt = `당신은 20년 경력의 보험 전문가입니다. 오상열 CFP의 노하우로 문서를 분석합니다.

## 💰 오상열 CFP의 적정 보험금액 공식
- 사망/장해보험금: 연봉 × 3 + 부채
- 암진단금: 연봉 × 2 (최소 1억)
- 뇌혈관/심혈관 진단금: 연봉 × 1
- 실손의료비: 5,000만원
- 기본값: 연봉 5,000만원, 부채 0원

### 월 보험료 기준
- 기혼자: 소득의 10% 내외
- 미혼자: 소득의 5% 내외

## 📋 분석 시 포함할 내용:

### 보험증권인 경우:
1. 고객 정보 (이름, 나이, 성별)
2. 보험회사, 상품명, 보험기간
3. 주요 보장 내용 및 금액 (표 형식)
4. 월/연 보험료
5. ⚠️ 오상열 CFP 공식 기준 부족한 보장 분석
   - 각 항목별 적정금액 vs 현재금액 비교
   - 부족 금액 명시
6. 💡 추천 사항
   - 추가 필요 보험 종류
   - 예상 추가 보험료
   - 영업 포인트 (고객 설득 멘트)

### 보상 청구 서류인 경우:
1. 청구 종류 및 내용
2. 보상 가능성 (높음/중간/낮음)
3. 예상 보상 금액
4. 필요 추가 서류
5. 주의사항 (면책, 감액 가능성)

구체적인 숫자와 근거를 제시해주세요.`;
    
    const analysisPrompt = prompt || `다음 문서를 분석해주세요:\n\n${textContent.substring(0, 10000)}`;
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: expertSystemPrompt },
          { role: 'user', content: analysisPrompt }
        ],
        max_tokens: 3000
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      console.log('✅ [File] 분석 완료');
      res.json({ 
        success: true, 
        analysis: data.choices[0].message.content,
        fileName: fileName,
        textLength: textContent.length
      });
    } else {
      res.json({ success: false, error: 'OpenAI 응답 없음' });
    }
    
  } catch (error) {
    console.error('❌ [File] 분석 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// Twilio 전화 관련 API (기존 유지)
// ============================================
app.post('/api/call', async (req, res) => {
  try {
    const { phoneNumber, customerName, purpose } = req.body;
    
    if (!phoneNumber) {
      return res.json({ success: false, error: '전화번호가 없습니다.' });
    }
    
    console.log('📞 [Call] 발신 요청:', phoneNumber, customerName);
    
    const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    
    const call = await twilioClient.calls.create({
      url: `https://${SERVER_DOMAIN}/incoming-call?purpose=${encodeURIComponent(purpose || '상담예약')}&customerName=${encodeURIComponent(customerName || '')}`,
      to: phoneNumber,
      from: TWILIO_NUMBER,
      statusCallback: `https://${SERVER_DOMAIN}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    
    callStatusMap.set(call.sid, { status: 'initiated', phoneNumber, customerName });
    callContextMap.set(call.sid, { customerName, purpose });
    
    console.log('✅ [Call] 발신 성공:', call.sid);
    
    res.json({ success: true, callSid: call.sid });
    
  } catch (error) {
    console.error('❌ [Call] 발신 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/call-status/:callSid', (req, res) => {
  const { callSid } = req.params;
  const status = callStatusMap.get(callSid);
  res.json({ success: true, status: status || { status: 'unknown' } });
});

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log('📞 [Call] 상태 업데이트:', CallSid, CallStatus);
  
  if (callStatusMap.has(CallSid)) {
    const current = callStatusMap.get(CallSid);
    current.status = CallStatus;
    callStatusMap.set(CallSid, current);
  }
  
  res.sendStatus(200);
});

app.all('/incoming-call', (req, res) => {
  const purpose = req.query.purpose || '상담예약';
  const customerName = req.query.customerName || '';
  
  console.log('📞 [Call] 수신 처리:', purpose, customerName);
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${SERVER_DOMAIN}/media-stream?purpose=${encodeURIComponent(purpose)}&amp;customerName=${encodeURIComponent(customerName)}" />
  </Connect>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// ============================================
// HTTP 서버 시작
// ============================================
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`🚀 서버 시작! 포트: ${PORT}`);
});

// ============================================
// WebSocket 서버 (기존 유지)
// ============================================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/media-stream') {
    const purpose = url.searchParams.get('purpose') || '상담예약';
    const customerName = url.searchParams.get('customerName') || '';
    
    console.log('📞 [Realtime] 전화 연결:', purpose, customerName);
    
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let endCallTimer = null;
    
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('✅ [Realtime] OpenAI 연결됨 (전화 모드)');
      
      const phonePrompt = PHONE_GENIE_PROMPT.replace('{{CALL_PURPOSE}}', purpose);
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: phonePrompt,
          voice: 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1', language: 'ko' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 500,
            silence_duration_ms: 2000
          }
        }
      }));
      
      setTimeout(() => {
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio']
          }
        }));
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
        
        if (event.type === 'response.audio_transcript.done') {
          console.log('🤖 지니(전화):', event.transcript);
          
          const transcript = event.transcript || '';
          const isEnding = 
            transcript.includes('안녕히 계세요') ||
            transcript.includes('좋은 하루') ||
            transcript.includes('감사합니다') ||
            transcript.includes('예약 완료');
          
          if (isEnding && !endCallTimer) {
            console.log('⏱️ [Realtime] 종료 멘트 감지 - 15초 후 통화 종료');
            endCallTimer = setTimeout(async () => {
              console.log('📞 [Realtime] 15초 경과 - 통화 종료');
              if (callSid) {
                try {
                  const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
                  await twilioClient.calls(callSid).update({ status: 'completed' });
                } catch (e) {
                  console.error('통화 종료 에러:', e);
                }
              }
            }, 15000);
          }
        }
        
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('👤 고객(전화):', event.transcript);
          
          const transcript = event.transcript || '';
          const isARS = 
            transcript.includes('없는 번호') ||
            transcript.includes('연결이 되지') ||
            transcript.includes('전화를 받지') ||
            transcript.includes('삐') ||
            transcript.length < 3;
          
          if (isARS) {
            console.log('🤖 [Realtime] ARS 자동응답 감지 - 타이머 유지');
          } else if (endCallTimer) {
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

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            console.log('📞 [Realtime] Twilio Stream 시작:', streamSid, 'CallSid:', callSid);
            break;

          case 'media':
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

    return;
  }

  // ============================================
  // 기존 앱지니용 WebSocket (유지)
  // ============================================
  let openaiWs = null;
  let lastAssistantItem = null;
  let currentAnalysisContextList = [];

  const formatAnalysisContext = (contextList) => {
    if (!contextList || contextList.length === 0) return '';
    
    return contextList.map((ctx, idx) => {
      return `=== [${idx + 1}번 파일] ${ctx.fileName} ===\n${ctx.analysis}`;
    }).join('\n\n');
  };

  const buildPromptWithRAG = (analysisContextList, userMessage = '') => {
    const hasAnalysis = analysisContextList && analysisContextList.length > 0;
    const hasRAG = ragChunks.length > 0;
    
    let ragContext = '';
    if (hasRAG && userMessage) {
      const ragResults = searchRAG(userMessage, 3);
      if (ragResults.length > 0) {
        ragContext = formatRAGContext(ragResults);
        console.log(`📚 [RAG] 검색 결과: ${ragResults.length}개 청크`);
      }
    }
    
    if (hasAnalysis && ragContext) {
      const analysisText = formatAnalysisContext(analysisContextList);
      return APP_PROMPT_WITH_RAG_AND_CONTEXT
        .replace('{{RAG_CONTEXT}}', ragContext)
        .replace('{{ANALYSIS_CONTEXT}}', analysisText);
    } else if (ragContext) {
      return APP_PROMPT_WITH_RAG.replace('{{RAG_CONTEXT}}', ragContext);
    } else if (hasAnalysis) {
      const analysisText = formatAnalysisContext(analysisContextList);
      return APP_PROMPT_WITH_CONTEXT.replace('{{ANALYSIS_CONTEXT}}', analysisText);
    } else {
      return APP_PROMPT;
    }
  };

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'update_context') {
        if (msg.analysisContextList) {
          currentAnalysisContextList = msg.analysisContextList;
          console.log('📋 [v15] 분석 컨텍스트 업데이트:', currentAnalysisContextList.length, '개 파일');
        } else if (msg.analysisContext) {
          currentAnalysisContextList = [msg.analysisContext];
          console.log('📋 [v15] 단일 파일 컨텍스트 업데이트:', msg.analysisContext.fileName);
        }
        
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN && currentAnalysisContextList.length > 0) {
          const updatedPrompt = buildPromptWithRAG(currentAnalysisContextList);
          
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              instructions: updatedPrompt
            }
          }));
          console.log('📤 [v15] OpenAI 프롬프트 업데이트 완료');
        }
        return;
      }

      if (msg.type === 'start_app') {
        console.log('📱 앱 Realtime 시작');
        
        if (msg.analysisContextList && msg.analysisContextList.length > 0) {
          currentAnalysisContextList = msg.analysisContextList;
          console.log('📋 [v15] 시작 시 분석 컨텍스트 수신:', currentAnalysisContextList.length, '개 파일');
        } else if (msg.analysisContext) {
          currentAnalysisContextList = [msg.analysisContext];
        }

        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        openaiWs.on('open', () => {
          console.log('✅ OpenAI Realtime API 연결됨! 모드: 앱');

          let promptToUse = buildPromptWithRAG(currentAnalysisContextList);
          
          if (currentAnalysisContextList.length > 0) {
            console.log('📋 [v15] 분석 컨텍스트 포함된 프롬프트 사용');
          }
          if (ragChunks.length > 0) {
            console.log('📚 [RAG] RAG 지식 베이스 활성화');
          }

          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: promptToUse,
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
