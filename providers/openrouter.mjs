// OpenRouter provider for anymodel
// Routes requests to openrouter.ai/api with Bearer auth

export default {
  name: 'openrouter',

  buildRequest(url, payload, apiKey) {
    return {
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api' + url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload),
        'http-referer': 'https://github.com/anton-abyzov/anymodel',
        'x-title': 'anymodel',
      },
    };
  },

  displayInfo(model) {
    return model ? `(${model})` : '(passthrough model)';
  },
};
