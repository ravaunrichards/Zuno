'use strict';

const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

function isConfigured(config) {
  return Boolean(config && config.supabase && config.supabase.url && config.supabase.serviceRoleKey);
}
function storageBase(config) {
  const base = new URL(config.supabase.url);
  base.pathname = '/storage/v1';
  base.search = '';
  base.hash = '';
  return base.toString().replace(/\/$/, '');
}
function encodeObjectPath(objectPath) {
  if (typeof objectPath !== 'string' || !objectPath || objectPath.startsWith('/') || objectPath.includes('\\')) {
    throw new Error('INVALID_STORAGE_PATH');
  }
  const segments = objectPath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) {
    throw new Error('INVALID_STORAGE_PATH');
  }
  return segments.map((part) => encodeURIComponent(part)).join('/');
}
function endpoint(config, suffix) {
  return storageBase(config) + suffix;
}
function resolveSignedPath(config, value) {
  if (typeof value !== 'string' || !value) throw new Error('SIGNED_URL_NOT_RETURNED');
  if (/^https:\/\//i.test(value)) {
    const result = new URL(value);
    const expected = new URL(config.supabase.url);
    if (result.origin !== expected.origin) throw new Error('SIGNED_URL_ORIGIN_MISMATCH');
    return result.toString();
  }
  if (value.startsWith('/')) return new URL(storageBase(config) + value, config.supabase.url).toString();
  return new URL(value, storageBase(config) + '/').toString();
}
async function fetchWithTimeout(fetcher, url, options, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
async function readJson(response) {
  const value = await response.text();
  if (!value) return {};
  try { return JSON.parse(value); } catch (_) { return {}; }
}
function serviceHeaders(config, extra = {}) {
  return {
    apikey: config.supabase.serviceRoleKey,
    Authorization: 'Bearer ' + config.supabase.serviceRoleKey,
    ...extra
  };
}
async function createSignedUploadUrl(config, bucket, objectPath, fetcher = fetch) {
  if (!isConfigured(config)) return { ok: false, status: 503, code: 'STORAGE_NOT_CONFIGURED' };
  try {
    const key = encodeObjectPath(objectPath);
    const url = endpoint(config, '/object/upload/sign/' + encodeURIComponent(bucket) + '/' + key);
    const response = await fetchWithTimeout(fetcher, url, {
      method: 'POST',
      headers: serviceHeaders(config, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({})
    });
    const data = await readJson(response);
    if (!response.ok || !(data.url || data.signedURL || data.signedUrl)) {
      return { ok: false, status: response.status || 502, code: 'SIGNED_UPLOAD_URL_FAILED' };
    }
    const uploadUrl = resolveSignedPath(config, data.url || data.signedURL || data.signedUrl);
    const token = new URL(uploadUrl).searchParams.get('token') || data.token || null;
    if (!token) return { ok: false, status: 502, code: 'SIGNED_UPLOAD_TOKEN_MISSING' };
    return { ok: true, uploadUrl, token, path: objectPath, expiresInSeconds: 7200 };
  } catch (_) {
    return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' };
  }
}
async function createSignedDownloadUrls(config, bucket, objectPaths, expiresInSeconds = 600, fetcher = fetch) {
  if (!isConfigured(config)) return { ok: false, status: 503, code: 'STORAGE_NOT_CONFIGURED', signedUrls: [] };
  if (!Array.isArray(objectPaths) || !objectPaths.length) return { ok: true, status: 200, signedUrls: [] };
  try {
    const paths = [...new Set(objectPaths)].map(encodeObjectPath);
    const url = endpoint(config, '/object/sign/' + encodeURIComponent(bucket));
    const response = await fetchWithTimeout(fetcher, url, {
      method: 'POST',
      headers: serviceHeaders(config, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ expiresIn: Math.max(30, Math.min(3600, Number(expiresInSeconds) || 600)), paths })
    });
    const data = await readJson(response);
    if (!response.ok || !Array.isArray(data)) return { ok: false, status: response.status || 502, code: 'SIGNED_DOWNLOAD_URL_FAILED', signedUrls: [] };
    const signedUrls = data.map((item) => {
      const path = typeof item.path === 'string' ? item.path : '';
      const value = item.signedURL || item.signedUrl || item.url;
      if (!path || !value) return null;
      try { return { path, signedUrl: resolveSignedPath(config, value) }; } catch (_) { return null; }
    }).filter(Boolean);
    return { ok: true, status: 200, signedUrls };
  } catch (_) {
    return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE', signedUrls: [] };
  }
}
async function createSignedDownloadUrl(config, bucket, objectPath, expiresInSeconds = 600, fetcher = fetch) {
  const result = await createSignedDownloadUrls(config, bucket, [objectPath], expiresInSeconds, fetcher);
  if (!result.ok) return result;
  const found = result.signedUrls.find((item) => item.path === objectPath);
  return found ? { ok: true, status: 200, signedUrl: found.signedUrl } : { ok: false, status: 404, code: 'OBJECT_NOT_FOUND' };
}
async function uploadObjectFromFile(config, bucket, objectPath, filePath, contentType, fetcher = fetch) {
  if (!isConfigured(config)) return { ok: false, status: 503, code: 'STORAGE_NOT_CONFIGURED' };
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return { ok: false, status: 400, code: 'INVALID_UPLOAD_FILE' };
    const key = encodeObjectPath(objectPath);
    const body = fs.createReadStream(filePath);
    const url = endpoint(config, '/object/' + encodeURIComponent(bucket) + '/' + key);
    const response = await fetchWithTimeout(fetcher, url, {
      method: 'POST',
      headers: serviceHeaders(config, {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'cache-control': '3600',
        'x-upsert': 'false'
      }),
      body,
      duplex: 'half'
    }, 15 * 60 * 1000);
    await response.arrayBuffer().catch(() => null);
    return response.ok ? { ok: true, status: response.status, byteSize: stat.size } : { ok: false, status: response.status, code: 'STORAGE_OBJECT_UPLOAD_FAILED' };
  } catch (_) {
    return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' };
  }
}
async function downloadObjectToFile(config, bucket, objectPath, outputPath, maxBytes, fetcher = fetch) {
  if (!isConfigured(config)) return { ok: false, status: 503, code: 'STORAGE_NOT_CONFIGURED' };
  try {
    const key = encodeObjectPath(objectPath);
    const url = endpoint(config, '/object/authenticated/' + encodeURIComponent(bucket) + '/' + key);
    const response = await fetchWithTimeout(fetcher, url, {
      method: 'GET',
      headers: serviceHeaders(config, { Accept: 'application/octet-stream' })
    }, 15 * 60 * 1000);
    if (!response.ok || !response.body) return { ok: false, status: response.status || 502, code: 'STORAGE_OBJECT_DOWNLOAD_FAILED' };
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return { ok: false, status: 413, code: 'FILE_TOO_LARGE' };
    let count = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        count += chunk.length;
        if (count > maxBytes) return callback(new Error('FILE_TOO_LARGE'));
        callback(null, chunk);
      }
    });
    await pipeline(require('node:stream').Readable.fromWeb(response.body), limiter, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
    return { ok: true, status: 200, byteSize: count };
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    return { ok: false, status: error && error.message === 'FILE_TOO_LARGE' ? 413 : 503, code: error && error.message === 'FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : 'STORAGE_UNAVAILABLE' };
  }
}
async function inspectObject(config, bucket, objectPath, fetcher = fetch) {
  if (!isConfigured(config)) return { ok: false, status: 503, code: 'STORAGE_NOT_CONFIGURED' };
  try {
    const key = encodeObjectPath(objectPath);
    const url = endpoint(config, '/object/authenticated/' + encodeURIComponent(bucket) + '/' + key);
    const response = await fetchWithTimeout(fetcher, url, {
      method: 'HEAD',
      headers: serviceHeaders(config, { Accept: 'application/json, */*' })
    });
    await response.arrayBuffer().catch(() => null);
    if (!response.ok) return { ok: false, status: response.status, code: response.status === 404 ? 'OBJECT_NOT_FOUND' : 'STORAGE_OBJECT_INSPECTION_FAILED' };
    const size = Number(response.headers.get('content-length'));
    return {
      ok: true, status: response.status,
      byteSize: Number.isSafeInteger(size) && size >= 0 ? size : null,
      mimeType: response.headers.get('content-type') || null,
      etag: response.headers.get('etag') || null
    };
  } catch (_) {
    return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' };
  }
}
async function deleteObject(config, bucket, objectPath, fetcher = fetch) {
  if (!isConfigured(config)) return { ok: false, status: 503, code: 'STORAGE_NOT_CONFIGURED' };
  try {
    const response = await fetchWithTimeout(fetcher, endpoint(config, '/object/' + encodeURIComponent(bucket)), {
      method: 'DELETE',
      headers: serviceHeaders(config, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ prefixes: [objectPath] })
    });
    await response.arrayBuffer().catch(() => null);
    return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, code: 'STORAGE_OBJECT_DELETE_FAILED' };
  } catch (_) {
    return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' };
  }
}

module.exports = {
  isConfigured, storageBase, encodeObjectPath, resolveSignedPath,
  createSignedUploadUrl, createSignedDownloadUrl, createSignedDownloadUrls,
  uploadObjectFromFile, downloadObjectToFile, inspectObject, deleteObject
};
