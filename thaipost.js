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

// ไปรษณีย์ไม่ตอบภายในเวลานี้ = ถือว่าล่ม
//
// เดิมไม่ได้ตั้งไว้ axios จึงรอไปเรื่อย ๆ ไม่มีกำหนด และ webhook ตอบ LINE หลังได้ผลจากไปรษณีย์
// ไปรษณีย์ค้างทีเดียว ลูกค้าที่กด "พัสดุของฉัน" ไม่ได้คำตอบอะไรเลยสักข้อความ
// ยิ่งช่วงโควต้าข้อความ LINE เต็ม การกดเช็คเองเป็นทางเดียวที่ลูกค้าจะรู้ว่าของอยู่ไหน
//
// 10 วินาทีพอสำหรับการกดดูทีละไม่กี่เลข ส่วน cron ยิงทีเดียวหลายสิบเลข ส่งเวลามาเองตอนเรียก
const REQUEST_TIMEOUT_MS = 10 * 1000;

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

async function getBearer(account, timeout) {
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
      timeout,
    }
  );

  account.bearer = response.data.token;
  // Token valid for 4 hours, refresh after 3.5 hours
  account.bearerExpiry = Date.now() + 3.5 * 60 * 60 * 1000;
  return account.bearer;
}

async function requestItems(account, barcodes, timeout) {
  const token = await getBearer(account, timeout);

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
      timeout,
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

/** ไปรษณีย์ไม่รับ token — token ผิด/ถูกยกเลิก หรือ token ชั่วคราวที่จำไว้หมดอายุก่อนเวลาที่เดา */
function isRejected(err) {
  const code = err?.response?.status;
  return code === 401 || code === 403;
}

/**
 * ยิงด้วย token ชั่วคราวที่จำไว้ ถ้าโดนปฏิเสธก็ขอใหม่แล้วลองอีกครั้งเดียว
 *
 * อายุ 3.5 ชั่วโมงเป็นค่าที่เดาไว้เอง ไม่ได้อ่านจากไปรษณีย์ ถ้าของจริงสั้นกว่านั้น
 * เดิมจะโดน 401 รัวไปจนครบเวลาที่จำไว้ ทั้งที่ขอ token ใหม่ครั้งเดียวก็จบ
 */
async function requestWithFreshBearer(account, barcodes, timeout) {
  const usedCachedBearer = Boolean(account.bearer) && Date.now() < account.bearerExpiry;

  try {
    return await requestItems(account, barcodes, timeout);
  } catch (err) {
    if (!isRejected(err)) throw err;

    account.bearer = null;
    if (!usedCachedBearer) throw err;
    return requestItems(account, barcodes, timeout);
  }
}

// Track single parcel
async function trackParcel(barcode, options) {
  const result = await trackParcels([barcode], options);
  return result[barcode] || [];
}

// Track multiple parcels in one API call
async function trackParcels(barcodes, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  if (accounts.length === 0) {
    throw new Error('ยังไม่ได้ตั้ง THAIPOST_API_TOKENS');
  }

  let skipped = null;
  for (const account of accounts) {
    if (Date.now() < account.exhaustedUntil) continue;

    try {
      return await requestWithFreshBearer(account, barcodes, timeout);
    } catch (err) {
      // เน็ตหลุด / ไปรษณีย์ล่ม / เกินเวลา — บัญชีอื่นก็ยิงไปเซิร์ฟเวอร์เดียวกัน โยนออกไปเลย
      if (!(err instanceof QuotaError) && !isRejected(err)) throw err;

      // หมดโควต้า หรือ token ใช้ไม่ได้ — พักบัญชีนี้ไว้แล้วลองตัวถัดไปทันที
      //
      // เดิมข้ามให้เฉพาะตอนหมดโควต้า ส่วน 401 โยนออกไปทั้งก้อนตั้งแต่ตัวแรก
      // token สำรองที่ยังดีอยู่เลยไม่เคยได้ทำงาน ใส่ token เสียไว้ตัวหน้าตัวเดียว เช็คพัสดุล่มทั้งระบบ
      account.exhaustedUntil = Date.now() + QUOTA_RETRY_MS;
      skipped = err;
      console.error(
        isRejected(err)
          ? `[THAIPOST] ${account.label} ถูกปฏิเสธ (${err.response.status}) — เช็ค token ตัวนี้ใน env พักไว้ 1 ชั่วโมง`
          : `[THAIPOST] ${account.label} หมดโควต้า พักไว้ 1 ชั่วโมง`
      );
    }
  }

  // ทุกตัวหมด ถูกปฏิเสธ หรือพักอยู่ — ฝั่งเรียกจะตอบลูกค้าว่าตอนนี้ดึงสถานะไม่ได้
  throw skipped || new QuotaError('Thai Post ปฏิเสธคำขอ: ทุก token หมดโควต้าหรือใช้ไม่ได้ รอลองใหม่');
}

module.exports = { trackParcel, trackParcels };
