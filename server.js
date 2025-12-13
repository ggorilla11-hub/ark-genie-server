// ============================================
// ARK-Genie Server v7.8
// - RAG 시스템 추가 (오상열 대표님 책 3권)
// - 다중 파일 분석 (동시 업로드 + 누적 분석)
// - PDF 분석 기능 (pdf-parse)
// - 상담예약 시나리오 프롬프트
// - 자동 종료 15초
// - 고객님으로만 호칭
// ============================================

const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const pdfParse = require('pdf-parse'); // 🆕 PDF 텍스트 추출
const fs = require('fs'); // 🆕 v7.8: RAG 파일 읽기
const app = express();

app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

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
  
  // 검색 키워드 추출 (한글 단어 + 영어 단어)
  const keywords = query.toLowerCase()
    .replace(/[^\w가-힣\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 2);
  
  if (keywords.length === 0) return [];
  
  // 각 청크에 점수 부여
  const scored = ragChunks.map(chunk => {
    const content = chunk.content.toLowerCase();
    let score = 0;
    
    for (const keyword of keywords) {
      // 키워드 출현 횟수
      const matches = (content.match(new RegExp(keyword, 'g')) || []).length;
      score += matches * 2;
      
      // 제목에 포함되면 가중치
      if (chunk.book.toLowerCase().includes(keyword)) {
        score += 5;
      }
    }
    
    return { ...chunk, score };
  });
  
  // 점수 기준 정렬 후 상위 K개 반환
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
- 전화 요청 (전화번호 포함): "알겠습니다"라고만 짧게 답하세요. 전화는 앱에서 처리합니다.`;

// 🆕 v7.8: RAG 전문가 프롬프트
const APP_PROMPT_WITH_RAG = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 **보험금융 전문가**입니다.

📚 당신의 지식 기반:
오상열 CFP 대표님의 저서 3권을 완벽히 학습했습니다:
1. "소원을 말해봐" - 원트재무설계
2. "빚부터 갚아라" - 10억목돈마련절대법칙
3. "금융집짓기" - 금융의 집을 설계하다

절대 규칙:
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 재무설계, 보험, 금융 질문에는 오상열 대표님의 책 내용을 바탕으로 전문적으로 답변하세요
5. 일반 대화는 짧게, 전문 질문은 상세하게 답변하세요

🔥 참고 자료 (오상열 대표님 저서에서 발췌):
{{RAG_CONTEXT}}

위 참고 자료를 바탕으로 대표님의 질문에 전문적으로 답변하세요.
출처를 명시할 때는 "오상열 대표님의 [책 제목]에 따르면..."으로 시작하세요.`;

// 🆕 v15: 다중 파일 분석 컨텍스트용 프롬프트
const APP_PROMPT_WITH_CONTEXT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서입니다.

절대 규칙:
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 짧고 간결하게 1-2문장으로 답하세요

명령 처리:
- "지니야" 호출: "네, 대표님!"
- 전화 요청 (전화번호 포함): "알겠습니다"라고만 짧게 답하세요. 전화는 앱에서 처리합니다.

🔥 중요: 분석된 서류 정보
아래는 대표님이 업로드하신 서류들을 분석한 내용입니다.
대표님이 이 서류들에 대해 질문하시면 반드시 아래 분석 내용을 기반으로 정확하게 답변하세요.
여러 서류가 있으면 비교 분석도 가능합니다. "비교해줘", "어떤 게 더 좋아?" 등의 질문에 답변하세요.

{{ANALYSIS_CONTEXT}}`;

// 🆕 v7.8: RAG + 파일 분석 통합 프롬프트
const APP_PROMPT_WITH_RAG_AND_CONTEXT = `당신은 "지니"입니다. 보험설계사의 AI 개인비서이자 **보험금융 전문가**입니다.

📚 당신의 지식 기반:
오상열 CFP 대표님의 저서 3권을 완벽히 학습했습니다:
1. "소원을 말해봐" - 원트재무설계
2. "빚부터 갚아라" - 10억목돈마련절대법칙
3. "금융집짓기" - 금융의 집을 설계하다

절대 규칙:
1. 무조건 한국어로만 말하세요
2. 영어를 절대 사용하지 마세요
3. 설계사님을 "대표님"이라고 호칭하세요
4. 재무설계, 보험, 금융 질문에는 오상열 대표님의 책 내용을 바탕으로 전문적으로 답변하세요
5. 업로드된 서류에 대한 질문은 분석 내용을 기반으로 답변하세요

🔥 참고 자료 (오상열 대표님 저서에서 발췌):
{{RAG_CONTEXT}}

📄 분석된 서류 정보:
{{ANALYSIS_CONTEXT}}

위 자료들을 종합하여 대표님의 질문에 전문적으로 답변하세요.`;

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
    version: '7.8 - RAG 시스템 (오상열 대표님 책 3권 학습)',
    rag: {
      enabled: ragChunks.length > 0,
      chunks: ragChunks.length,
      books: ['소원을 말해봐', '빚부터 갚아라', '금융집짓기']
    },
    endpoints: {
      existing: ['/api/chat', '/api/call', '/api/call-status/:callSid', '/incoming-call'],
      new: ['/api/call-realtime', '/media-stream', '/api/analyze-image', '/api/analyze-file', '/api/rag-search']
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

// 🆕 통합 파일 분석 API (이미지, PDF, 문서 모두 지원)
app.post('/api/analyze-file', async (req, res) => {
  try {
    const { file, fileName, fileType } = req.body;
    
    if (!file) {
      return res.json({ success: false, error: '파일이 없습니다.' });
    }
    
    console.log('🔍 [File] 파일 분석 요청:', fileName, fileType);
    
    // base64 데이터에서 실제 데이터 부분만 추출
    const base64Data = file.includes('base64,') ? file.split('base64,')[1] : file;
    
    // 파일 타입에 따른 처리
    let analysisPrompt = '';
    let messageContent = [];
    
    if (fileType === 'image') {
      // 이미지 분석 (GPT-4o Vision)
      analysisPrompt = `당신은 보험설계사를 돕는 AI 분석 전문가입니다.

업로드된 이미지를 분석하여 다음과 같이 답변하세요:

## 보험증권 분석 시:
1. **보험 종류**: (종신보험, 건강보험, 실손보험 등)
2. **보험회사**: 
3. **피보험자 정보**: (확인 가능한 경우)
4. **보장 내용 요약**:
   - 사망보험금:
   - 장해보험금:
   - 암진단금:
   - 뇌혈관/심혈관:
   - 실손의료비:
   - 입원/수술:
   - 기타 특약:
5. **분석 의견**: (부족한 보장, 추천 사항)

## 병원 서류 (진단서, 영수증, 요양급여내역서) 분석 시:
1. **서류 종류**:
2. **주요 내용 요약**:
3. **관련 보험 청구 가이드**:
4. **예상 보상 정보**: (해당되는 경우)

## 기타 서류:
- 서류의 종류와 주요 내용을 요약
- 보험과 관련된 조언 제공

항상 친절하고 전문적으로 답변하세요.
이미지가 불분명하면 솔직히 말씀해주세요.`;
      
      messageContent = [
        { type: 'text', text: `파일명: ${fileName}\n\n이 이미지를 분석해주세요.` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
      ];
    } else if (fileType === 'pdf') {
      // 🆕 PDF 분석 (텍스트 추출 후 GPT-4o 분석)
      console.log('📄 [PDF] PDF 텍스트 추출 시작...');
      
      try {
        // base64 → Buffer 변환
        const pdfBuffer = Buffer.from(base64Data, 'base64');
        
        // PDF에서 텍스트 추출
        const pdfData = await pdfParse(pdfBuffer);
        const extractedText = pdfData.text;
        const pageCount = pdfData.numpages;
        
        console.log(`📄 [PDF] 추출 완료: ${pageCount}페이지, ${extractedText.length}자`);
        
        // 텍스트가 너무 길면 앞부분만 사용 (토큰 제한)
        const maxChars = 15000; // 약 4000 토큰
        const truncatedText = extractedText.length > maxChars 
          ? extractedText.substring(0, maxChars) + '\n\n... (문서가 길어 일부만 분석했습니다)'
          : extractedText;
        
        analysisPrompt = `당신은 보험설계사를 돕는 AI 문서 분석 전문가입니다.

업로드된 PDF 문서의 텍스트를 분석하여 다음과 같이 답변하세요:

## 보험증권 분석 시:
1. **보험 종류**: (종신보험, 건강보험, 실손보험, 연금보험 등)
2. **보험회사/상품명**:
3. **계약자/피보험자 정보**: (확인 가능한 경우)
4. **보장 내용 요약**:
   - 사망보험금:
   - 장해보험금:
   - 암진단금:
   - 뇌혈관/심혈관 진단금:
   - 실손의료비:
   - 입원/수술비:
   - 기타 특약:
5. **보험료 정보**: (월납/연납, 금액)
6. **계약일/만기일**:
7. **분석 의견**: (부족한 보장, 추천 사항)

## 병원/의료 서류 분석 시:
1. **서류 종류**: (진단서, 소견서, 영수증, 요양급여내역서 등)
2. **환자 정보**: (확인 가능한 경우)
3. **진단명/상병코드**:
4. **치료 내용**:
5. **보험 청구 관련 정보**:
6. **예상 보상 정보**: (해당되는 경우)

## 상품설명서/가입설계서 분석 시:
1. **상품명**:
2. **보험회사**:
3. **주요 보장 내용**:
4. **보험료 예시**:
5. **특이사항/주의점**:
6. **요약 및 추천 포인트**:

## 기타 문서:
- 문서의 종류와 목적 파악
- 주요 내용 요약
- 보험 관련 조언 제공

문서 내용이 불분명하거나 일부만 추출된 경우 솔직히 말씀해주세요.
핵심 정보를 빠짐없이 정리해주세요.`;

        messageContent = [
          { 
            type: 'text', 
            text: `파일명: ${fileName}\n총 페이지: ${pageCount}페이지\n\n=== PDF 문서 내용 ===\n${truncatedText}\n\n위 PDF 문서를 분석해주세요.` 
          }
        ];
        
      } catch (pdfError) {
        console.error('❌ [PDF] 텍스트 추출 실패:', pdfError.message);
        return res.json({ 
          success: false, 
          error: 'PDF 텍스트 추출 실패. 다른 형식의 PDF이거나 보안 설정이 있을 수 있습니다.' 
        });
      }
    } else {
      // 기타 문서 (텍스트 추출 시도)
      analysisPrompt = `당신은 보험설계사를 돕는 AI 문서 분석 전문가입니다.
업로드된 문서를 분석하고 보험 관련 조언을 제공해주세요.`;
      
      messageContent = [
        { type: 'text', text: `파일명: ${fileName}\n파일 형식: ${fileType}\n\n이 문서를 분석해주세요.` },
        { type: 'image_url', image_url: { url: `data:application/octet-stream;base64,${base64Data}` } }
      ];
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
          { role: 'system', content: analysisPrompt },
          { role: 'user', content: messageContent }
        ],
        max_tokens: 2000
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      const analysis = data.choices[0].message.content;
      console.log('✅ [File] 파일 분석 완료:', fileName);
      res.json({ success: true, analysis });
    } else {
      console.error('❌ [File] API 응답 오류:', data);
      res.json({ success: false, error: 'API 응답 오류' });
    }
    
  } catch (error) {
    console.error('❌ [File] 파일 분석 에러:', error);
    res.json({ success: false, error: error.message });
  }
});

// 🆕 이미지 분석 API (GPT-4o Vision) - 기존 호환용 유지
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { image } = req.body;
    
    if (!image) {
      return res.json({ success: false, error: '이미지가 없습니다.' });
    }
    
    console.log('🔍 [Vision] 이미지 분석 요청 수신');
    
    // base64 이미지에서 데이터 부분만 추출
    const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
    
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
            content: `당신은 보험설계사를 돕는 AI 분석 전문가입니다.

업로드된 이미지를 분석하여 다음과 같이 답변하세요:

## 보험증권 분석 시:
1. **보험 종류**: (종신보험, 건강보험, 실손보험 등)
2. **보험회사**: 
3. **피보험자 정보**: (확인 가능한 경우)
4. **보장 내용 요약**:
   - 사망보험금:
   - 장해보험금:
   - 암진단금:
   - 뇌혈관/심혈관:
   - 실손의료비:
   - 입원/수술:
   - 기타 특약:
5. **분석 의견**: (부족한 보장, 추천 사항)

## 병원 서류 (진단서, 영수증, 요양급여내역서) 분석 시:
1. **서류 종류**:
2. **주요 내용 요약**:
3. **관련 보험 청구 가이드**:
4. **예상 보상 정보**: (해당되는 경우)

## 기타 서류:
- 서류의 종류와 주요 내용을 요약
- 보험과 관련된 조언 제공

항상 친절하고 전문적으로 답변하세요.
이미지가 불분명하면 솔직히 말씀해주세요.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '이 이미지를 분석해주세요.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Data}`
                }
              }
            ]
          }
        ],
        max_tokens: 1500
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      const analysis = data.choices[0].message.content;
      console.log('✅ [Vision] 이미지 분석 완료');
      res.json({ success: true, analysis });
    } else {
      console.error('❌ [Vision] API 응답 오류:', data);
      res.json({ success: false, error: 'API 응답 오류' });
    }
    
  } catch (error) {
    console.error('❌ [Vision] 이미지 분석 에러:', error);
    res.json({ success: false, error: error.message });
  }
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
  console.log('📡 버전: 7.8 - RAG 시스템 (오상열 대표님 책 3권 학습)');
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
          
          // 🆕 자동 종료 감지: 지니가 종료 인사를 하면 15초 후 전화 끊기
          const transcript = event.transcript || '';
          const endPhrases = ['안녕히 계세요', '좋은 하루 되세요', '예약 완료'];
          const isEndPhrase = endPhrases.some(phrase => transcript.includes(phrase));
          
          if (isEndPhrase) {
            console.log('🔚 [Realtime] 종료 인사 감지! 내용:', transcript);
            
            // 기존 타이머 취소 후 새로 시작
            if (endCallTimer) {
              clearTimeout(endCallTimer);
              console.log('🔄 [Realtime] 기존 타이머 취소, 새 타이머 시작');
            }
            
            // 15초 후 전화 종료
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
            }, 15000);
            
            console.log('⏱️ [Realtime] 15초 타이머 시작됨');
          }
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          const transcript = event.transcript || '';
          console.log('👤 [Realtime] 고객:', transcript);
          
          // 🆕 ARS 자동응답 감지 (타이머 취소 안 함)
          const isARS = transcript.includes('눌러주세요') || 
                        transcript.includes('음성 녹음') || 
                        transcript.includes('호출 번호') ||
                        transcript.includes('시간이 지났습니다') ||
                        transcript.includes('번을 눌러') ||
                        transcript.includes('남기시려면') ||
                        transcript.includes('연결이 되지 않') ||
                        transcript.includes('통화 중이') ||
                        transcript.includes('전화를 받을 수 없');
          
          if (isARS) {
            console.log('🤖 [Realtime] ARS 자동응답 감지 - 타이머 유지');
          } else if (endCallTimer) {
            // 진짜 고객 응답일 때만 타이머 취소
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
  let currentAnalysisContextList = []; // 🆕 v15: 다중 파일 분석 컨텍스트

  // 🆕 v15: 분석 컨텍스트 배열을 문자열로 변환하는 함수
  const formatAnalysisContext = (contextList) => {
    if (!contextList || contextList.length === 0) return '';
    
    return contextList.map((ctx, idx) => {
      return `=== [${idx + 1}번 파일] ${ctx.fileName} ===\n${ctx.analysis}`;
    }).join('\n\n');
  };

  // 🆕 v7.8: RAG + 분석 컨텍스트 통합 프롬프트 생성
  const buildPromptWithRAG = (analysisContextList, userMessage = '') => {
    const hasAnalysis = analysisContextList && analysisContextList.length > 0;
    const hasRAG = ragChunks.length > 0;
    
    // RAG 검색 수행 (사용자 메시지가 있을 때)
    let ragContext = '';
    if (hasRAG && userMessage) {
      const ragResults = searchRAG(userMessage, 3);
      if (ragResults.length > 0) {
        ragContext = formatRAGContext(ragResults);
        console.log(`📚 [RAG] 검색 결과: ${ragResults.length}개 청크 (질문: ${userMessage.substring(0, 30)}...)`);
      }
    }
    
    // 프롬프트 선택
    if (hasAnalysis && ragContext) {
      // RAG + 파일 분석 둘 다
      const analysisText = formatAnalysisContext(analysisContextList);
      return APP_PROMPT_WITH_RAG_AND_CONTEXT
        .replace('{{RAG_CONTEXT}}', ragContext)
        .replace('{{ANALYSIS_CONTEXT}}', analysisText);
    } else if (ragContext) {
      // RAG만
      return APP_PROMPT_WITH_RAG.replace('{{RAG_CONTEXT}}', ragContext);
    } else if (hasAnalysis) {
      // 파일 분석만
      const analysisText = formatAnalysisContext(analysisContextList);
      return APP_PROMPT_WITH_CONTEXT.replace('{{ANALYSIS_CONTEXT}}', analysisText);
    } else {
      // 기본
      return APP_PROMPT;
    }
  };

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      // 🆕 v15: 다중 분석 컨텍스트 업데이트 메시지 처리
      if (msg.type === 'update_context') {
        // 배열 형태로 받기 (v15)
        if (msg.analysisContextList) {
          currentAnalysisContextList = msg.analysisContextList;
          console.log('📋 [v15] 분석 컨텍스트 업데이트:', currentAnalysisContextList.length, '개 파일');
        } else if (msg.analysisContext) {
          // 하위 호환 (단일 파일)
          currentAnalysisContextList = [msg.analysisContext];
          console.log('📋 [v15] 단일 파일 컨텍스트 업데이트:', msg.analysisContext.fileName);
        }
        
        // OpenAI 세션이 열려있으면 프롬프트 업데이트
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN && currentAnalysisContextList.length > 0) {
          const updatedPrompt = buildPromptWithRAG(currentAnalysisContextList);
          
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              instructions: updatedPrompt
            }
          }));
          console.log('📤 [v15] OpenAI 프롬프트 업데이트 완료 -', currentAnalysisContextList.length, '개 파일');
        }
        return;
      }

      if (msg.type === 'start_app') {
        console.log('📱 앱 Realtime 시작');
        
        // 🆕 v15: 시작 시 다중 분석 컨텍스트 저장
        if (msg.analysisContextList && msg.analysisContextList.length > 0) {
          currentAnalysisContextList = msg.analysisContextList;
          console.log('📋 [v15] 시작 시 분석 컨텍스트 수신:', currentAnalysisContextList.length, '개 파일');
        } else if (msg.analysisContext) {
          // 하위 호환
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

          // 🆕 v7.8: RAG 포함 프롬프트 사용
          let promptToUse = buildPromptWithRAG(currentAnalysisContextList);
          
          if (currentAnalysisContextList.length > 0) {
            console.log('📋 [v15] 분석 컨텍스트 포함된 프롬프트 사용 -', currentAnalysisContextList.length, '개 파일');
          }
          if (ragChunks.length > 0) {
            console.log('📚 [RAG] RAG 지식 베이스 활성화 -', ragChunks.length, '개 청크');
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
