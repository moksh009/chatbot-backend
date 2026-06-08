'use strict';

const HTTP_BY_CODE = {
  AI_NOT_CONFIGURED: 400,
  AI_INVALID_KEY: 401,
  AI_QUOTA_EXCEEDED: 429,
  AI_BILLING_REQUIRED: 402,
  AI_CIRCUIT_OPEN: 503,
  AI_TIMEOUT: 504,
  AI_EMPTY_RESPONSE: 502,
  AI_PROVIDER_ERROR: 500,
  RAG_UNAVAILABLE: 503,
};

const USER_MESSAGES = {
  AI_NOT_CONFIGURED: 'Add your Gemini or OpenAI API key in Intelligence Hub → AI Setup.',
  AI_INVALID_KEY: 'Your AI API key is invalid or expired. Update it in Intelligence Hub → AI Setup.',
  AI_QUOTA_EXCEEDED: 'Your AI provider quota is exhausted. Add billing credits in Google AI Studio or OpenAI, then try again.',
  AI_BILLING_REQUIRED: 'Your AI provider requires billing setup or prepaid credits. Enable billing in Google AI Studio or OpenAI, then try again.',
  AI_CIRCUIT_OPEN: 'AI requests are temporarily paused after repeated failures. Wait about a minute and try again.',
  AI_TIMEOUT: 'The AI provider took too long to respond. Try again with a shorter prompt.',
  AI_EMPTY_RESPONSE: 'The AI provider returned an empty response. Check your API key, model access, and billing in AI Setup.',
  AI_PROVIDER_ERROR: 'Could not reach your AI provider. Check your API key and billing, then try again.',
};

class AiProviderError extends Error {
  constructor(code, options = {}) {
    const normalized = String(code || 'AI_PROVIDER_ERROR');
    super(options.message || normalized);
    this.name = 'AiProviderError';
    this.code = normalized;
    this.userMessage = options.userMessage || USER_MESSAGES[normalized] || USER_MESSAGES.AI_PROVIDER_ERROR;
    this.httpStatus = options.httpStatus || HTTP_BY_CODE[normalized] || 500;
    this.provider = options.provider || null;
    this.operation = options.operation || null;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause || null;
  }
}

function isAiProviderError(err) {
  return err instanceof AiProviderError || Boolean(err?.code && USER_MESSAGES[err.code]);
}

function isCircuitOpenError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('[CircuitBreaker]') && msg.includes('OPEN');
}

function extractErrorText(err) {
  const parts = [
    err?.message,
    err?.cause?.message,
    err?.response?.data?.error?.message,
    err?.response?.data?.error?.status,
    err?.response?.data?.message,
    typeof err?.response?.data === 'string' ? err.response.data : null,
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function extractHttpStatus(err) {
  return Number(err?.status || err?.response?.status || err?.httpStatus || 0) || null;
}

function isQuotaOrBillingError(err) {
  const text = extractErrorText(err);
  const status = extractHttpStatus(err);
  if (status === 429) return true;
  return (
    text.includes('429')
    || text.includes('quota')
    || text.includes('rate limit')
    || text.includes('rate_limit')
    || text.includes('too many requests')
    || text.includes('resource exhausted')
    || text.includes('resource_exhausted')
    || text.includes('billing')
    || text.includes('prepayment credits are depleted')
    || text.includes('insufficient_quota')
    || text.includes('exceeded your current quota')
  );
}

function isBillingRequiredError(err) {
  const text = extractErrorText(err);
  return (
    text.includes('billing')
    || text.includes('prepayment credits are depleted')
    || text.includes('enable billing')
    || text.includes('payment required')
  );
}

function isInvalidKeyError(err) {
  const text = extractErrorText(err);
  const status = extractHttpStatus(err);
  if (status === 401 || status === 403) return true;
  return (
    text.includes('api_key_invalid')
    || text.includes('invalid api key')
    || text.includes('invalid authentication')
    || text.includes('incorrect api key')
    || text.includes('permission denied')
  );
}

function isTimeoutError(err) {
  const text = extractErrorText(err);
  return text.includes('timeout') || text.includes('timed out') || err?.code === 'ETIMEDOUT';
}

function isNonTransientAiError(err) {
  return (
    isQuotaOrBillingError(err)
    || isInvalidKeyError(err)
    || isCircuitOpenError(err)
    || isTimeoutError(err)
  );
}

function classifyAiError(err, options = {}) {
  if (err instanceof AiProviderError) return err;
  if (err?.code && USER_MESSAGES[err.code]) {
    return new AiProviderError(err.code, {
      userMessage: err.userMessage || USER_MESSAGES[err.code],
      httpStatus: err.httpStatus || HTTP_BY_CODE[err.code],
      provider: options.provider || err.provider || null,
      operation: options.operation || err.operation || null,
      cause: err,
    });
  }

  if (isCircuitOpenError(err)) {
    return new AiProviderError('AI_CIRCUIT_OPEN', {
      provider: options.provider || null,
      operation: options.operation || null,
      cause: err,
    });
  }

  if (isInvalidKeyError(err)) {
    return new AiProviderError('AI_INVALID_KEY', {
      provider: options.provider || null,
      operation: options.operation || null,
      cause: err,
    });
  }

  if (isQuotaOrBillingError(err)) {
    const code = isBillingRequiredError(err) ? 'AI_BILLING_REQUIRED' : 'AI_QUOTA_EXCEEDED';
    return new AiProviderError(code, {
      provider: options.provider || null,
      operation: options.operation || null,
      cause: err,
    });
  }

  if (isTimeoutError(err)) {
    return new AiProviderError('AI_TIMEOUT', {
      provider: options.provider || null,
      operation: options.operation || null,
      cause: err,
    });
  }

  return new AiProviderError('AI_PROVIDER_ERROR', {
    userMessage: options.fallbackMessage || USER_MESSAGES.AI_PROVIDER_ERROR,
    provider: options.provider || null,
    operation: options.operation || null,
    cause: err,
  });
}

function httpStatusForAiErrorCode(code) {
  return HTTP_BY_CODE[code] || 500;
}

function mapRagReasonToUserMessage(reason, meta = {}) {
  const detail = String(meta.detail || meta.message || '').toLowerCase();

  switch (reason) {
    case 'ai_not_configured':
      return USER_MESSAGES.AI_NOT_CONFIGURED;
    case 'embedding_in_progress':
      return 'Knowledge documents are still being indexed. Wait a minute and try again.';
    case 'embedding_failed':
      return 'Some knowledge documents failed to index. Open AI Brain → Knowledge and re-embed failed documents.';
    case 'no_active_documents':
      return 'Add knowledge documents in AI Brain → Knowledge before running a test.';
    case 'vector_store_empty':
      return 'No indexed knowledge is ready yet. Finish document embedding in AI Brain → Knowledge.';
    case 'zero_vector_hits':
      return 'No matching knowledge was found for that question. Add or update documents, then try again.';
    case 'empty_context':
      return 'No knowledge content matched that question yet.';
    case 'query_embed_failed':
      if (detail.includes('invalid') && (detail.includes('api key') || detail.includes('401') || detail.includes('403'))) {
        return USER_MESSAGES.AI_INVALID_KEY;
      }
      if (
        detail.includes('429')
        || detail.includes('quota')
        || detail.includes('billing')
        || detail.includes('depleted')
        || detail.includes('rate limit')
      ) {
        return 'Knowledge search needs embedding API access. Your provider quota or billing is exhausted — add credits in Google AI Studio or OpenAI, or switch provider in AI Setup.';
      }
      if (detail.includes('circuitbreaker') || detail.includes('circuit open')) {
        return USER_MESSAGES.AI_CIRCUIT_OPEN;
      }
      return 'Knowledge search could not run because embeddings failed. Check your API key, billing, and GEMINI_EMBEDDING_MODEL in AI Setup.';
    default:
      return USER_MESSAGES.AI_PROVIDER_ERROR;
  }
}

function sendAiError(res, err, extra = {}) {
  const classified = classifyAiError(err);
  return res.status(classified.httpStatus).json({
    error: classified.userMessage,
    code: classified.code,
    provider: classified.provider || undefined,
    ...extra,
  });
}

module.exports = {
  AiProviderError,
  USER_MESSAGES,
  classifyAiError,
  extractErrorText,
  httpStatusForAiErrorCode,
  isAiProviderError,
  isBillingRequiredError,
  isCircuitOpenError,
  isInvalidKeyError,
  isNonTransientAiError,
  isQuotaOrBillingError,
  mapRagReasonToUserMessage,
  sendAiError,
};
