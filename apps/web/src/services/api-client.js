import { apiBaseUrl, getFreshAccessToken } from '../features/auth/session.js';

export async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 7000);
  try {
    const headers = {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const token = await getFreshAccessToken();
    if (token && !headers.Authorization && !headers.authorization) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(apiBaseUrl() + path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.code || 'Request failed');
      error.status = response.status;
      error.code = payload.code || 'REQUEST_FAILED';
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
