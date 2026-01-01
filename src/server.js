require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3001;

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Anthropic 클라이언트 초기화
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let tokens = null;

if (process.env.GOOGLE_REFRESH_TOKEN) {
  tokens = {
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    access_token: process.env.GOOGLE_ACCESS_TOKEN || null
  };
  oauth2Client.setCredentials(tokens);
}

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// 고정 헤더
const FIXED_HEADERS = [
  '제품명', '수취인명', '연락처', '은행', '계좌(-)', '예금주',
  '결제금액(원 쓰지 마세요)', '아이디', '주문번호', '주소', '닉네임', '회수이름', '회수연락처', '이미지', '주문일시'
];

// ============================================
// AI 주문 정보 파싱 엔드포인트  
// ============================================
app.post('/api/parse-order', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.trim() === '') {
      return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }

    const prompt = `다음 주문 정보를 분석해서 JSON으로 반환해줘.

규칙:
- 첫 번째 한글 이름(2~4글자) → 수취인명
- 두 번째 한글 이름 → 예금주
- 세 번째 한글 이름 → 회수이름
- 첫 번째 전화번호 → 연락처 (반드시 010-0000-0000 형식으로 변환)
- 두 번째 전화번호 → 회수연락처 (반드시 010-0000-0000 형식으로 변환)
- 은행명(xx은행, xx뱅크 등) → 은행
- 계좌번호 형태(숫자와 하이픈) → 계좌
- 금액(숫자, 쉼표 포함 가능) → 결제금액 (숫자만 추출)
- 영문 아이디 형태 → 아이디
- 긴 숫자열(12자리 이상) → 주문번호
- 주소 형태(시/도, 구/군, 동/읍/면 포함) → 주소
- 제품명/상품명 → 제품명 (보통 첫 줄에 있음)
- 닉네임 형태 → 닉네임

입력:
${text}

반드시 아래 JSON 형식으로만 응답해. 다른 설명 없이 JSON만:
{"제품명":"","수취인명":"","연락처":"","은행":"","계좌":"","예금주":"","결제금액":"","아이디":"","주문번호":"","주소":"","닉네임":"","회수이름":"","회수연락처":""}`;

    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text.trim();
    
    // JSON 파싱 시도
    let parsed;
    try {
      // JSON 블록 추출 (```json ... ``` 형태일 경우 대비)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('JSON 형식을 찾을 수 없습니다.');
      }
    } catch (parseError) {
      console.error('JSON 파싱 오류:', parseError, 'Raw:', responseText);
      return res.status(500).json({ error: 'AI 응답 파싱 실패', raw: responseText });
    }

    res.json({ success: true, data: parsed });

  } catch (error) {
    console.error('AI 파싱 오류:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 헬스 체크
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', authenticated: !!tokens });
});

// ============================================
// OAuth 인증
// ============================================
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    tokens = newTokens;
    oauth2Client.setCredentials(tokens);
    res.send(`<h1>✅ 인증 성공!</h1><pre>GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}</pre>`);
  } catch (error) {
    res.status(500).send('인증 실패: ' + error.message);
  }
});

// ============================================
// 다중 주문 제출 (인덱스 방식)
// ============================================
app.post('/api/submit-orders', upload.array('images', 20), async (req, res) => {
  try {
    if (!tokens) {
      return res.status(401).json({ error: 'Google 인증이 필요합니다.' });
    }

    const manager = req.body.manager;
    const orders = JSON.parse(req.body.orders || '[]');
    const files = req.files || [];
    
    if (!manager) {
      return res.status(400).json({ error: '담당자를 선택해주세요.' });
    }

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = manager;
    
    // 시트 확인/생성
    await ensureSheetExists(spreadsheetId, sheetName);
    
    // 헤더 확인 및 강제 설정
    await ensureHeaders(spreadsheetId, sheetName);

    // 병렬로 이미지 업로드
    const uploadPromises = orders.map(async (orderValues, i) => {
      const imageFile = files[i];
      let imageUrl = '';
      
      if (imageFile) {
        const folderId = process.env.DRIVE_FOLDER_ID;
        const fileName = `주문_${orderValues[1] || 'unknown'}_${Date.now()}_${i}.${imageFile.originalname.split('.').pop()}`;
        
        const driveResponse = await drive.files.create({
          requestBody: {
            name: fileName,
            parents: folderId ? [folderId] : undefined
          },
          media: {
            mimeType: imageFile.mimetype,
            body: Readable.from(imageFile.buffer)
          },
          fields: 'id, webViewLink'
        });
        
        await drive.permissions.create({
          fileId: driveResponse.data.id,
          requestBody: { role: 'reader', type: 'anyone' }
        });
        
        imageUrl = driveResponse.data.webViewLink;
      }
      
      return { orderValues, imageUrl, index: i };
    });

    const uploadResults = await Promise.all(uploadPromises);

    // 인덱스 방식: A~M열 순서대로, N열 이미지, O열 주문일시
    const allRows = uploadResults.map(({ orderValues, imageUrl }) => {
      const row = [];
      
      // A~M열 (인덱스 0~12): 순서대로 값 넣기
      for (let i = 0; i < 13; i++) {
        row.push(orderValues[i] || '');
      }
      
      // N열 (인덱스 13): 이미지 링크 고정
      row.push(imageUrl);
      
      // O열 (인덱스 14): 주문일시 고정
      row.push(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
      
      return row;
    });

    // 비어있는 첫 번째 행 찾아서 거기부터 채우기
    if (spreadsheetId && allRows.length > 0) {
      const allDataResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:O`
      });
      
      const allData = allDataResponse.data.values || [];
      
      // 첫 번째 완전히 빈 행 찾기 (헤더 제외, 2행부터)
      let nextRow = allData.length + 1;
      
      for (let i = 1; i < allData.length; i++) {
        const row = allData[i];
        if (!row || row.length === 0 || row.every(cell => !cell || cell.trim() === '')) {
          nextRow = i + 1;
          break;
        }
      }
      
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: allRows }
      });
    }
    
    res.json({ 
      success: true, 
      message: `${orders.length}건의 주문이 [${manager}] 시트에 저장되었습니다.`
    });
    
  } catch (error) {
    console.error('오류:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 헤더 강제 설정 함수
// ============================================
async function ensureHeaders(spreadsheetId, sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:O1`
    });
    
    const existingHeaders = response.data.values ? response.data.values[0] : [];
    
    if (existingHeaders.length === 0 || existingHeaders[0] !== FIXED_HEADERS[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [FIXED_HEADERS] }
      });
      console.log(`[${sheetName}] 헤더 강제 설정 완료`);
    }
  } catch (error) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [FIXED_HEADERS] }
    });
  }
}

// ============================================
// 시트 존재 확인/생성 함수
// ============================================
async function ensureSheetExists(spreadsheetId, sheetName) {
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === sheetName);
    
    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }]
        }
      });
    }
  } catch (error) {
    console.error('시트 확인 오류:', error);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 서버 실행: http://localhost:${PORT}`);
});
