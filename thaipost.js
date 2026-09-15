const axios = require('axios');

const THAIPOST_TOKEN_URL = 'https://trackapi.thailandpost.co.th/post/api/v1/authenticate/token';
const THAIPOST_TRACK_URL = 'https://trackapi.thailandpost.co.th/post/api/v1/track';

// โควต้าไปรษณีย์นับต่อบัญชี วันละ 1,000 เลขพัสดุ (หน้า dashboard ขึ้น 1000/1000 ตอนหมด)
//
// ใส่ token หลายตัวได้ใน THAIPOST_API_TOKENS คั่นด้วยจุลภาค — ใช้ตัวแรกจนไปรษณีย์บอกว่า
// หมดโควต้า แล้วยิงคำขอเดิมซ้ำด้วยตัวถัดไป ลูกค้าที่กด "พัสดุของฉัน" ไม่เห็นว่าเคยล้ม
// เรียงลำดับตายตัว ไม่วนสลับ ตัวหลังจะได้เป็นตัวสำรองจริง ๆ และดู dashboard แล้วเข้าใจง่าย
//
// THAIPOST_API_TOKEN ตัวเดียวแบบเดิมยังใช้ได้ ร้านที่มีบัญชีเดียวไม่ต้องแก้ env
const API_TOKENS = (process.env.THAIPOST_API_TOKENS || process.env.THAIPOST_API_TOKEN || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// ไม่รู้แน่ว่าไปรษณีย์รีเซ็ตโควต้ากี่โมง — พักตัวที่หมดไว้ชั่วโมงเดียวแล้วลองใหม่
// ถ้ายังหมดก็แค่โดนปฏิเสธอีกคำขอแล้วพักต่อ ดีกว่าเดาว่ารีเซ็ตเที่ยงคืนแล้วพักผิดทั้งวัน
const QUOTA_RETRY_MS = 60 * 60 * 1000;

const accounts = API_TOKENS.map((apiToken, i) => ({
  label: `token ${i + 1}`, // ใช้ใน log — ห้าม log ตัว token จริง
  apiToken,
  bearer: null,
  bearerExpiry: 0,
  exhaustedUntil: 0,
}));

// บอกตั้งแต่เปิดบอทว่าอ่าน token ได้กี่ตัว ใส่ env ผิดจะได้รู้ทันที ไม่ใช่รู้ตอนตัวแรกหมดโควต้า
console.log(`[THAIPOST] ใช้ token ${accounts.length} ตัว`);

class QuotaError extends Error {}

async function getBearer(account) {
  if (account.bearer && Date.now() < account.bearerExpiry) {
    return account.bearer;
  }

  const response = await axios.post(
    THAIPOST_TOKEN_URL,
    {},
    {
      headers: {
        Authorization: `Token ${account.apiToken}`,
      },
    }
  );

  account.bearer = response.data.token;
  // Token valid for 4 hours, refresh after 3.5 hours
  account.bearerExpiry = Date.now() + 3.5 * 60 * 60 * 1000;
  return account.bearer;
}

async function requestItems(account, barcodes) {
  const token = await getBearer(account);

  const response = await axios.post(
    THAIPOST_TRACK_URL,
    {
      status: 'all',
      language: 'TH',
      barcode: barcodes,
    },
    {
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  // ไปรษณีย์ตอบ HTTP 200 แม้ตอนปฏิเสธคำขอ — ต้องดูในตัว body เอง
  // เช่น { message: "blocked, your request over quota!!", status: false }
  //
  // ของเดิม `?.response?.items || {}` กลืนเคสนี้เป็น "ไม่มีข้อมูล" เงียบ ๆ
  // แล้ว cron ก็ `if (!latest) continue` ข้ามทุกใบ
  // ผลคือบอทดูสุขภาพดีใน log ("Batch checking 20 parcel(s)") ทั้งที่ไม่ได้ทำอะไรเลย
  // ไม่มีใครรู้จนกว่าลูกค้าจะทักมาถามว่าทำไมไม่ได้แจ้งเตือน
  if (response.data?.status === false || !response.data?.response?.items) {
    const reason = response.data?.message || 'ไม่ทราบสาเหตุ';
    const ErrorType = /quota/i.test(reason) ? QuotaError : Error;
    throw new ErrorType(`Thai Post ปฏิเสธคำขอ (${account.label}): ${reason}`);
  }

  return response.data.response.items;
}

// Track single parcel
async function trackParcel(barcode) {
  const result = await trackParcels([barcode]);
  return result[barcode] || [];
}

// Track multiple parcels in one API call
async function trackParcels(barcodes) {
  if (accounts.length === 0) {
    throw new Error('ยังไม่ได้ตั้ง THAIPOST_API_TOKENS');
  }

  let quotaError = null;
  for (const account of accounts) {
    if (Date.now() < account.exhaustedUntil) continue;

    try {
      return await requestItems(account, barcodes);
    } catch (err) {
      // พังแบบอื่น (เน็ตหลุด / ไปรษณีย์ล่ม / token ผิด) เปลี่ยนบัญชีก็ไม่ช่วย โยนออกไปเลย
      if (!(err instanceof QuotaError)) throw err;

      account.exhaustedUntil = Date.now() + QUOTA_RETRY_MS;
      quotaError = err;
      console.error(`[THAIPOST] ${account.label} หมดโควต้า พักไว้ 1 ชั่วโมง`);
    }
  }

  // ทุกตัวหมดหรือพักอยู่ — ฝั่งเรียกจะตอบลูกค้าว่าตอนนี้ดึงสถานะไม่ได้
  throw quotaError || new QuotaError('Thai Post ปฏิเสธคำขอ: ทุก token หมดโควต้า รอลองใหม่');
}

module.exports = { trackParcel, trackParcels };
