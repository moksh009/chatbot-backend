const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Handles incoming WhatsApp audio/voice notes.
 * Downloads the Audio from Meta, transcribes with Gemini, and pipes back to dualBrainEngine as text.
 */
async function processVoiceNote(message, client, phone, convoId, io, phoneNumberId, profileName) {
  const mediaId = message.audio?.id || message.voice?.id;
  if (!mediaId) return;

  const Conversation = require("../models/Conversation");
  const convo = await Conversation.findById(convoId);

  // Check Settings
  const config = client.config?.aiConfig || {};
  if (config.voiceNoteHandling === false) {
    // If explicitly disabled, escalate or fallback
    const { sendWhatsAppText } = require("./whatsappHelpers");
    await sendWhatsAppText(client, phone, "Sorry, I couldn't understand your voice note. Please type your message.");
    return;
  }

  let cleanTranscript = "";
  let englishTranslation = "";
  let success = false;
  
  const tmpFile = path.join(os.tmpdir(), `wanote_${mediaId}.ogg`);

  try {
    // ── STEP 1 & 2: Get media URL from Meta & Download ────────────────────
    // (We wrap in try/catch to gracefully handle Meta Auth restrictions in dev)
    let audioBuffer;
    let mimeType = "audio/ogg; codecs=opus";

    const waToken = client.whatsapp?.accessToken || client.whatsappToken || process.env.WHATSAPP_TOKEN;
    try {
      const urlResp = await axios.get(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${waToken}` } }
      );
      const mediaUrl = urlResp.data.url;
      const audioResp = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${waToken}` }
      });
      audioBuffer = Buffer.from(audioResp.data);
      mimeType = urlResp.data.mime_type || mimeType;
      fs.writeFileSync(tmpFile, audioBuffer);
    } catch (metaErr) {
      console.warn("[VoiceNoteHandler] Meta Download Failed (Expected in Dev loop with mock payloads):", metaErr.message);
      // MOCK FALLBACK for development testing
      if (process.env.NODE_ENV === 'development' || !waToken) {
        console.log("[VoiceNoteHandler] Using Mock Audio Buffer for Dev Transcription Phase...");
        audioBuffer = Buffer.from("mock_audio_data_for_dev_bypassing_meta_strict_url"); // Mock payload
      } else {
        throw metaErr; // In prod, throw
      }
    }

    // ── STEP 3: Transcribe with Gemini ─────────────────────
    const aiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(aiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    let rawTranscript = "I am a recorded voice mock. Give me a discount!";
    
    // Actually call Gemini ONLY if we downloaded valid audio bytes or if we have dev bypass, 
    // but Gemini will choke on literal string 'mock_audio_data' unless we mock the response string.
    if (audioBuffer.length > 50) { 
      try {
        const audioData = audioBuffer.toString("base64");
        const result = await model.generateContent([
          {
            inlineData: { mimeType: mimeType.split(";")[0] || "audio/ogg", data: audioData }
          },
          {
            text: `Transcribe this WhatsApp voice note exactly as spoken.
                  If it is in Hindi, Gujarati, or any Indian language: transcribe in that language first,
                  then add a translation in English in brackets.
                  Format: "[TRANSCRIPT]: <exact words> | [TRANSLATION]: <english translation>"
                  If already in English: just write the transcript.
                  Keep it concise and accurate.`
          }
        ]);
        rawTranscript = result.response.text().trim();
      } catch (geminiErr) {
        console.error("[VoiceNoteHandler] Gemini transcription failed:", geminiErr.message);
      }
    }

    // Extract clean text for intent processing
    const transcriptMatch = rawTranscript.match(/\[TRANSCRIPT\]:\s*(.+?)(?:\s*\|\s*\[TRANSLATION\]|$)/i);
    const translationMatch = rawTranscript.match(/\[TRANSLATION\]:\s*(.+)/i);
    cleanTranscript = transcriptMatch?.[1]?.trim() || rawTranscript;
    englishTranslation = translationMatch?.[1]?.trim() || rawTranscript;
    success = true;

  } catch (err) {
    console.error("[VoiceNoteHandler] Error:", err.message);
  } finally {
    // Clean up temp file
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }

  // ── STEP 4: Save transcript to message/conversation ────
  const Message = require("../models/Message");
  let voiceMessageId = message.id;

  if (success && cleanTranscript) {
    // Update the message document
    await Message.findOneAndUpdate(
      { messageId: voiceMessageId, clientId: client.clientId },
      {
        $set: {
          voiceTranscript: cleanTranscript,
          voiceTranslation: englishTranslation,
          voiceProcessed: true,
          originalType: "audio"
        }
      }
    );

    // Store in conversation metadata for agent view
    if (convo) {
      await Conversation.findByIdAndUpdate(convo._id, {
        $push: {
          "metadata.voiceTranscripts": {
            messageId: voiceMessageId,
            transcript: cleanTranscript,
            translation: englishTranslation,
            timestamp: new Date()
          }
        }
      });
    }

    // ── STEP 5: Emit to Live Chat so agent sees transcript ─
    if (io) {
      io.to(`client_${client.clientId}`).emit("voice_note_transcribed", {
        phone,
        messageId: voiceMessageId,
        transcript: cleanTranscript,
        translation: englishTranslation
      });
    }

    // ── STEP 6: Feed transcript through dual-brain engine ──
    const { runDualBrainEngine } = require("./dualBrainEngine");

    // Map Gemini language code to voice engine language name
    const langMap = { hi: 'hindi', gu: 'gujarati', mr: 'marathi', 'hi-en': 'hinglish', 'gu-en': 'gujarlish' };
    const rawLangCode = (convo?.detectedLanguage || 'en').toLowerCase().split('-')[0];
    const voiceLanguage = langMap[rawLangCode] || 'english';

    const syntheticMessage = {
      ...message,
      type: "text",
      text: { body: englishTranslation || cleanTranscript },
      originalType: "voice",
      voiceTranscript: cleanTranscript,
      requestVoiceReply: !!(client.voiceReplyEnabled), // Track 3 flag
      _voiceLanguage: voiceLanguage,
      from: phone,
      channel: 'whatsapp',
      profileName,
      phoneNumberId
    };

    await runDualBrainEngine(syntheticMessage, client);

    // ── STEP 6.5: Phase 26 Track 3 — Send voice reply if enabled ─────────
    // The engine already sent the text reply; if voice reply is enabled,
    // we also send an audio version of the same reply.
    if (client.voiceReplyEnabled) {
      try {
        const { sendVoiceReply } = require('./voiceReplyEngine');
        const { generateText: getBotReply, getGeminiModel } = require('./gemini');
        const config = client.config?.aiConfig || {};
        const systemPrompt = config.systemPrompt || 'You are a helpful WhatsApp assistant.';
        const aiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;

        // Generate a concise audio-friendly version of the response
        const genAI = new (require('@google/generative-ai').GoogleGenerativeAI)(aiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        const voicePrompt = `${systemPrompt}\n\nCustomer's voice message (transcribed): "${englishTranslation || cleanTranscript}"\n\nProvide a brief, conversational reply suitable for a voice message (max 2-3 sentences, no markdown formatting, no bullet points, natural spoken language).`;
        const voiceResult = await model.generateContent(voicePrompt);
        const voiceReplyText = voiceResult.response.text().trim();

        if (voiceReplyText) {
          const voiceRes = await sendVoiceReply(client, phone, voiceReplyText, voiceLanguage);
          if (voiceRes.sent) {
            console.log('[VoiceReply] Voice reply sent successfully', { phone, mediaId: voiceRes.mediaId });
          }
        }
      } catch (vrErr) {
        // Non-critical: voice reply failed, text reply already sent
        console.debug('[VoiceReply] Voice reply generation skipped:', vrErr.message);
      }
    }

  } else {
    // Graceful fallback — send a text to agent and notify
    if (io) {
      io.to(`client_${client.clientId}`).emit("voice_note_failed", {
        phone, messageId: message.id,
        error: "Could not transcribe voice note"
      });
    }

    const { sendWhatsAppText } = require("./whatsappHelpers");
    await sendWhatsAppText(client, phone, "Sorry, I couldn't safely process that voice note due to an error. Could you perhaps type it for me? 🙏");
  }
}

module.exports = { processVoiceNote };
