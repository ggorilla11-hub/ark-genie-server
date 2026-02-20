// ============================================
// ARK-Genie Server v22.0 - Claude Vision 보험분석
// ============================================
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
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
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_CHANNEL_ID = process.env.KAKAO_CHANNEL_ID;
const KAKAO_ACCESS_TOKEN = process.env.KAKAO_ACCESS_TOKEN;
const callStatusMap = new Map();
const callContextMap = new Map();

// ============================================
// 보험상품 DB
// ============================================
const INSURANCE_DB = {
  종신보험_체증형: [
    { 보험사: "iM라이프", 상품명: "iM Plus세븐UP", 보험료_일반: 112300, 보험료_간편: 124400, 환급률_7년: "100%", 환급률_10년: "107.7%", 체증한도: "500%" },
    { 보험사: "푸본현대", 상품명: "MAX세븐하이픽", 보험료_일반: 109500, 보험료_간편: 122000, 환급률_7년: "100%", 환급률_10년: "107.5%", 체증한도: "500%" },
    { 보험사: "하나생명", 상품명: "하나로100UP", 보험료_일반: 135600, 보험료_간편: 148700, 환급률_7년: "100%", 환급률_10년: "107.5%", 체증한도: "611%" },
    { 보험사: "신한라이프", 상품명: "세븐Plus II", 보험료_일반: 143020, 보험료_간편: 157570, 환급률_7년: "100%", 환급률_10년: "107.5%", 체증한도: "700%" },
    { 보험사: "DB생명", 상품명: "700", 보험료_일반: 152200, 보험료_간편: 248200, 환급률_7년: "100%", 환급률_10년: "107%", 체증한도: "700%" },
    { 보험사: "교보생명", 상품명: "K-밸류업", 보험료_일반: 151900, 보험료_간편: 159200, 환급률_7년: "100%", 환급률_10년: "107.5%", 체증한도: "640%" },
    { 보험사: "농협생명", 상품명: "스텝업700", 보험료_일반: 166600, 보험료_간편: 172200, 환급률_7년: "100%", 환급률_10년: "107.7%", 체증한도: "700%" },
    { 보험사: "ABL생명", 상품명: "우리WON세븐", 보험료_일반: 206250, 보험료_간편: 223200, 환급률_7년: "100%", 환급률_10년: "107%", 체증한도: "700%" }
  ],
  암주요치료비_손보: [
    { 보험사: "현대해상", 선지급: "70%", 보장범위: "감/기/경/제", 비고: "선지급 70% 최고" },
    { 보험사: "DB손보", 선지급: "50%", 보장범위: "감/기/경/제", 비고: "전이암 보장 우수" },
    { 보험사: "메리츠화재", 선지급: "50%", 보장범위: "감/기", 비고: "모든병원 보장" },
    { 보험사: "삼성화재", 선지급: "50%", 보장범위: "감/기/경/제", 비고: "전이암 호르몬 포함" },
    { 보험사: "KB손보", 선지급: "50%", 보장범위: "감/기/경/제", 비고: "수술 매회 보장" }
  ],
  암주요치료비_생보: [
    { 보험사: "미래에셋생명", 보장범위: "감/기/경/제", 비고: "전이암 호르몬포함 가장 우수" },
    { 보험사: "삼성생명", 보장범위: "감/기/경/제", 비고: "선지급50%" },
    { 보험사: "DB생명", 보장범위: "감/기/경/제", 비고: "모든병원+종합병원" }
  ],
  신상품: [
    "삼성생명 혈전용해/제거 인수우대플랜(~3/31)",
    "KB라이프 순환계주요치료비 신규",
    "미래에셋 암주요치료비3종+전이암 신설",
    "라이나 통합심뇌혈관 하이클래스 각3천만",
    "농협 스텝업700 환급률7년100%/10년107.7%",
    "교보 K-밸류업 라이트 연8%체증 최대431%"
  ]
};

// ============================================
// 구글시트 인증 설정
// ============================================
let sheets = null;
if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY && GOOGLE_SPREADSHEET_ID) {
  try {
    const sheetsAuth = new google.auth.JWT(GOOGLE_SERVICE_ACCOUNT_EMAIL, null, GOOGLE_PRIVATE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
    sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
    console.log('📊 [Google Sheets] 연동 완료');
  } catch (e) { console.error('❌ [Google Sheets] 실패:', e.message); }
} else { console.log('⚠️ [Google Sheets] 미설정'); }

// ============================================
// RAG
// ============================================
let ragChunks = [];
try { ragChunks = JSON.parse(fs.readFileSync('./rag_chunks.json', 'utf-8')); console.log(`📚 [RAG] ${ragChunks.length}개 청크`); } catch (e) { console.log('📚 [RAG] 비활성화'); }

const searchRAG = (query, topK = 5) => {
  if (ragChunks.length === 0) return [];
  const keywords = query.toLowerCase().replace(/[^\w가-힣\s]/g, '').split(/\s+/).filter(w => w.length >= 2);
  if (keywords.length === 0) return [];
  const scored = ragChunks.map(chunk => {
    const content = chunk.content.toLowerCase();
    let score = 0;
    for (const keyword of keywords) { score += (content.match(new RegExp(keyword, 'g')) || []).length * 2; if (chunk.book.toLowerCase().includes(keyword)) score += 5; }
    return { ...chunk, score };
  });
  return scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
};
const formatRAGContext = (chunks) => { if (!chunks || chunks.length === 0) return ''; return chunks.map((c, i) => `[참고자료 ${i+1}] ${c.book}\n${c.content.substring(0, 800)}...`).join('\n\n'); };

// ============================================
// 프롬프트
// ============================================
const INSURANCE_EXPERT_FORMULA = `
## 오상열 CFP의 적정 보험금액 공식
- 사망보험금: 연봉x3+부채
- 암진단금: 연봉x2 (최소 1억)
- 뇌혈관/심혈관: 연봉x1
- 실손의료비: 5,000만원
- 기본값: 연봉 5,000만원
`;

const SCHEDULE_INSTRUCTION = `
## 일정 관리
- 오늘 일정: 오전10시 홍길동 상담, 오후12시 성춘향 점심, 오후3시 김연우 증권전달
- 내일 일정: 오전9시 팀미팅, 오후2시 박지성 상담, 오후4:30 세미나
`;

const APP_PROMPT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 20년 경력 보험 전문가입니다.
${INSURANCE_EXPERT_FORMULA}
${SCHEDULE_INSTRUCTION}
## 절대 규칙
1. 한국어만 사용 2. "대표님" 호칭 3. 짧고 간결하게
## 전화 명령: "전화해줘" → "네, 알겠습니다."만 답변`;

const APP_PROMPT_WITH_RAG = `당신은 "지니"입니다. 20년 경력 보험 전문가입니다.
${INSURANCE_EXPERT_FORMULA}
## 참고 자료: {{RAG_CONTEXT}}
한국어만, "대표님" 호칭, 전문적 답변`;

const APP_PROMPT_WITH_CONTEXT = `당신은 "지니"입니다. 보험증권 분석 전문가입니다.
${INSURANCE_EXPERT_FORMULA}
## 분석된 서류: {{ANALYSIS_CONTEXT}}
부족한 보장 구체적 금액 제시, 추천 보험과 보험료, 영업 포인트 제공
한국어만, "대표님" 호칭`;

const APP_PROMPT_WITH_RAG_AND_CONTEXT = `당신은 "지니"입니다. 보험증권 분석 및 맞춤 추천 전문가입니다.
${INSURANCE_EXPERT_FORMULA}
## 참고 자료: {{RAG_CONTEXT}}
## 분석된 서류: {{ANALYSIS_CONTEXT}}
한국어만, "대표님" 호칭, 구체적 숫자 제시`;

const PHONE_GENIE_PROMPT = `당신은 "지니"입니다. {{AGENT_NAME}} 설계사님의 AI 전화비서입니다.
설계사: {{AGENT_NAME}}, 고객: {{CUSTOMER_NAME}}, 목적: {{CALL_PURPOSE}}
## 최우선: 1. 고객 말 안 끊기 2. "고객님" 호칭 3. 짧게 대화
## 시작: "안녕하세요, {{AGENT_NAME}} 설계사님의 AI비서 지니입니다. 잠시 통화 괜찮으실까요?"
동의→목적진행, 거부→"다음에 다시 전화드리겠습니다. 좋은 하루 되세요!"
## 시나리오: 상담예약(일정잡기), 연체안내(통장확인), 생일축하, 지니소개, 만기안내, 안부전화
## 종료멘트: "좋은 하루 되세요!" 포함`;

// ============================================
// 구글시트 API
// ============================================
app.get('/api/sheets/status', async (req, res) => {
  try {
    if (!sheets) return res.json({ success: false, connected: false, error: '미설정' });
    const response = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID });
    res.json({ success: true, connected: true, title: response.data.properties.title });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.get('/api/sheets/customers', async (req, res) => {
  try {
    if (!sheets) return res.json({ success: false, error: '미설정' });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: 'Sheet1!A:H' });
    const rows = response.data.values || [];
    const customers = rows.slice(1).map((row, i) => ({ id: row[0]||`${i+1}`, name: row[1]||'', phone: row[2]||'', email: row[3]||'', company: row[4]||'', position: row[5]||'', registeredDate: row[6]||'', memo: row[7]||'' })).filter(c => c.name);
    res.json({ success: true, customers, total: customers.length });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.post('/api/sheets/customers', async (req, res) => {
  try {
    if (!sheets) return res.json({ success: false, error: '미설정' });
    const { name, phone, email, company, position, memo } = req.body;
    if (!name || !phone) return res.json({ success: false, error: '이름과 전화번호 필수' });
    const cnt = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: 'Sheet1!A:A' });
    const newId = (cnt.data.values || []).length;
    const today = new Date().toISOString().split('T')[0];
    await sheets.spreadsheets.values.append({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: 'Sheet1!A:H', valueInputOption: 'USER_ENTERED', requestBody: { values: [[newId.toString(), name, phone, email||'', company||'', position||'', today, memo||'']] } });
    res.json({ success: true, message: '추가 완료' });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.put('/api/sheets/customers/:id', async (req, res) => {
  try {
    if (!sheets) return res.json({ success: false, error: '미설정' });
    const { id } = req.params;
    const { name, phone, email, company, position, memo } = req.body;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: 'Sheet1!A:H' });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row, i) => i > 0 && row[0] === id);
    if (rowIndex === -1) return res.json({ success: false, error: '고객 없음' });
    const e = rows[rowIndex];
    const updated = [id, name||e[1], phone||e[2], email!==undefined?email:e[3], company!==undefined?company:e[4], position!==undefined?position:e[5], e[6], memo!==undefined?memo:e[7]];
    await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: `Sheet1!A${rowIndex+1}:H${rowIndex+1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [updated] } });
    res.json({ success: true, message: '수정 완료' });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.delete('/api/sheets/customers/:id', async (req, res) => {
  try {
    if (!sheets) return res.json({ success: false, error: '미설정' });
    const { id } = req.params;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: 'Sheet1!A:A' });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row, i) => i > 0 && row[0] === id);
    if (rowIndex === -1) return res.json({ success: false, error: '고객 없음' });
    const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID });
    const sheetId = sheetInfo.data.sheets[0].properties.sheetId;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: GOOGLE_SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex+1 } } }] } });
    res.json({ success: true, message: '삭제 완료' });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.get('/api/sheets/download', async (req, res) => {
  try {
    if (!sheets) return res.json({ success: false, error: '미설정' });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: 'Sheet1!A:H' });
    const rows = response.data.values || [];
    const csv = rows.map(row => row.map(cell => `"${(cell||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
    res.send('\uFEFF' + csv);
  } catch (error) { res.json({ success: false, error: error.message }); }
});

// ============================================
// 기본 엔드포인트
// ============================================
app.get('/', (req, res) => {
  res.json({ status: 'AI지니 서버 실행 중!', version: '22.0 - Claude Vision 보험분석', insuranceDB: true, endpoints: { insurance: ['/api/analyze-insurance'] } });
});

app.post('/api/rag-search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.json({ success: false, error: '검색어 없음' });
    const results = searchRAG(query, 5);
    res.json({ success: true, query, results: results.map(r => ({ book: r.book, score: r.score, preview: r.content.substring(0, 200) })), context: formatRAGContext(results) });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

// ============================================
// 🆕 Claude Vision 보험분석 + 상품추천
// ============================================
app.post('/api/analyze-insurance', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { fileName, fileType } = req.body;
    if (!file) return res.json({ success: false, error: '파일이 없습니다.' });
    console.log('🏥 [보험분석] Claude Vision 시작:', fileName);
    const base64Data = file.buffer.toString('base64');
    const mimeType = file.mimetype || 'image/jpeg';
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: `당신은 대한민국 최고의 보험 전문 분석가이자 20년 경력 CFP입니다.
이 서류를 분석하고 보험 상품을 추천해주세요.

## 서류 분석
- 보험증권: 모든 특약, 보장금액, 보험료 추출
- 요양급여내역서: 질병코드, 투약, 수술이력
- 건강검진: 이상소견 추출

## 보장 Gap (6대 영역)
1. 사망보장 2. 암보장 3. 뇌혈관 4. 심장 5. 입원/수술 6. 실손

## 상품추천 DB (보험료 최저가 순)
${JSON.stringify(INSURANCE_DB, null, 2)}

## 출력 (마크다운)
# 📋 ARK-Genie 보험분석 리포트

## 📄 서류 분석
(서류종류, 핵심내용)

## 🔍 현재 보장 현황
| 보장항목 | 보장금액 | 상태 |
|---------|---------|------|

## ⚠️ 보장 Gap
| 부족 보장 | 긴급도 | 설명 |
|----------|--------|------|

## 🎯 추천 TOP 3
### 1순위: [보험사] [상품명]
- 보험료/환급률/추천이유

## 💬 고객 상담 스크립트
> 설계사가 바로 사용할 설득 문구 3~5문장

## ⚕️ 인수심사 참고

---
*ARK-Genie v22.0 | ${new Date().toLocaleDateString('ko-KR')}*` }
        ]
      }]
    });
    const analysisReport = response.content[0].text;
    console.log('✅ [보험분석] 완료:', fileName);
    global.lastInsuranceAnalysis = { report: analysisReport, fileName, timestamp: new Date().toISOString() };
    res.json({ success: true, analysis: analysisReport, fileName, fileType, timestamp: new Date().toISOString(), engine: 'claude-vision' });
  } catch (error) {
    console.error('❌ [보험분석] 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// 고객발굴 OCR
// ============================================
app.post('/api/analyze-prospect', async (req, res) => {
  try {
    const { image, imageType } = req.body;
    if (!image) return res.json({ success: false, error: '이미지 없음' });
    const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: `OCR 전문가. ${imageType} 분석. JSON 반환.` }, { role: 'user', content: [{ type: 'text', text: '정보 추출' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } }] }], max_tokens: 2000, temperature: 0.1 })
    });
    const data = await response.json();
    if (data.choices?.[0]) { res.json({ success: true, raw: data.choices[0].message.content }); }
    else { res.json({ success: false, error: 'API 응답 없음' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.post('/api/generate-prospect-message', async (req, res) => {
  try {
    const { prospectData, messageType } = req.body;
    if (!prospectData) return res.json({ success: false, error: '데이터 없음' });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: `영업 메시지 작성. 데이터: ${JSON.stringify(prospectData)}` }, { role: 'user', content: `${messageType} 메시지 작성` }], max_tokens: 1000 })
    });
    const data = await response.json();
    if (data.choices?.[0]) { res.json({ success: true, message: data.choices[0].message.content }); }
    else { res.json({ success: false, error: 'API 응답 없음' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});

// ============================================
// 채팅 API (보험분석 컨텍스트 연동)
// ============================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    console.log('💬 [Chat]', message?.substring(0, 50));
    let systemPrompt = APP_PROMPT;
    if (global.lastInsuranceAnalysis) {
      systemPrompt = APP_PROMPT_WITH_CONTEXT.replace('{{ANALYSIS_CONTEXT}}', global.lastInsuranceAnalysis.report);
    }
    if (ragChunks.length > 0) {
      const ragResults = searchRAG(message, 3);
      if (ragResults.length > 0) {
        const ragContext = formatRAGContext(ragResults);
        if (global.lastInsuranceAnalysis) { systemPrompt = APP_PROMPT_WITH_RAG_AND_CONTEXT.replace('{{RAG_CONTEXT}}', ragContext).replace('{{ANALYSIS_CONTEXT}}', global.lastInsuranceAnalysis.report); }
        else { systemPrompt = APP_PROMPT_WITH_RAG.replace('{{RAG_CONTEXT}}', ragContext); }
      }
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: systemPrompt }, ...(context||[]), { role: 'user', content: message }], max_tokens: 1000, temperature: 0.7 })
    });
    const data = await response.json();
    if (data.choices?.[0]) { res.json({ success: true, response: data.choices[0].message.content }); }
    else { res.json({ success: false, error: 'API 응답 없음' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});

// ============================================
// 이미지/파일 분석
// ============================================
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { image, prompt } = req.body;
    if (!image) return res.json({ success: false, error: '이미지 없음' });
    const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: prompt || '보험증권 분석' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } }] }], max_tokens: 2000 })
    });
    const data = await response.json();
    if (data.choices?.[0]) { res.json({ success: true, analysis: data.choices[0].message.content }); }
    else { res.json({ success: false, error: 'API 응답 없음' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.post('/api/analyze-file', async (req, res) => {
  try {
    const { file, fileName, fileType, prompt } = req.body;
    if (!file) return res.json({ success: false, error: '파일 없음' });
    const base64Data = file.includes('base64,') ? file.split('base64,')[1] : file;
    const isImage = fileType && (fileType.startsWith('image/') || fileType.includes('image'));
    if (isImage) {
      console.log('🏥 [보험분석] Claude Vision 이미지 분석:', fileName, 'fileType:', fileType);
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const cvResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: (['image/jpeg','image/png','image/gif','image/webp'].includes(fileType)) ? fileType : 'image/jpeg', data: base64Data } },
          { type: 'text', text: `당신은 대한민국 최고의 보험 전문 분석가이자 20년 경력 CFP입니다. 이 서류를 분석하고 보험 상품을 추천해주세요.

## 서류 분석
- 보험증권: 모든 특약, 보장금액, 보험료 추출
- 요양급여내역서: 질병코드, 투약, 수술이력
- 건강검진: 이상소견 추출

## 보장 Gap (6대 영역)
1. 사망보장 2. 암보장 3. 뇌혈관 4. 심장 5. 입원/수술 6. 실손

## 상품추천 DB (보험료 최저가 순)
${JSON.stringify(INSURANCE_DB, null, 2)}

## 출력 (마크다운)
# 📋 ARK-Genie 보험분석 리포트

## 📄 서류 분석
(서류종류, 핵심내용)

## 🔍 현재 보장 현황
| 보장항목 | 보장금액 | 상태 |
|---------|---------|------|

## ⚠️ 보장 Gap
| 부족 보장 | 긴급도 | 설명 |
|----------|--------|------|

## 🎯 추천 TOP 3
### 1순위: [보험사] [상품명]
- 보험료/환급률/추천이유

## 💬 고객 상담 스크립트
> 설계사가 바로 사용할 설득 문구 3~5문장

## ⚕️ 인수심사 참고

---
*ARK-Genie v22.0 | ${new Date().toLocaleDateString('ko-KR')}*` }
        ] }]
      });
      const report = cvResponse.content[0].text;
      console.log('✅ [보험분석] Claude Vision 완료:', fileName);
      global.lastInsuranceAnalysis = { report, fileName, timestamp: new Date().toISOString() };
      return res.json({ success: true, analysis: report, fileName, engine: 'claude-vision' });
    }
    let textContent = '';
    try {
      if (fileType === 'application/pdf' || fileName?.endsWith('.pdf')) {
        const b64 = file.includes('base64,') ? file.split('base64,')[1] : file;
        const pdfData = await pdfParse(Buffer.from(b64, 'base64'));
        textContent = pdfData.text;
        if (textContent.length < 200) return res.json({ success: true, analysis: '⚠️ 스캔 PDF - 사진으로 업로드해주세요', hint: 'scan_pdf' });
      } else {
        textContent = Buffer.from(file.includes('base64,') ? file.split('base64,')[1] : file, 'base64').toString('utf-8');
      }
    } catch (e) { return res.json({ success: false, error: 'PDF 읽기 실패' }); }
    if (!textContent?.trim()) return res.json({ success: false, error: '텍스트 추출 실패' });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: '20년 경력 보험 전문가' }, { role: 'user', content: prompt || `문서 분석:\n${textContent.substring(0, 30000)}` }], max_tokens: 3000 })
    });
    const data = await response.json();
    if (data.choices?.[0]) { res.json({ success: true, analysis: data.choices[0].message.content, fileName }); }
    else { res.json({ success: false, error: 'API 응답 없음' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});

// ============================================
// 카카오톡
// ============================================
app.post('/api/kakao/send', async (req, res) => {
  try {
    const { message, customerName } = req.body;
    if (!message) return res.json({ success: false, error: '메시지 필요' });
    if (!KAKAO_ACCESS_TOKEN) return res.json({ success: false, error: '카카오 토큰 미설정' });
    const response = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${KAKAO_ACCESS_TOKEN}` },
      body: new URLSearchParams({ template_object: JSON.stringify({ object_type: 'text', text: message, link: { web_url: 'https://ark-genie1-j27p.vercel.app', mobile_web_url: 'https://ark-genie1-j27p.vercel.app' } }) })
    });
    const data = await response.json();
    if (response.ok || data.result_code === 0) { res.json({ success: true, message: '발송 완료' }); }
    else { res.json({ success: false, error: data.msg || '실패' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});

app.get('/api/kakao/status', (req, res) => {
  res.json({ success: true, kakaoEnabled: !!KAKAO_ACCESS_TOKEN, channelId: KAKAO_CHANNEL_ID || '미설정' });
});

app.get('/api/kakao/test', async (req, res) => {
  try {
    if (!KAKAO_ACCESS_TOKEN) return res.json({ success: false, error: '토큰 미설정' });
    const testMsg = '🎉 AI지니 테스트!\n' + new Date().toLocaleString('ko-KR');
    const response = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${KAKAO_ACCESS_TOKEN}` },
      body: new URLSearchParams({ template_object: JSON.stringify({ object_type: 'text', text: testMsg, link: { web_url: 'https://ark-genie1-j27p.vercel.app', mobile_web_url: 'https://ark-genie1-j27p.vercel.app' } }) })
    });
    const data = await response.json();
    if (response.ok || data.result_code === 0) { res.json({ success: true, message: '발송 성공!' }); }
    else { res.json({ success: false, error: data.msg || '실패' }); }
  } catch (error) { res.json({ success: false, error: error.message }); }
});
app.get('/api/kakao/test', async (req, res) => {
  try {
    if (!KAKAO_ACCESS_TOKEN) return res.json({ success: false, error: '카카오 액세스 토큰이 설정되지 않았습니다.' });
    const testMessage = '🎉 AI지니 카카오톡 테스트 성공!\n\n발송 시간: ' + new Date().toLocaleString('ko-KR');
    const response = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${KAKAO_ACCESS_TOKEN}` },
      body: new URLSearchParams({ template_object: JSON.stringify({ object_type: 'text', text: testMessage, link: { web_url: 'https://ark-genie1-j27p.vercel.app', mobile_web_url: 'https://ark-genie1-j27p.vercel.app' } }) })
    });
    const data = await response.json();
    if (response.ok || data.result_code === 0) {
      res.json({ success: true, message: '카카오톡 발송 성공!' });
    } else {
      res.json({ success: false, error: data.msg || '실패', code: data.code });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// Twilio 전화 관련 API
// ============================================
app.post('/api/call', async (req, res) => {
  try {
    const { phoneNumber, customerName, purpose } = req.body;
    if (!phoneNumber) return res.json({ success: false, error: '전화번호가 없습니다.' });
    console.log('📞 [Call] 발신 요청:', phoneNumber, customerName, '목적:', purpose);
    const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const call = await twilioClient.calls.create({
      url: `https://${SERVER_DOMAIN}/incoming-call?purpose=${encodeURIComponent(purpose || '상담예약')}&customerName=${encodeURIComponent(customerName || '')}`,
      to: phoneNumber, from: TWILIO_NUMBER,
      statusCallback: `https://${SERVER_DOMAIN}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    callStatusMap.set(call.sid, { status: 'initiated', phoneNumber, customerName });
    callContextMap.set(call.sid, { customerName, purpose });
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/call-status/:callSid', (req, res) => {
  const status = callStatusMap.get(req.params.callSid);
  res.json({ success: true, status: status || { status: 'unknown' } });
});

app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
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
  const params = JSON.stringify({ purpose, customerName });
  const encodedParams = encodeURIComponent(params);
  const streamUrl = `wss://${SERVER_DOMAIN}/media-stream?data=${encodedParams}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
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
  console.log('📡 버전: 22.0 - Claude Vision 보험분석 엔진');
});

// ============================================
// WebSocket 서버
// ============================================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/media-stream') {
    let purpose = '상담예약';
    let customerName = '';
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let endCallTimer = null;
    let sessionInitialized = false;
    
    const initializeSession = () => {
      if (sessionInitialized) return;
      sessionInitialized = true;
      const context = callContextMap.get(callSid);
      if (context) {
        purpose = context.purpose || '상담예약';
        customerName = context.customerName || '';
      }
      const agentName = '오상열';
      const expiryDate = '다음 달';
      const phonePrompt = PHONE_GENIE_PROMPT
        .replace(/\{\{CALL_PURPOSE\}\}/g, purpose)
        .replace(/\{\{CUSTOMER_NAME\}\}/g, customerName || '고객')
        .replace(/\{\{AGENT_NAME\}\}/g, agentName)
        .replace(/\{\{EXPIRY_DATE\}\}/g, expiryDate);
      
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'], instructions: phonePrompt, voice: 'shimmer',
          input_audio_format: 'g711_ulaw', output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1', language: 'ko' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 500, silence_duration_ms: 2000 }
        }
      }));
      setTimeout(() => {
        openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
      }, 500);
    };
    
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
    });

    openaiWs.on('open', () => {
      console.log('✅ [Realtime] OpenAI 연결됨 (전화 모드)');
      if (callSid) initializeSession();
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.type === 'response.audio.delta' && event.delta) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
        }
        if (event.type === 'input_audio_buffer.speech_started') {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        if (event.type === 'response.audio_transcript.done') {
          console.log('🤖 지니(전화):', event.transcript);
          const transcript = event.transcript || '';
          const isEnding = transcript.includes('안녕히 계세요') || transcript.includes('좋은 하루') || transcript.includes('감사합니다') || transcript.includes('예약 완료');
          if (isEnding && !endCallTimer) {
            endCallTimer = setTimeout(async () => {
              if (callSid) {
                try {
                  const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
                  await twilioClient.calls(callSid).update({ status: 'completed' });
                } catch (e) { console.error('통화 종료 에러:', e); }
              }
            }, 15000);
          }
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('👤 고객(전화):', event.transcript);
          const transcript = event.transcript || '';
          const isARS = transcript.includes('없는 번호') || transcript.includes('연결이 되지') || transcript.includes('전화를 받지') || transcript.length < 3;
          if (!isARS && endCallTimer) { clearTimeout(endCallTimer); endCallTimer = null; }
        }
        if (event.type === 'error') console.error('❌ [Realtime] OpenAI 에러:', event.error);
      } catch (e) { console.error('OpenAI 메시지 파싱 에러:', e); }
    });

    openaiWs.on('error', (err) => console.error('❌ [Realtime] OpenAI WebSocket 에러:', err.message));
    openaiWs.on('close', () => console.log('🔌 [Realtime] OpenAI 연결 종료'));

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            console.log('📞 [Realtime] Twilio Stream 시작:', streamSid, 'CallSid:', callSid);
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) initializeSession();
            break;
          case 'media':
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            }
            break;
          case 'stop':
            console.log('📞 [Realtime] Twilio Stream 종료');
            if (openaiWs) openaiWs.close();
            break;
        }
      } catch (e) { console.error('Twilio 메시지 파싱 에러:', e); }
    });

    ws.on('close', () => { if (openaiWs) openaiWs.close(); });
    return;
  }

  // ============================================
  // 앱지니용 WebSocket
  // ============================================
  let openaiWs = null;
  let lastAssistantItem = null;
  let currentAnalysisContextList = [];

  const formatAnalysisContext = (contextList) => {
    if (!contextList || contextList.length === 0) return '';
    return contextList.map((ctx, idx) => `=== [${idx + 1}번 파일] ${ctx.fileName} ===\n${ctx.analysis}`).join('\n\n');
  };

  const buildPromptWithRAG = (analysisContextList, userMessage = '') => {
    const hasAnalysis = analysisContextList && analysisContextList.length > 0;
    const hasRAG = ragChunks.length > 0;
    let ragContext = '';
    if (hasRAG && userMessage) {
      const ragResults = searchRAG(userMessage, 3);
      if (ragResults.length > 0) { ragContext = formatRAGContext(ragResults); }
    }
    if (hasAnalysis && ragContext) {
      return APP_PROMPT_WITH_RAG_AND_CONTEXT.replace('{{RAG_CONTEXT}}', ragContext).replace('{{ANALYSIS_CONTEXT}}', formatAnalysisContext(analysisContextList));
    } else if (ragContext) {
      return APP_PROMPT_WITH_RAG.replace('{{RAG_CONTEXT}}', ragContext);
    } else if (hasAnalysis) {
      return APP_PROMPT_WITH_CONTEXT.replace('{{ANALYSIS_CONTEXT}}', formatAnalysisContext(analysisContextList));
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
        } else if (msg.analysisContext) {
          currentAnalysisContextList = [msg.analysisContext];
        }
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN && currentAnalysisContextList.length > 0) {
          openaiWs.send(JSON.stringify({ type: 'session.update', session: { instructions: buildPromptWithRAG(currentAnalysisContextList) } }));
        }
        return;
      }

      if (msg.type === 'start_app') {
        console.log('📱 앱 Realtime 시작');
        if (msg.analysisContextList && msg.analysisContextList.length > 0) {
          currentAnalysisContextList = msg.analysisContextList;
        } else if (msg.analysisContext) {
          currentAnalysisContextList = [msg.analysisContext];
        }

        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
        });

        openaiWs.on('open', () => {
          console.log('✅ OpenAI Realtime API 연결됨! 모드: 앱');
          let promptToUse = buildPromptWithRAG(currentAnalysisContextList);
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'], instructions: promptToUse, voice: 'shimmer',
              input_audio_format: 'pcm16', output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1', language: 'ko' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1500 }
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
                openaiWs.send(JSON.stringify({ type: 'conversation.item.truncate', item_id: lastAssistantItem, content_index: 0, audio_end_ms: 0 }));
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
          } catch (e) { console.error('OpenAI 메시지 에러:', e); }
        });

        openaiWs.on('error', (err) => {
          console.error('❌ OpenAI 에러:', err.message);
          ws.send(JSON.stringify({ type: 'error', error: err.message }));
        });
        openaiWs.on('close', () => console.log('🔌 OpenAI 연결 종료 (앱)'));
      }

      if (msg.type === 'audio' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.data }));
      }

      if (msg.type === 'stop') {
        console.log('📱 앱 Realtime 종료');
        if (openaiWs) openaiWs.close();
      }
    } catch (e) { console.error('앱 메시지 에러:', e); }
  });

  ws.on('close', () => {
    console.log('📱 앱 WebSocket 종료');
    if (openaiWs) openaiWs.close();
  });
});

console.log('✅ 서버 초기화 완료!');
