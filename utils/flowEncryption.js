const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Meta WhatsApp Flow Encryption Utility
 * Handles decryption of incoming flow data and encryption of outgoing responses.
 */

const decryptFlowData = (body, privateKeyPath = 'private.pem') => {
  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;
    const privateKey = fs.readFileSync(path.join(process.cwd(), privateKeyPath), 'utf8');

    // 1. Decrypt AES Key
    const aesKey = crypto.privateDecrypt({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    }, Buffer.from(encrypted_aes_key, 'base64'));

    const algorithm = `aes-${aesKey.length * 8}-gcm`;

    // 2. Decrypt Flow Data
    const iv = Buffer.from(initial_vector, 'base64');
    const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const authTagLength = 16;
    const authTag = flowDataBuffer.slice(flowDataBuffer.length - authTagLength);
    const ciphertext = flowDataBuffer.slice(0, flowDataBuffer.length - authTagLength);

    const decipher = crypto.createDecipheriv(algorithm, aesKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    
    return {
      decryptedBody: JSON.parse(decrypted),
      aesKey,
      iv,
      algorithm
    };
  } catch (err) {
    console.error('[FlowEncryption] Decryption error:', err.message);
    throw err;
  }
};

const encryptFlowResponse = (payload, aesKey, iv, algorithm) => {
  try {
    // Encrypt Response (Using strict Buffer map for bitwise NOT for the response IV)
    const flippedIvBuffer = Buffer.from(iv.map(b => ~b & 0xFF));
    const cipher = crypto.createCipheriv(algorithm, aesKey, flippedIvBuffer);

    const responseCiphertext = cipher.update(JSON.stringify(payload), 'utf8');
    const finalBuffer = cipher.final();
    const authTagOut = cipher.getAuthTag();

    const encryptedPayload = Buffer.concat([responseCiphertext, finalBuffer, authTagOut]);
    return encryptedPayload.toString('base64');
  } catch (err) {
    console.error('[FlowEncryption] Encryption error:', err.message);
    throw err;
  }
};

module.exports = { decryptFlowData, encryptFlowResponse };
