const axios = require('axios');

const THAIPOST_TOKEN_URL = 'https://trackapi.thailandpost.co.th/post/api/v1/authenticate/token';
const THAIPOST_TRACK_URL = 'https://trackapi.thailandpost.co.th/post/api/v1/track';

let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const response = await axios.post(
    THAIPOST_TOKEN_URL,
    {},
    {
      headers: {
        Authorization: `Token ${process.env.THAIPOST_API_TOKEN}`,
      },
    }
  );

  cachedToken = response.data.token;
  // Token valid for 4 hours, refresh after 3.5 hours
  tokenExpiry = Date.now() + 3.5 * 60 * 60 * 1000;
  return cachedToken;
}

// Track single parcel
async function trackParcel(barcode) {
  const result = await trackParcels([barcode]);
  return result[barcode] || [];
}

// Track multiple parcels in one API call
async function trackParcels(barcodes) {
  const token = await getToken();

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

  return response.data?.response?.items || {};
}

module.exports = { trackParcel, trackParcels };
