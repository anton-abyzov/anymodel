// Native OpenAI wire forwarding: no conversion, model substitution, or auth fallback.
import { readCappedBody, safeJsonParse } from './message-utils.mjs';

function fail(res, status, message, type = 'invalid_request_error') {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type, code: null } }));
}

export async function handleCloudWire(req, res, provider, { model, isFreeTierModel, sendRequest }) {
  if (typeof provider.buildWireRequest !== 'function') {
    req.resume();
    fail(res, 501, `Provider ${provider.name} does not support this OpenAI endpoint`);
    return;
  }
  let payload = '';
  if (req.method !== 'GET') {
    const raw = await readCappedBody(req);
    const result = safeJsonParse(raw.toString());
    if (!result.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
      fail(res, 400, 'Expected a JSON request object');
      return;
    }
    const body = result.value;
    if (model) body.model = model;
    if (!isFreeTierModel(body.model)) {
      fail(res, 403, 'Model is not permitted in free-only mode', 'permission_error');
      return;
    }
    payload = JSON.stringify(body);
  } else {
    // GET has no supported body, but still enforce the streaming byte cap.
    await readCappedBody(req);
  }
  const wireProvider = {
    name: provider.name,
    buildRequest: (url, data, key) => provider.buildWireRequest(url, data, key, req.method),
  };
  const upstream = await sendRequest(wireProvider, req.url, payload);
  const onClose = () => upstream.destroy();
  res.on('close', onClose);
  const contentType = upstream.headers['content-type'] || 'application/json';
  if (!contentType.includes('text/event-stream')) {
    try {
      const data = await readCappedBody(upstream);
      res.writeHead(upstream.statusCode, { 'content-type': contentType });
      res.end(data);
    } catch (e) {
      if (e.code === 'BODY_TOO_LARGE') { e.status = 502; e.message = 'Upstream response exceeds configured body limit'; }
      throw e;
    } finally {
      res.off('close', onClose);
      upstream.destroy();
    }
    return;
  }
  res.writeHead(upstream.statusCode, { 'content-type': contentType, 'cache-control': 'no-cache' });
  // Protocol error events pass verbatim. A transport failure aborts the response,
  // which clients must treat as incomplete, rather than inventing success.
  upstream.on('error', e => res.destroy(e));
  upstream.on('aborted', () => res.destroy(new Error('Upstream stream aborted')));
  upstream.pipe(res);
}
