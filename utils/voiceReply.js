"use strict";

const textToSpeech = require("@google-cloud/text-to-speech");
const fs = require("fs");
const util = require("util");
const path = require("path");
const log = require("./logger")("VoiceReply");

/**
 * AI VOICE REPLY ENGINE — Phase 26
 * 
 * Converts AI text responses into high-quality Neural2 voice notes.
 */

let ttsClient;

function getTTSClient() {
  if (ttsClient) return ttsClient;

  const config = {};
  if (process.env.GOOGLE_TTS_KEY_FILE) {
    config.keyFilename = process.env.GOOGLE_TTS_KEY_FILE;
  } else if (process.env.GOOGLE_TTS_JSON) {
    try {
      config.credentials = JSON.parse(process.env.GOOGLE_TTS_JSON);
    } catch (e) {
      log.error("Failed to parse GOOGLE_TTS_JSON", e.message);
    }
  }

  ttsClient = new textToSpeech.TextToSpeechClient(config);
  return ttsClient;
}

/**
 * Generates an MP3 voice note from text and saves to public/voice.
 * 
 * @param {string} text - The response text
 * @param {string} langCode - Language code (en-IN or hi-IN)
 * @returns {Promise<string|null>} - Public URL of the voice note
 */
async function generateVoiceReply(text, langCode = "en-IN") {
  try {
    const client = getTTSClient();
    
    // Select the high-quality Neural2 voices as requested
    const voiceName = langCode === "hi-IN" ? "hi-IN-Neural2-A" : "en-IN-Neural2-A";

    const request = {
      input: { text },
      voice: { languageCode: langCode, name: voiceName, ssmlGender: "FEMALE" },
      audioConfig: { audioEncoding: "MP3" },
    };

    log.info(`Synthesizing voice for text: "${text.substring(0, 30)}..." using ${voiceName}`);
    
    const [response] = await client.synthesizeSpeech(request);
    
    const fileName = `voice_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
    const publicDir = path.join(__dirname, "../public/voice");
    const filePath = path.join(publicDir, fileName);

    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const writeFile = util.promisify(fs.writeFile);
    await writeFile(filePath, response.audioContent, "binary");

    const baseUrl = process.env.BASE_URL || "https://topedge-api.onrender.com"; // Fallback to provided prod URL pattern
    return `${baseUrl}/voice/${fileName}`;
  } catch (err) {
    log.error("Voice synthesis failed:", err.message);
    return null;
  }
}

module.exports = { generateVoiceReply };
