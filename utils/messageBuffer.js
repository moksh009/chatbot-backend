class MessageBuffer {
    constructor() {
        this.buffers = new Map();
        this.timers = new Map();
        this.DEBOUNCE_MS = 4000;
    }

    /**
     * Accumulates messages from a user and triggers the callback once DEBOUNCE_MS has passed without new messages.
     * @param {string} waId - The user's WhatsApp ID.
     * @param {string} text - The incoming text message.
     * @param {Function} processCallback - The function to call with the concatenated message.
     */
    addMessage(waId, text, processCallback) {
        if (!this.buffers.has(waId)) {
            this.buffers.set(waId, []);
        }
        this.buffers.get(waId).push(text.trim());

        if (this.timers.has(waId)) {
            clearTimeout(this.timers.get(waId));
        }

        this.timers.set(waId, setTimeout(() => {
            const fullMessage = this.buffers.get(waId).join(" ");
            this.buffers.delete(waId);
            this.timers.delete(waId);
            processCallback(fullMessage);
        }, this.DEBOUNCE_MS));
    }
}

module.exports = new MessageBuffer();
