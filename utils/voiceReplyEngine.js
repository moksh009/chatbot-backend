"use strict";

/**
 * voiceReplyEngine.js — Phase 26 Track 3
 * Converts bot reply text → Google Cloud TTS audio → uploads to WhatsApp → sends as voice note.
 * Only activated when client.voiceReplyEnabled = true AND the original message was a voice note.
 */

const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const FormData = require('form-data');
const log      = require('./logger')('VoiceReplyEngine');

// Voice configurations per language (Google Cloud TTS Neural2 voices)
const VOICE_CONFIG = {
  english:   { languageCode: 'en-IN', name: 'en-IN-Neural2-A', ssmlGender: 'FEMALE' },
  hindi:     { languageCode: 'hi-IN', name: 'hi-IN-Neural2-A', ssmlGender: 'FEMALE' },
  gujarati:  { languageCode: 'gu-IN', name: 'gu-IN-Chirp3-HD-Aoede', ssmlGender: 'FEMALE' },
  hinglish:  { languageCode: 'hi-IN', name: 'hi-IN-Neural2-A', ssmlGender: 'FEMALE' },
  gujarlish: { languageCode: 'gu-IN', name: 'gu-IN-Chirp3-HD-Aoede', ssmlGender: 'FEMALE' },
  marathi:   { languageCode: 'mr-IN', name: 'mr-IN-Standard-A', ssmlGender: 'FEMALE' },
};

/**
 * Clean WhatsApp markdown formatting for TTS input.
 */
function cleanTextForTTS(text) {
  return text
    .replace(/\*([^*]+)\*/g, '$1')   // bold
    .replace(/_([^_]+)_/g, '$1')     // italic
    .replace(/~([^~]+)~/g, '$1')     // strikethrough
    .replace(/```[\s\S]*?```/g, '')  // code blocks
    .replace(/\n{3,}/g, '\n\n')      // excessive newlines
    .substring(0, 1000);             // TTS limit
}

/**
 * Use Google Cloud TTS REST API to synthesize speech.
 * Returns Buffer of OGG_OPUS audio.
 */
async function synthesizeSpeech(text, language = 'english') {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_TTS_API_KEY not configured — skipping voice reply');
  }

  const voice = VOICE_CONFIG[language] || VOICE_CONFIG.english;
  const cleanText = cleanTextForTTS(text);

  const response = await axios.post(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      input:       { text: cleanText },
      voice,
      audioConfig: {
        audioEncoding: 'OGG_OPUS',
        speakingRate:  1.0,
        pitch:         0.0
      }
    },
    { timeout: 15000 }
  );

  if (!response.data?.audioContent) {
    throw new Error('TTS returned empty audio content');
  }

  return Buffer.from(response.data.audioContent, 'base64');
}

/**
 * Upload audio buffer to WhatsApp Media API.
 * Returns the media ID string.
 */
async function uploadAudioToWhatsApp(client, audioBuffer) {
  const phoneNumberId = client.phoneNumberId || client.whatsapp?.phoneNumberId;
  const token         = client.whatsappToken  || client.whatsapp?.accessToken;

  if (!phoneNumberId || !token) {
    throw new Error('Missing WhatsApp phoneNumberId or token');
  }

  const tmpFile = path.join(os.tmpdir(), `va_reply_${Date.now()}.ogg`);
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', fs.createReadStream(tmpFile), {
      contentType: 'audio/ogg; codecs=opus',
      filename:    'voice_reply.ogg'
    });

    const uploadResp = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/media`,
      form,
      {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        timeout: 20000
      }
    );

    return uploadResp.data.id;
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Main function: text → TTS → upload → send as WhatsApp audio message.
 * @param {Object} client     - Client document
 * @param {string} toPhone    - Customer phone number
 * @param {string} text       - Bot reply text
 * @param {string} language   - Detected language of conversation
 * @returns {Promise<{sent: boolean, mediaId?: string, error?: string}>}
 */
async function sendVoiceReply(client, toPhone, text, language = 'english') {
  const phoneNumberId = client.phoneNumberId || client.whatsapp?.phoneNumberId;
  const token         = client.whatsappToken  || client.whatsapp?.accessToken;

  try {
    // 1. Synthesize
    log.info('Synthesizing TTS', { language, chars: text.length });
    const audioBuffer = await synthesizeSpeech(text, language);

    // 2. Upload to WhatsApp
    const mediaId = await uploadAudioToWhatsApp(client, audioBuffer);
    log.info('Audio uploaded to WA', { mediaId });

    // 3. Send audio message
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:   toPhone,
        type: 'audio',
        audio: { id: mediaId }
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    log.info('Voice reply sent', { toPhone, mediaId });
    return { sent: true, mediaId };

  } catch (err) {
    // Safe fallback — log and return error so caller falls back to text
    const isMissingKey = err.message?.includes('GOOGLE_TTS_API_KEY');
    if (isMissingKey) {
      log.warn('TTS skipped: Missing API Key — falling back to text reply');
    } else {
      log.error('Voice reply failed', { error: err.message });
    }
    return { sent: false, error: err.message };
  }
}

module.exports = { sendVoiceReply, cleanTextForTTS };
