// Ollama provider for anymodel
// Routes requests to local Ollama instance (OpenAI-compatible endpoint)

import http from 'http';

export default {
  name: 'ollama',

  buildRequest(url, payload) {
    return {
      hostname: 'localhost',
      port: 11434,
      path: url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    };
  },

  displayInfo(model) {
    return model ? `(${model} @ localhost:11434)` : '(localhost:11434)';
  },

  // Check if Ollama is running locally
  detect() {
    return new Promise(resolve => {
      const req = http.get('http://localhost:11434', res => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  },
};
