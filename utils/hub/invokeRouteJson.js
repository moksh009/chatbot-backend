'use strict';

/**
 * Invoke an Express (req, res) handler and capture res.json() payload.
 * Used by workspace bundle endpoints to reuse existing route handlers.
 */
function invokeRouteJson(handler, reqStub) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(body) {
        resolve({ status: statusCode, body });
        return this;
      },
    };

    try {
      const result = handler(reqStub, res);
      if (result && typeof result.then === 'function') {
        result.catch(reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { invokeRouteJson };
