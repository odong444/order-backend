// 다중 주문 제출 (병렬 처리) - 안정화 버전
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
    
    // 고정 헤더 (항상 이 순서로)
    const fixedHeaders = [
      '제품명', '수취인명', '연락처', '은행', '계좌(-)', '예금주',
      '결제금액(원 쓰지 마세요)', '아이디', '주문번호', '주소', '닉네임', '회수이름', '회수연락처', '이미지', '주문일시'
    ];
    
    // 헤더 확인 및 강제 설정
    await ensureHeaders(spreadsheetId, sheetName, fixedHeaders);

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

    // 고정 헤더 순서대로 데이터 매핑
    const allRows = uploadResults.map(({ orderData, imageUrl }) => {
      return fixedHeaders.map(header => {
        if (header === '주문일시') return new Date().toLocaleString('ko-KR');
        if (header === '이미지') return imageUrl;
        return orderData[header] || '';
      });
    });

    // 마지막 행 찾아서 그 다음에 추가 (A열부터 강제)
    if (spreadsheetId && allRows.length > 0) {
      const lastRowResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:A`
      });
      const nextRow = (lastRowResponse.data.values?.length || 1) + 1;
      
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

// 헤더 강제 설정 함수
async function ensureHeaders(spreadsheetId, sheetName, fixedHeaders) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:O1`
    });
    
    const existingHeaders = response.data.values ? response.data.values[0] : [];
    
    // 헤더가 없거나 첫 번째 헤더가 다르면 강제 덮어쓰기
    if (existingHeaders.length === 0 || existingHeaders[0] !== fixedHeaders[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fixedHeaders] }
      });
      console.log(`[${sheetName}] 헤더 강제 설정 완료`);
    }
  } catch (error) {
    // 에러 시에도 헤더 강제 설정
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [fixedHeaders] }
    });
  }
}

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
