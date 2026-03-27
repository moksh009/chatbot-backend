module.exports = {

  // ── ECOMMERCE TEMPLATE ────────────────────────────────────────────────────
  ecommerce: {
    nodes: [
      {
        id: "trigger_start",
        type: "trigger",
        position: { x: 400, y: 0 },
        data: { label: "Start Trigger", keyword: "hi" }
      },
      {
        id: "welcome_node",
        type: "interactive",
        position: { x: 400, y: 150 },
        data: {
          label: "Welcome",
          header: "Welcome to {{brand_name}}! 👋",
          text: "How can we help you today? Explore our products or get support below.",
          buttonsList: [
            { id: "goto_products", title: "🛍️ View Products" },
            { id: "goto_support", title: "❓ Get Support" }
          ]
        }
      },
      {
        id: "folder_products",
        type: "folder",
        position: { x: 200, y: 350 },
        data: { label: "Product Management" }
      },
      {
        id: "folder_support",
        type: "folder",
        position: { x: 600, y: 350 },
        data: { label: "Customer Support" }
      },
      // --- Products Folder ---
      {
        id: "catalog_node",
        type: "message",
        parentId: "folder_products",
        position: { x: 100, y: 100 },
        data: {
          label: "Product Catalog",
          text: "Here are our bestsellers! 🛍️\n\n{{product_list}}\n\nReply with the product name to see more details."
        }
      },
      {
        id: "product_detail_node",
        type: "interactive",
        parentId: "folder_products",
        position: { x: 100, y: 300 },
        data: {
          label: "Product Detail",
          text: "This product is trending right now! Would you like to proceed to checkout?",
          buttonsList: [
            { id: "btn_buy", title: "🛒 Buy Now" },
            { id: "btn_back", title: "⬅️ Back to Shop" }
          ]
        }
      },
      {
        id: "buy_node",
        type: "message",
        parentId: "folder_products",
        position: { x: 100, y: 500 },
        data: {
          label: "Checkout",
          text: "Great choice! 🎉 Click the link below to complete your order securely:\n\n👉 {{buy_url}}"
        }
      },
      // --- Support Folder ---
      {
        id: "track_node",
        type: "message",
        parentId: "folder_support",
        position: { x: 100, y: 100 },
        data: {
          label: "Order Tracking",
          text: "I can help with that! 📦 Please provide your Order ID (starts with #) so I can fetch the status for you."
        }
      },
      {
        id: "human_node",
        type: "message",
        parentId: "folder_support",
        position: { x: 350, y: 100 },
        data: {
          label: "Talk to Agent",
          text: "Escalating your request to our team... 👤 One of our experts will join this chat in a few moments.",
          action: "ESCALATE_HUMAN"
        }
      }
    ],
    edges: [
      { id: "e_start", source: "trigger_start", target: "welcome_node", animated: true },
      { id: "e_welcome_prod", source: "welcome_node", target: "folder_products", sourceHandle: "goto_products", animated: true },
      { id: "e_welcome_supp", source: "welcome_node", target: "folder_support", sourceHandle: "goto_support", animated: true },
      // Internal Product Folder Connections (Logic will handle entry)
      { id: "e_folder_prod_entry", source: "folder_products", target: "catalog_node", animated: true },
      { id: "e_catalog_detail", source: "catalog_node", target: "product_detail_node", animated: true },
      { id: "e_detail_buy", source: "product_detail_node", target: "buy_node", sourceHandle: "btn_buy", animated: true },
      // Internal Support Folder Connections
      { id: "e_folder_supp_entry", source: "folder_support", target: "track_node", animated: true }
    ]
  },

  // ── APPOINTMENT TEMPLATE ──────────────────────────────────────────────────
  appointment: {
    nodes: [
      {
        id: "trigger_start",
        type: "trigger",
        position: { x: 400, y: 0 },
        data: { label: "Greeting", keyword: "hi" }
      },
      {
        id: "welcome_node",
        type: "interactive",
        position: { x: 400, y: 150 },
        data: {
          label: "Welcome",
          header: "Welcome to {{brand_name}}! ✨",
          text: "We are excited to serve you today! What can we help you with?",
          buttonsList: [
            { id: "goto_book", title: "📅 Book Now" },
            { id: "goto_my", title: "📋 My Appointments" }
          ]
        }
      },
      {
        id: "folder_booking",
        type: "folder",
        position: { x: 200, y: 350 },
        data: { label: "Booking System" }
      },
      {
        id: "folder_account",
        type: "folder",
        position: { x: 600, y: 350 },
        data: { label: "My Account" }
      },
      // --- Booking Folder ---
      {
        id: "service_node",
        type: "message",
        parentId: "folder_booking",
        position: { x: 100, y: 100 },
        data: {
          label: "Service List",
          text: "Please take a look at our services: \n\n{{service_list}}\n\nWhich one would you like to book?",
          action: "SHOW_SERVICES"
        }
      },
      {
        id: "slot_node",
        type: "message",
        parentId: "folder_booking",
        position: { x: 100, y: 250 },
        data: {
          label: "Select Slot",
          text: "Found some openings for you! 🕒\n\n{{slot_list}}\n\nWhich time works best?",
          action: "SHOW_SLOTS"
        }
      },
      {
        id: "confirm_node",
        type: "interactive",
        parentId: "folder_booking",
        position: { x: 100, y: 400 },
        data: {
          label: "Confirmation",
          text: "Perfect selection! Shall we confirm this slot for you?",
          buttonsList: [
            { id: "btn_confirm", title: "✅ Confirm Booking" },
            { id: "btn_cancel", title: "❌ Cancel" }
          ]
        }
      },
      {
        id: "booked_node",
        type: "message",
        parentId: "folder_booking",
        position: { x: 100, y: 550 },
        data: {
          label: "Thank You",
          text: "Everything set! 🎉 Your booking is confirmed. We've sent the details to your phone. See you soon!"
        }
      },
      // --- Account Folder ---
      {
        id: "my_bookings",
        type: "message",
        parentId: "folder_account",
        position: { x: 100, y: 100 },
        data: {
          label: "My Bookings",
          text: "Checking your schedule... 📅\n\n{{my_bookings_list}}",
          action: "SHOW_MY_BOOKINGS"
        }
      }
    ],
    edges: [
      { id: "e1", source: "trigger_start", target: "welcome_node", animated: true },
      { id: "e_go_book", source: "welcome_node", target: "folder_booking", sourceHandle: "goto_book", animated: true },
      { id: "e_go_account", source: "welcome_node", target: "folder_account", sourceHandle: "goto_my", animated: true },
      // Internal Folding logic
      { id: "e_fold_book", source: "folder_booking", target: "service_node", animated: true },
      { id: "e_serv_slot", source: "service_node", target: "slot_node", animated: true },
      { id: "e_slot_conf", source: "slot_node", target: "confirm_node", animated: true },
      { id: "e_conf_yes", source: "confirm_node", target: "booked_node", sourceHandle: "btn_confirm", animated: true },
      { id: "e_fold_acc", source: "folder_account", target: "my_bookings", animated: true }
    ]
  },

  // ── TURF TEMPLATE ─────────────────────────────────────────────────────────
  turf: {
    nodes: [
      { 
        id: "trigger_start", 
        type: "trigger", 
        position: { x: 400, y: 0 },
        data: { label: "Booking Trigger", keyword: "book" } 
      },
      { 
        id: "welcome_node", 
        type: "interactive", 
        position: { x: 400, y: 150 },
        data: {
          label: "Welcome",
          header: "Turf Booking ⚽",
          text: "Ready to play? Select an option to check availability or view our pricing.",
          buttonsList: [
            { id: "btn_book", title: "📅 Book Slot" },
            { id: "btn_pricing", title: "💰 Price List" }
          ]
        }
      },
      { 
        id: "surface_node", 
        type: "interactive", 
        position: { x: 400, y: 350 },
        data: {
          label: "Select Surface",
          text: "Which turf type would you like to book?",
          buttonsList: [
            { id: "btn_turf_a", title: "🏟️ Turf A (Main)" },
            { id: "btn_turf_b", title: "🏟️ Turf B (Small)" }
          ]
        }
      },
      { 
        id: "slot_node", 
        type: "message", 
        position: { x: 400, y: 500 },
        data: { 
          label: "Available Slots", 
          text: "Fetching available time slots for you... 🕒\n\n{{slot_list}}", 
          action: "SHOW_TURF_SLOTS" 
        } 
      },
      { 
        id: "payment_node", 
        type: "message", 
        position: { x: 400, y: 650 },
        data: { 
          label: "Payment", 
          text: "To confirm your slot, please complete the payment using the link below:\n\n💳 {{payment_link}}", 
          action: "GENERATE_PAYMENT_LINK" 
        } 
      },
      { 
        id: "confirmed_node", 
        type: "message", 
        position: { x: 400, y: 800 },
        data: { 
          label: "Confirmed", 
          text: "✅ Payment Received! Your slot is confirmed. See you on the turf! ⚽" 
        } 
      }
    ],
    edges: [
      { id: "e1", source: "trigger_start", target: "welcome_node", animated: true },
      { id: "e2", source: "welcome_node", target: "surface_node", sourceHandle: "btn_book", animated: true },
      { id: "e3", source: "surface_node", target: "slot_node", sourceHandle: "btn_turf_a", animated: true },
      { id: "e4", source: "surface_node", target: "slot_node", sourceHandle: "btn_turf_b", animated: true },
      { id: "e5", source: "slot_node", target: "payment_node", animated: true },
      { id: "e6", source: "payment_node", target: "confirmed_node", animated: true }
    ]
  }
};
