module.exports = {

  // ── ECOMMERCE TEMPLATE ────────────────────────────────────────────────────
  ecommerce: {
    nodes: [
      {
        id:   "trigger_start",
        type: "TriggerNode",
        position: { x: 300, y: 0 },
        data: { label: "Start Trigger", keyword: "hi" }
      },
      {
        id:   "welcome_node",
        type: "InteractiveNode",
        position: { x: 300, y: 120 },
        data: {
          label:   "Welcome",
          header:  "Welcome to {{brand_name}}! 👋",
          body:    "How can we help you today?",
          imageUrl: "",
          buttonsList: [
            { id: "btn_catalog", title: "🛍️ View Products" },
            { id: "btn_track",   title: "📦 Track Order"   },
            { id: "btn_human",   title: "💬 Talk to Us"    }
          ]
        }
      },
      {
        id:   "catalog_node",
        type: "MessageNode",
        position: { x: 80, y: 280 },
        data: {
          label: "Product Catalog",
          body:  "Here are our products! Reply with a number to learn more:\n\n{{product_list}}\n\nOr visit: {{store_url}}"
        }
      },
      {
        id:   "track_node",
        type: "MessageNode",
        position: { x: 300, y: 280 },
        data: {
          label: "Order Tracking",
          body:  "Please share your order number or phone used at checkout and I'll check your order status right away! 📦"
        }
      },
      {
        id:   "human_node",
        type: "MessageNode",
        position: { x: 520, y: 280 },
        data: {
          label:  "Connect to Team",
          body:   "Connecting you to our team! Someone will respond shortly. 💬",
          action: "ESCALATE_HUMAN"
        }
      },
      {
        id:   "product_detail_node",
        type: "InteractiveNode",
        position: { x: 80, y: 460 },
        data: {
          label: "Product Detail",
          body:  "Ready to order?",
          buttonsList: [
            { id: "btn_buy",  title: "🛒 Buy Now"       },
            { id: "btn_back", title: "⬅️ Back to Menu"  }
          ]
        }
      },
      {
        id:   "buy_node",
        type: "MessageNode",
        position: { x: 0, y: 640 },
        data: {
          label: "Buy Now",
          body:  "Great choice! 🎉 Click here to complete your order:\n\n👉 {{buy_url}}\n\nNeed help? Just reply here!"
        }
      },
      {
        id:   "back_menu_node",
        type: "InteractiveNode",
        position: { x: 200, y: 640 },
        data: {
          label: "Back to Menu",
          body:  "What else can I help you with?",
          buttonsList: [
            { id: "btn_catalog_2", title: "🛍️ Products" },
            { id: "btn_track_2",   title: "📦 Order"     },
            { id: "btn_human_2",   title: "💬 Team"      }
          ]
        }
      }
    ],
    edges: [
      { id: "e_trigger_welcome",  source: "trigger_start",       target: "welcome_node",       trigger: { type: "auto" }                                },
      { id: "e_welcome_catalog",  source: "welcome_node",        target: "catalog_node",       sourceHandle: "btn_catalog"                              },
      { id: "e_welcome_track",    source: "welcome_node",        target: "track_node",         sourceHandle: "btn_track"                                },
      { id: "e_welcome_human",    source: "welcome_node",        target: "human_node",         sourceHandle: "btn_human"                                },
      { id: "e_catalog_detail",   source: "catalog_node",        target: "product_detail_node",trigger: { type: "keyword", value: "product" }           },
      { id: "e_detail_buy",       source: "product_detail_node", target: "buy_node",           sourceHandle: "btn_buy"                                  },
      { id: "e_detail_back",      source: "product_detail_node", target: "back_menu_node",     sourceHandle: "btn_back"                                 },
      { id: "e_buy_back",         source: "buy_node",            target: "back_menu_node",     trigger: { type: "auto" }                                },
      { id: "e_back_catalog",     source: "back_menu_node",      target: "catalog_node",       sourceHandle: "btn_catalog_2"                            },
      { id: "e_back_track",       source: "back_menu_node",      target: "track_node",         sourceHandle: "btn_track_2"                              },
      { id: "e_back_human",       source: "back_menu_node",      target: "human_node",         sourceHandle: "btn_human_2"                              }
    ]
  },

  // ── APPOINTMENT TEMPLATE ──────────────────────────────────────────────────
  appointment: {
    nodes: [
      {
        id:   "trigger_start",
        type: "TriggerNode",
        position: { x: 300, y: 0 },
        data: { label: "Start", keyword: "hi" }
      },
      {
        id:   "welcome_node",
        type: "InteractiveNode",
        position: { x: 300, y: 120 },
        data: {
          label: "Welcome",
          body:  "Welcome to {{brand_name}}! 👋\n\nHow can we help you?",
          buttonsList: [
            { id: "btn_book",      title: "📅 Book Appointment" },
            { id: "btn_mybooking", title: "📋 My Bookings"      },
            { id: "btn_human",     title: "💬 Talk to Us"       }
          ]
        }
      },
      {
        id:   "service_node",
        type: "MessageNode",
        position: { x: 80, y: 300 },
        data: {
          label:  "Service Selection",
          body:   "Please select a service:\n\n{{service_list}}",
          action: "SHOW_SERVICES"
        }
      },
      {
        id:   "slot_node",
        type: "MessageNode",
        position: { x: 80, y: 460 },
        data: {
          label:  "Available Slots",
          body:   "Here are available slots:\n\n{{slot_list}}",
          action: "SHOW_SLOTS"
        }
      },
      {
        id:   "confirm_node",
        type: "InteractiveNode",
        position: { x: 80, y: 620 },
        data: {
          label: "Confirm Booking",
          body:  "Confirm your booking?\n\n📅 {{selected_slot}}\n💇 {{selected_service}}",
          buttonsList: [
            { id: "btn_confirm", title: "✅ Confirm" },
            { id: "btn_cancel",  title: "❌ Cancel"  }
          ]
        }
      },
      {
        id:   "booked_node",
        type: "MessageNode",
        position: { x: 80, y: 780 },
        data: {
          label: "Booking Confirmed",
          body:  "✅ Booking Confirmed!\n\n📅 {{selected_slot}}\n💇 {{selected_service}}\n\nSee you soon! 🙏\n\nReply 'reschedule' or 'cancel' to manage your booking."
        }
      },
      {
        id:   "my_bookings_node",
        type: "MessageNode",
        position: { x: 350, y: 300 },
        data: {
          label:  "My Bookings",
          body:   "Here are your upcoming appointments:\n\n{{my_bookings_list}}",
          action: "SHOW_MY_BOOKINGS"
        }
      },
      {
        id:   "human_node",
        type: "MessageNode",
        position: { x: 580, y: 300 },
        data: {
          label:  "Human Escalation",
          body:   "Connecting you to our team! 💬",
          action: "ESCALATE_HUMAN"
        }
      }
    ],
    edges: [
      { id: "e_trigger_welcome",   source: "trigger_start", target: "welcome_node",     trigger: { type: "auto" }                              },
      { id: "e_welcome_book",      source: "welcome_node",  target: "service_node",     sourceHandle: "btn_book"                               },
      { id: "e_welcome_mybooking", source: "welcome_node",  target: "my_bookings_node", sourceHandle: "btn_mybooking"                          },
      { id: "e_welcome_human",     source: "welcome_node",  target: "human_node",       sourceHandle: "btn_human"                              },
      { id: "e_service_slot",      source: "service_node",  target: "slot_node",        trigger: { type: "keyword", value: "select" }          },
      { id: "e_slot_confirm",      source: "slot_node",     target: "confirm_node",     trigger: { type: "keyword", value: "select" }          },
      { id: "e_confirm_yes",       source: "confirm_node",  target: "booked_node",      sourceHandle: "btn_confirm"                            },
      { id: "e_confirm_no",        source: "confirm_node",  target: "service_node",     sourceHandle: "btn_cancel"                             }
    ]
  },

  // ── TURF TEMPLATE ─────────────────────────────────────────────────────────
  turf: {
    nodes: [
      { id: "trigger_start", type: "TriggerNode", position: { x: 300, y: 0 },
        data: { label: "Start", keyword: "hi" } },
      { id: "welcome_node", type: "InteractiveNode", position: { x: 300, y: 120 },
        data: {
          label: "Welcome",
          body: "Welcome to {{brand_name}}! ⚽\n\nBook your turf slot today!",
          buttonsList: [
            { id: "btn_book",    title: "⚽ Book Slot"  },
            { id: "btn_pricing", title: "💰 Pricing"    },
            { id: "btn_human",   title: "💬 Contact Us" }
          ]
        }
      },
      { id: "surface_node", type: "InteractiveNode", position: { x: 80, y: 300 },
        data: {
          label: "Select Surface",
          body: "Which turf would you like?",
          buttonsList: [
            { id: "btn_turf_a", title: "🏟️ Turf A" },
            { id: "btn_turf_b", title: "🏟️ Turf B" }
          ]
        }
      },
      { id: "slot_node", type: "MessageNode", position: { x: 80, y: 460 },
        data: { label: "Available Slots", body: "{{slot_list}}", action: "SHOW_TURF_SLOTS" } },
      { id: "payment_node", type: "MessageNode", position: { x: 80, y: 620 },
        data: { label: "Payment", body: "Complete payment to confirm your slot:\n\n{{payment_link}}", action: "GENERATE_PAYMENT_LINK" } },
      { id: "confirmed_node", type: "MessageNode", position: { x: 80, y: 780 },
        data: { label: "Confirmed", body: "✅ Slot confirmed! See you on the turf! ⚽" } }
    ],
    edges: [
      { id: "e1", source: "trigger_start", target: "welcome_node",  trigger: { type: "auto" }                               },
      { id: "e2", source: "welcome_node",  target: "surface_node",  sourceHandle: "btn_book"                                },
      { id: "e3", source: "surface_node",  target: "slot_node",     sourceHandle: "btn_turf_a"                              },
      { id: "e4", source: "surface_node",  target: "slot_node",     sourceHandle: "btn_turf_b"                              },
      { id: "e5", source: "slot_node",     target: "payment_node",  trigger: { type: "keyword", value: "book" }             },
      { id: "e6", source: "payment_node",  target: "confirmed_node",trigger: { type: "keyword", value: "paid" }             }
    ]
  }

};
