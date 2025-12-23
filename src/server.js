require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3001;

// Multer 설정 (메모리 저장)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// CORS 설정
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Google OAuth 설정
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// 토큰 저장
let tokens = null;

// 환경변수에서 토큰 로드
if (process.env.GOOGLE_REFRESH_TOKEN) {
  tokens = {
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    access_token: process.env.GOOGLE_ACCESS_TOKEN || null
  };
  oauth2Client.setCredentials(tokens);
}

// Google Drive & Sheets 인스턴스
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// ===== 라우트 =====

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    authenticated: !!tokens,
    timestamp: new Date().toISOString()
  });
});

// OAuth 인증 시작
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

// OAuth 콜백
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    tokens = newTokens;
    oauth2Client.setCredentials(tokens);
    
    console.log('=== 토큰 발급 완료 ===');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    
    res.send(`
      <html>
        <body style="font-family: Arial; padding: 50px; text-align: center;">
          <h1 style="color: #28a745;">✅ 인증 성공!</h1>
          <p>Google 계정 연결이 완료되었습니다.</p>
          <p style="color: #666;">Railway 환경변수에 아래 토큰을 추가하세요:</p>
          <pre style="background: #f5f5f5; padding: 20px; text-align: left; overflow-x: auto;">
GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}
          </pre>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth 오류:', error);
    res.status(500).send('인증 실패: ' + error.message);
  }
});

// 다중 주문 제출
app.post('/api/submit-orders', upload.array('images', 20), async (req, res) => {
  try {
    if (!tokens) {
      return res.status(401).json({ error: 'Google 인증이 필요합니다.' });
    }

    const manager = req.body.manager;
    const orders = JSON.parse(req.body.orders || '[]');
    const files = req.files || [];
    const results = [];
    
    if (!manager) {
      return res.status(400).json({ error: '담당자를 선택해주세요.' });
    }
    
    for (let i = 0; i < orders.length; i++) {
      const orderData = orders[i];
      const imageFile = files[i];
      
      let imageUrl = '';
      
      // 이미지 업로드
      if (imageFile) {
        const folderId = process.env.DRIVE_FOLDER_ID;
        const fileName = `주문_${orderData['수취인명'] || 'unknown'}_${Date.now()}_${i}.${imageFile.originalname.split('.').pop()}`;
        
        const fileMetadata = {
          name: fileName,
          parents: folderId ? [folderId] : undefined
        };
        
        const media = {
          mimeType: imageFile.mimetype,
          body: Readable.from(imageFile.buffer)
        };
        
        const driveResponse = await drive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: 'id, webViewLink'
        });
        
        await drive.permissions.create({
          fileId: driveResponse.data.id,
          requestBody: {
            role: 'reader',
            type: 'anyone'
          }
        });
        
        imageUrl = driveResponse.data.webViewLink;
      }
      
      // Sheets에 저장
      const spreadsheetId = process.env.SPREADSHEET_ID;
      if (spreadsheetId) {
        const sheetName = manager;
        await ensureSheetExists(spreadsheetId, sheetName);
        
        const headers = await getOrCreateHeaders(spreadsheetId, sheetName, orderData);
        
        const rowData = headers.map(header => {
          if (header === '주문일시') return new Date().toLocaleString('ko-KR');
          if (header === '이미지') return imageUrl;
          return orderData[header] || '';
        });
        
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:Z`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [rowData]
          }
        });
      }
      
      results.push({ index: i, success: true, imageUrl });
    }
    
    res.json({ 
      success: true, 
      results,
      message: `${results.length}건의 주문이 [${manager}] 시트에 저장되었습니다.`
    });
    
  } catch (error) {
    console.error('다중 주문 저장 오류:', error);
    res.status(500).json({ error: error.message });
  }
});

// 시트 존재 확인 및 생성
async function ensureSheetExists(spreadsheetId, sheetName) {
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetExists = spreadsheet.data.sheets.some(
      s => s.properties.title === sheetName
    );
    
    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: sheetName }
            }
          }]
        }
      });
    }
  } catch (error) {
    console.error('시트 확인 오류:', error);
  }
}

// 헤더 확인 및 생성
async function getOrCreateHeaders(spreadsheetId, sheetName, orderData) {
  const standardHeaders = [
    '제품명', '수취인명', '연락처', '은행', '계좌(-)', '예금주',
    '결제금액', '아이디', '주문번호', '주소', '회수연락처', '이미지', '주문일시'
  ];
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!1:1`
    });
    
    let existingHeaders = response.data.values ? response.data.values[0] : [];
    
    if (existingHeaders.length === 0) {
      const orderKeys = Object.keys(orderData);
      const allHeaders = [...standardHeaders];
      
      orderKeys.forEach(key => {
        if (!allHeaders.includes(key)) {
          allHeaders.splice(allHeaders.length - 2, 0, key);
        }
      });
      
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [allHeaders]
        }
      });
      
      return allHeaders;
    }
    
    return existingHeaders;
    
  } catch (error) {
    console.error('헤더 처리 오류:', error);
    return standardHeaders;
  }
}

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
  console.log(`인증 상태: ${tokens ? '✅ 인증됨' : '❌ 인증 필요 (/auth)'}`);
});
