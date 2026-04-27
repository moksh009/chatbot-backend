const fs = require('fs');
const file = '/Users/patelmoksh/LocalProjects/chatbot final/chatbot-backend-main/utils/whatsapp.js';
let content = fs.readFileSync(file, 'utf8');

const newFunc = `
  async sendInteractiveMessage(phoneNumberId, to, node, token) {
    const { interactiveType, body, buttonsList, sections,
            headerText, footerText } = node.data;
    
    // Validate phone format
    const phone = String(to).replace(/\\D/g, "");
    if (!phone || phone.length < 10) throw new Error("Invalid phone number");
    
    // Validate body
    if (!body || body.trim().length === 0) {
      throw new Error("Interactive message body cannot be empty");
    }
    
    let interactivePayload;
    
    if (interactiveType === "button") {
      // Validate buttons
      const buttons = (buttonsList || []).slice(0, 3); // Max 3
      if (buttons.length === 0) throw new Error("Button message needs at least 1 button");
      
      // Ensure unique IDs and valid titles
      const uniqueButtons = [];
      const seenIds = new Set();
      for (const btn of buttons) {
        const id = String(btn.id || \`btn_\${uniqueButtons.length + 1}\`);
        const title = String(btn.title || "Option").slice(0, 20); // Max 20 chars
        if (!seenIds.has(id)) {
          seenIds.add(id);
          uniqueButtons.push({ type: "reply", reply: { id, title } });
        }
      }
      
      interactivePayload = {
        type: "button",
        body: { text: String(body).slice(0, 1024) }, // Max 1024 chars
        action: { buttons: uniqueButtons }
      };
      
      // Optional header
      if (headerText && headerText.trim()) {
        interactivePayload.header = {
          type: "text",
          text: String(headerText).slice(0, 60)
        };
      }
      
      // Optional footer
      if (footerText && footerText.trim()) {
        interactivePayload.footer = {
          text: String(footerText).slice(0, 60)
        };
      }
      
    } else if (interactiveType === "list") {
      // Build sections
      const listSections = (sections || []).map(section => ({
        title: String(section.title || "Options").slice(0, 24),
        rows: (section.rows || []).slice(0, 10).map(row => ({
          id: String(row.id || \`row_\${Math.random().toString(36).slice(2, 6)}\`),
          title: String(row.title || "Option").slice(0, 24),
          description: row.description
            ? String(row.description).slice(0, 72)
            : undefined
        }))
      }));
      
      if (listSections.length === 0 || listSections[0].rows.length === 0) {
        throw new Error("List message needs at least 1 section with 1 row");
      }
      
      interactivePayload = {
        type: "list",
        body: { text: String(body).slice(0, 1024) },
        action: {
          button: String(node.data.listButtonText || "View Options").slice(0, 20),
          sections: listSections
        }
      };
      
      if (headerText && headerText.trim()) {
        interactivePayload.header = {
          type: "text",
          text: String(headerText).slice(0, 60)
        };
      }
      
      if (footerText && footerText.trim()) {
        interactivePayload.footer = {
          text: String(footerText).slice(0, 60)
        };
      }
    }
    
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "interactive",
      interactive: interactivePayload
    };
    
    console.log("[WA] Sending interactive:", JSON.stringify(payload, null, 2));
    
    const response = await axios.post(
      \`https://graph.facebook.com/v18.0/\${phoneNumberId}/messages\`,
      payload,
      {
        headers: {
          Authorization: \`Bearer \${token}\`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );
    
    return response.data;
  },
`;

content = content.replace('const WhatsApp = {', 'const WhatsApp = {' + newFunc);
fs.writeFileSync(file, content);
console.log('Added sendInteractiveMessage to WhatsApp');
