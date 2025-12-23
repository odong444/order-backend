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

// 고정 헤더
const FIXED_HEADERS = [
  '제품명', '수취인명', '연락처', '은행', '계좌(-)', '예금주',
  '결제금액(원 쓰지 마세요)', '아이디', '주문번호', '주소', '닉네임', '회수이름', '회수연락처', '이미지', '주문일시'
];

// 다중 주문 제출 (인덱스 방식)
app.post('/api/submit-orders', upload.array('images', 20), async (req, res) => {
  try {
    if (!tokens) {
      return res.status(401).json({ error: 'Google 인증이 필요합니다.' });
    }

    const manager = req.body.manager;
    const orders = JSON.parse(req.body.orders || '[]');  // 배열의 배열
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
      row.push(new Date().toLocaleString('ko-KR'));
      
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
    
  } catch (error) {
    console.error('오류:', error);
    res.status(500).json({ error: error.message });
  }
});

// 헤더 강제 설정 함수
async function ensureHeaders(spreadsheetId, sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:O1`
    });
    
    const existingHeaders = response.data.values ? response.data.values[0] : [];
    
    // 헤더가 없거나 첫 번째 헤더가 다르면 강제 덮어쓰기
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
    // 에러 시에도 헤더 강제 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [FIXED_HEADERS] }
    });
  }
}

// 시트 존재 확인/생성 함수
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
