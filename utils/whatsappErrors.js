/**
 * Helper to translate raw Meta WhatsApp API errors into human-readable strings.
 * Helps users quickly identify fixing methods without inspecting technical payloads.
 */
function translateWhatsAppError(errorData) {
    if (!errorData) return "An unknown error occurred sending the message. Please try again.";

    // Normalize error extracting the actual underlying Meta error object
    const errorObj = errorData.error || errorData;

    const message = errorObj.message || String(errorObj);
    const code = errorObj.code;
    const details = errorObj.error_data?.details || "";

    // 1. Template does not exist / pending approval
    if (code === 132001 || message.includes("Template name does not exist")) {
        return `Template '${details.match(/\((.*?)\)/)?.[1] || 'selected'}' doesn't exist or isn't approved in Meta. Please check your Meta WhatsApp Manager.`;
    }

    // 2. Mismatched parameter count
    if (message.includes("number of parameters does not match") || details.includes("mismatch")) {
        return "Variable Mismatch: The selected template requires variables but incorrect data was provided. Check your template configuration.";
    }

    // 3. User outside 24-hour window for normal text messages
    if (code === 131047 || message.includes("More than 24 hours")) {
        return "Message failed: It has been over 24 hours since the user last replied. You must use an approved Meta Template to initiate a new session.";
    }

    // 4. Invalid token / OAuth Exception
    if (code === 190 || errorObj.type === "OAuthException" || message.includes("Error validating access token")) {
        return "Authentication Error: Your WhatsApp token has expired or is invalid. Please reconnect your Meta account in Configurations.";
    }

    // 5. Invalid Phone Number
    if (code === 131026 || message.includes("not a valid WhatsApp user")) {
        return "Delivery failed: The recipient phone number is not a valid or registered WhatsApp number.";
    }

    // 6. Template Paused by Meta
    if (code === 132015 || message.includes("Template is paused")) {
        return "Template paused: Meta has paused this template due to low quality. Please choose another template.";
    }

    // Return the translated message or fallback to the details/message if not matched
    return details || message || "Delivery failed: Meta API rejected the message structure.";
}

module.exports = { translateWhatsAppError };
