const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `당신은 "지니"입니다. 오원트금융연구소의 AI 개인비서입니다.

[신원]
- 이름: 지니
- 소속: 오원트금융연구소
- 역할: 오상열 대표님(CFP, 국제공인재무설계사)의 AI 개인비서
- 성격: 친절하고 따뜻하며 전문적

[통화 규칙]
1. 항상 한국어로 답변
2. 짧고 간결하게 (1-2문장)
3. 상대방이 5초 이상 말이 없으면 "혹시 더 궁금하신 점 있으세요?"
4. 상담 예약 요청시 이름, 연락처, 희망 일시 확인

[첫 인사]
"안녕하세요! 오원트금융연구소 오상열 대표님의 AI비서 지니입니다. 무엇을 도와드릴까요?"`;

app.post('/incoming-call', (req, res) => {
    console.log('전화 연결됨!');
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
    </Connect>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
});

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
        console.log('전화 발신:', call.sid);
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('발신 에러:', error);
        res.json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => res.send('AI지니 서버 실행 중!'));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`AI지니 서버 시작! (포트 ${PORT})`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Twilio Media Stream 연결됨!');
    
    let openaiWs = null;
    let streamSid = null;
    let lastAssistantItem = null;

    const connectOpenAI = () => {
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        openaiWs.on('open', () => {
            console.log('OpenAI Realtime API 연결됨!');
            
            openaiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: SYSTEM_PROMPT,
                    voice: 'alloy',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500
                    }
                }
            }));

            setTimeout(() => {
                openaiWs.send(JSON.stringify({
                    type: 'response.create',
                    response: {
                        modalities: ['text', 'audio'],
                        instructions: '첫 인사를 해주세요.'
                    }
                }));
            }, 500);
        });

        openaiWs.on('message', (data) => {
            const event = JSON.parse(data.toString());

            if (event.type === 'response.audio.delta' && event.delta && streamSid) {
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
                console.log('사용자 말하기 시작 - AI 중단');
                if (lastAssistantItem) {
                    openaiWs.send(JSON.stringify({
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: 0
                    }));
                }
                ws.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));
            }

            if (event.type === 'response.audio_transcript.done') {
                console.log('지니:', event.transcript);
            }
        });

        openaiWs.on('error', (err) => console.error('OpenAI 에러:', err.message));
        openaiWs.on('close', () => console.log('OpenAI 연결 종료'));
    };

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log('Stream 시작:', streamSid);
            connectOpenAI();
        }
        
        if (msg.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload
            }));
        }
    });

    ws.on('close', () => {
        console.log('Twilio 연결 종료');
        if (openaiWs) openaiWs.close();
    });
});
