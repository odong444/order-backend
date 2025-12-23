require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');

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

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ status: 'ok', authenticated: !!tokens });
});

// OAuth 인증
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

// 다중 주문 제출 (병렬 처리)
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
    
    // 시트 & 헤더 먼저 한번만 확인
    await ensureSheetExists(spreadsheetId, sheetName);
    const headers = await getOrCreateHeaders(spreadsheetId, sheetName, orders[0] || {});

    // 병렬로 이미지 업로드
    const uploadPromises = orders.map(async (orderData, i) => {
      const imageFile = files[i];
      let imageUrl = '';
      
      if (imageFile) {
        const folderId = process.env.DRIVE_FOLDER_ID;
        const fileName = `주문_${orderData['수취인명'] || 'unknown'}_${Date.now()}_${i}.${imageFile.originalname.split('.').pop()}`;
        
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
      
      return { orderData, imageUrl, index: i };
    });

    const uploadResults = await Promise.all(uploadPromises);

    // 모든 행 데이터 한번에 준비
    const allRows = uploadResults.map(({ orderData, imageUrl }) => {
      return headers.map(header => {
        if (header === '주문일시') return new Date().toLocaleString('ko-KR');
        if (header === '이미지') return imageUrl;
        return orderData[header] || '';
      });
    });

    // 한번에 일괄 추가 (API 호출 1번으로 줄임)
    if (spreadsheetId && allRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
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

async function getOrCreateHeaders(spreadsheetId, sheetName, orderData) {
  const standardHeaders = [
    '제품명', '수취인명', '연락처', '은행', '계좌', '예금주',
    '결제금액', '아이디', '주문번호', '주소', '닉네임', '회수이름', '회수연락처', '이미지', '주문일시'
  ];
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!1:1`
    });
    
    let existingHeaders = response.data.values ? response.data.values[0] : [];
    
    if (existingHeaders.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [standardHeaders] }
      });
      return standardHeaders;
    }
    
    return existingHeaders;
  } catch (error) {
    return standardHeaders;
  }
}

app.listen(PORT, () => {
  console.log(`🚀 서버 실행: http://localhost:${PORT}`);
});
