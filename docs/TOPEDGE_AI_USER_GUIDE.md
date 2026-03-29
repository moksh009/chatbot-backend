# TopEdge AI: Comprehensive User Guide & Feature Documentation

Welcome to TopEdge AI! This guide explains how to use our advanced WhatsApp automation platform to scale your business, recover abandoned carts, and optimize your customer journey.

---

### 1. Connecting Your Shopify Store
To leverage the full power of TopEdge AI (Abandoned Carts, Order Sync, Discounts), you must connect your Shopify store.

**The Process:**
1.  **Shopify Admin**: Go to `Settings` > `Apps and sales channels` > `Develop apps`.
2.  **Create Custom App**: Name it "TopEdge AI".
3.  **Configure Admin API Scopes**: Grant the following permissions:
    *   `write_orders` / `read_orders`
    *   `write_checkouts` / `read_checkouts`
    *   `write_price_rules` / `read_price_rules` (CRITICAL for AI Discounts)
    *   `write_products` / `read_products`
4.  **Install App**: Once scopes are saved, click "Install App."
5.  **Get Credentials**:
    *   **Admin API Access Token**: (Starts with `shpat_`) — Copy this.
    *   **API Secret Key**: Copy this.
6.  **TopEdge Dashboard**: Go to `Settings` > `Connect Shopify` and enter your **Shop Domain**, **Access Token**, and **Client Secret**.

---

### 2. Abandoned Cart Recovery (How It Works)
Our system follows an intelligent 3-stage sequence to recover lost sales.

*   **Stage 1 (15 Minutes)**: A friendly WhatsApp "nudge" using the `cart_remainder` template.
*   **Stage 2 (2 Hours) — The AI Negotiator**: Gemini AI crafts a human-like message. If enabled, the system automatically creates a **Dynamic Shopify Discount** (e.g., `SAVE10-XXXX`) for that specific lead.
*   **Stage 3 (24 Hours)**: A final "FOMO" reminder before the cart expires.

---

### 3. COD to Prepaid Conversion
Detected automatically when a customer chooses "Cash on Delivery" at checkout.

1.  **Detection**: The system identifies the payment gateway as manual/COD.
2.  **Incentive**: Sends an automated WhatsApp: *"Pay now via UPI/Razorpay and get ₹50 cashback + Priority Shipping!"*
3.  **Automation**: Once paid, TopEdge AI automatically updates the Shopify order status to **"Paid"**.

---

### 4. Advanced Flow Builder Tactics
Organize your complex bots using Folders and Redirections.

#### **Folder Groups (The Containers)**
*   **Purpose**: Structural nesting (like directories).
*   **Connection**: Connecting a node directly to a Folder Group node moves the user into that sub-flow.
*   **Use-case**: Separate "Catalog Browsing" from "Support Tickets".

#### **Flow Redirection (The Jumper)**
*   **Purpose**: Jumping between sequences (like a `GOTO` command).
*   **Action**: Click "Select Folder..." in the Redirection node to pick your destination.
*   **Action**: Use this to "teleport" users back to the Main Menu or a Success page without cluttering the canvas with long lines.

---

### 5. AI Power Tools: Fix with AI ✨
Having trouble with your flow health? Use the **"Fix with AI"** button in the issue panel (footer).

*   **Detection**: The panel lists issues like "Missing Text" or "Disconnected Nodes".
*   **Action**: Click the button, and Gemini AI will automatically fill in professional copy and suggest logical connections to make your flow perfect.

---

### 6. Human Handover System
When a conversation requires the "human touch":
1.  **The Node**: Use a `LiveChatNode` (Headset icon) in your flow.
2.  **Logic**: When reached, the AI auto-reply is **paused** for that user.
3.  **Action**: The conversation moves to the **Live Chat** tab in your dashboard for manual response.
