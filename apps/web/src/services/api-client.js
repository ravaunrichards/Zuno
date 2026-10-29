const DEFAULT_API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:4000' : '';
export async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 5000);
  try {
    const response = await fetch(DEFAULT_API + path, {
      method: options.method || 'GET',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(payload.message || payload.code || 'Request failed'); error.status = response.status; throw error; }
    return payload;
  } finally { clearTimeout(timer); }
}
