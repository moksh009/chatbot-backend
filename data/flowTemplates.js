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
          interactiveType: "button",
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
        id: "folder_recovery",
        type: "folder",
        position: { x: 400, y: 550 },
        data: { label: "Revenue Recovery (Automations)" }
      },
      // --- Recovery Folder ---
      {
        id: "browse_nudge_node",
        type: "message",
        parentId: "folder_recovery",
        position: { x: 100, y: 100 },
        data: {
          label: "Browse Nudge",
          role: "browse_nudge",
          text: "Hi {{name}}! 👋 We noticed you checking out our products. Need any help? 😊"
        }
      },
      {
        id: "abandoned_1_node",
        type: "message",
        parentId: "folder_recovery",
        position: { x: 100, y: 250 },
        data: {
          label: "Cart Recovery (15m)",
          role: "abandoned_1",
          text: "Hi {{name}}, you left {{items}} in your cart! 🛒 Grab them now before they're gone: {{cart_url}}"
        }
      },
      {
        id: "abandoned_2_node",
        type: "message",
        parentId: "folder_recovery",
        position: { x: 100, y: 400 },
        data: {
          label: "AI Negotiator (2h)",
          role: "abandoned_2",
          text: "Hey {{name}}, I'm your AI assistant. I saw you looking at {{items}}. Any questions I can help with? 🤖"
        }
      },
      {
        id: "abandoned_3_node",
        type: "message",
        parentId: "folder_recovery",
        position: { x: 100, y: 550 },
        data: {
          label: "Final Nudge (24h)",
          role: "abandoned_3",
          text: "🚨 Final call! Use code 'OFF10' for extra 10% off. Your cart is waiting! 🎁"
        }
      },
      {
        id: "upsell_node",
        type: "message",
        parentId: "folder_recovery",
        position: { x: 100, y: 700 },
        data: {
          label: "Post-Purchase Upsell",
          role: "upsell_1",
          text: "Hope you love your order! 🎉 Since you bought {{items}}, you might also like these recommended picks! 🛍️"
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
          role: "support",
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
      { id: "e_folder_supp_entry", source: "folder_support", target: "track_node", animated: true },
      // Recovery Flow (Logic driven, but visually connected in folder)
      { id: "e_folder_rec_entry", source: "folder_recovery", target: "browse_nudge_node", animated: true }
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
          interactiveType: "button",
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
          interactiveType: "button",
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
      { id: "trigger_start", type: "trigger", position: { x: 400, y: 0 }, data: { label: "Booking Trigger", keyword: "book" } },
      { id: "welcome_node", type: "interactive", position: { x: 400, y: 150 }, data: {
          label: "Welcome",
          interactiveType: "button",
          header: "Turf Booking ⚽",
          text: "Ready to play? Select an option to check availability or view our pricing.",
          buttonsList: [
            { id: "btn_book", title: "📅 Book Slot" },
            { id: "btn_pricing", title: "💰 Price List" }
          ]
        }
      },
      { id: "folder_booking", type: "folder", position: { x: 200, y: 350 }, data: { label: "Slot Booking" } },
      { id: "folder_pricing", type: "folder", position: { x: 600, y: 350 }, data: { label: "Pricing & Info" } },
      
      // --- Booking Folder ---
      { id: "surface_node", type: "interactive", parentId: "folder_booking", position: { x: 100, y: 100 }, data: {
          label: "Select Surface",
          interactiveType: "button",
          text: "Which turf type would you like to book?",
          buttonsList: [
            { id: "btn_turf_a", title: "🏟️ Turf A (Main)" },
            { id: "btn_turf_b", title: "🏟️ Turf B (Small)" }
          ]
        }
      },
      { id: "slot_node", type: "message", parentId: "folder_booking", position: { x: 100, y: 250 }, data: { 
          label: "Available Slots", 
          text: "Fetching available time slots for you... 🕒\n\n{{slot_list}}", 
          action: "SHOW_TURF_SLOTS" 
        } 
      },
      { id: "payment_node", type: "message", parentId: "folder_booking", position: { x: 100, y: 400 }, data: { 
          label: "Payment", 
          text: "To confirm your slot, please complete the payment using the link below:\n\n💳 {{payment_link}}", 
          action: "GENERATE_PAYMENT_LINK" 
        } 
      },
      { id: "confirmed_node", type: "message", parentId: "folder_booking", position: { x: 100, y: 550 }, data: { 
          label: "Confirmed", 
          text: "✅ Payment Received! Your slot is confirmed. See you on the turf! ⚽" 
        } 
      },
      
      // --- Pricing Folder ---
      { id: "pricing_node", type: "message", parentId: "folder_pricing", position: { x: 100, y: 100 }, data: {
          label: "Price List",
          text: "Our Current Rates 💰:\n\n- Weekdays: ₹1200/hr\n- Weekends: ₹1500/hr\n- Night Lights: +₹200/hr\n\nBook now to reserve your spot!"
        }
      }
    ],
    edges: [
      { id: "e1", source: "trigger_start", target: "welcome_node", animated: true },
      { id: "e_go_book", source: "welcome_node", target: "folder_booking", sourceHandle: "btn_book", animated: true },
      { id: "e_go_price", source: "welcome_node", target: "folder_pricing", sourceHandle: "btn_pricing", animated: true },
      { id: "e_fold_book", source: "folder_booking", target: "surface_node", animated: true },
      { id: "e3", source: "surface_node", target: "slot_node", sourceHandle: "btn_turf_a", animated: true },
      { id: "e4", source: "surface_node", target: "slot_node", sourceHandle: "btn_turf_b", animated: true },
      { id: "e5", source: "slot_node", target: "payment_node", animated: true },
      { id: "e6", source: "payment_node", target: "confirmed_node", animated: true },
      { id: "e_fold_price", source: "folder_pricing", target: "pricing_node", animated: true }
    ]
  },

  // ── SALON TEMPLATE ──────────────────────────────────────────────────────────
  salon: {
    nodes: [
      { id: "trigger_start", type: "trigger", position: { x: 400, y: 0 }, data: { label: "Salon Greeting", keyword: "hi" } },
      { id: "welcome_node", type: "interactive", position: { x: 400, y: 150 }, data: {
          label: "Welcome",
          interactiveType: "button",
          header: "Welcome to {{brand_name}} ✂️",
          text: "Look your best with our expert stylists. How can we help you today?",
          buttonsList: [
            { id: "btn_services", title: "💇‍♀️ Services Menu" },
            { id: "btn_book", title: "📅 Book Appointment" },
            { id: "btn_stylists", title: "⭐ Our Stylists" }
          ]
        }
      },
      { id: "f_services", type: "folder", position: { x: 100, y: 350 }, data: { label: "Services & Pricing" } },
      { id: "f_booking", type: "folder", position: { x: 400, y: 350 }, data: { label: "Appointment Booking" } },
      { id: "f_stylists", type: "folder", position: { x: 700, y: 350 }, data: { label: "Meet the Team" } },
      
      // --- Services Folder ---
      { id: "serv_list", type: "message", parentId: "f_services", position: { x: 100, y: 100 }, data: {
          label: "Hair Services",
          text: "✂️ Cutting: ₹500+\n🎨 Coloring: ₹1200+\n✨ Spa: ₹800+\n\nReply with 'book' to schedule yours!"
        }
      },
      
      // --- Booking Folder ---
      { id: "book_start", type: "message", parentId: "f_booking", position: { x: 100, y: 100 }, data: {
          label: "Pick Service",
          text: "Select the service you want to book from our list below:",
          action: "SHOW_SERVICES"
        }
      },
      { id: "book_slot", type: "message", parentId: "f_booking", position: { x: 100, y: 250 }, data: {
          label: "Pick Time",
          text: "Great! Here are the available slots for this week. 📅\n\n{{slot_list}}",
          action: "SHOW_SLOTS"
        }
      },
      { id: "book_thanks", type: "message", parentId: "f_booking", position: { x: 100, y: 400 }, data: {
          label: "Confirmation",
          text: "You are all set! 🎉 We have reserved your spot. See you at the salon!"
        }
      },

      // --- Stylists Folder ---
      { id: "stylist_list", type: "message", parentId: "f_stylists", position: { x: 100, y: 100 }, data: {
          label: "Our Experts",
          text: "Meet our Senior Stylists:\n\n- Priya (Hair Specialist)\n- Rohan (Master Barber)\n- Anjali (Bridal Expert)\n\nEach has 10+ years of experience! 🌟"
        }
      }
    ],
    edges: [
      { id: "e1", source: "trigger_start", target: "welcome_node" },
      { id: "e_to_serv", source: "welcome_node", target: "f_services", sourceHandle: "btn_services" },
      { id: "e_to_book", source: "welcome_node", target: "f_booking", sourceHandle: "btn_book" },
      { id: "e_to_sty", source: "welcome_node", target: "f_stylists", sourceHandle: "btn_stylists" },
      { id: "e_f_serv", source: "f_services", target: "serv_list" },
      { id: "e_f_book", source: "f_booking", target: "book_start" },
      { id: "e_b1", source: "book_start", target: "book_slot" },
      { id: "e_b2", source: "book_slot", target: "book_thanks" },
      { id: "e_f_sty", source: "f_stylists", target: "stylist_list" }
    ]
  }
};
