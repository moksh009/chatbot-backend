const SEQUENCE_TEMPLATES = [
  {
    id:          "tmpl_abandoned_cart_3step",
    name:        "Abandoned Cart Recovery (3-step)",
    description: "The most effective cart recovery sequence. Proven to recover 15-25% of abandoned carts.",
    category:    "E-commerce",
    channel:     "whatsapp",
    icon:        "shopping-cart",
    steps: [
      {
        order:       1,
        delayValue:  0,
        delayUnit:   "m",
        label:       "Immediate nudge",
        type:        "whatsapp",
        messageType: "text",
        content:     "Hey {{name}}! 👋 Looks like you left something behind.\n\n🛒 *{{cart_items_html}}*\n💰 Cart total: *{{cart_total}}*\n\nYour items are still saved! Complete your order here:\n{{cart_url}}"
      },
      {
        order:       2,
        delayValue:  2,
        delayUnit:   "h",
        label:       "2-hour urgency",
        type:        "whatsapp",
        messageType: "text",
        content:     "Hi {{name}}, just checking in! ⏰\n\nYour cart is still waiting — but items like *{{cart_items_html}}* sell out fast.\n\nComplete your order now before it's too late:\n{{cart_url}}"
      },
      {
        order:       3,
        delayValue:  24,
        delayUnit:   "h",
        label:       "Final offer with discount",
        type:        "whatsapp",
        messageType: "template",
        templateName: "", // User fills in
        note: "Requires an approved WhatsApp template. The AI Negotiator creates a discount code automatically."
      }
    ]
  },
  {
    id:          "tmpl_win_back_30day",
    name:        "Win-Back Campaign (30-day inactive)",
    description: "Re-engage customers who haven't ordered in 30+ days.",
    category:    "Retention",
    channel:     "whatsapp",
    steps: [
      {
        order: 1, delayValue: 0, delayUnit: "m",
        label: "We miss you",
        type: "whatsapp", messageType: "text",
        content: "Hey {{name}}! 👋 It's been a while since we last saw you.\n\nWe've got some exciting new products and a special offer just for you:\n\n🎁 *{{discount_code}}* — Use this for 10% off your next order!\n\nValid for 48 hours only. Shop here: {{store_url}}"
      },
      {
        order: 2, delayValue: 48, delayUnit: "h",
        label: "Discount expiry reminder",
        type: "whatsapp", messageType: "text",
        content: "Hi {{name}}, your exclusive 10% discount *{{discount_code}}* expires in a few hours! ⏰\n\nDon't miss out: {{store_url}}"
      }
    ]
  },
  {
    id:          "tmpl_post_purchase_review",
    name:        "Post-Purchase Review Collection",
    description: "Collect reviews and build brand reputation automatically.",
    category:    "E-commerce",
    channel:     "whatsapp",
    steps: [
      {
        order: 1, delayValue: 1, delayUnit: "d",
        label: "Thank you + expectations",
        type: "whatsapp", messageType: "text",
        content: "Hi {{name}}! 🎉 Your order #{{order_id}} has been confirmed.\n\nWe're preparing it with care and will notify you when it ships! 🚚\n\nQuestions? Just reply here — we're always available."
      },
      {
        order: 2, delayValue: 5, delayUnit: "d",
        label: "Review request",
        type: "whatsapp", messageType: "template",
        templateName: "",
        note: "Use a review request template with thumbs up/down buttons"
      }
    ]
  },
  {
    id:          "tmpl_new_lead_nurture",
    name:        "New Lead Nurture (5-day)",
    description: "Warm up new leads who haven't purchased yet.",
    category:    "Sales",
    channel:     "whatsapp",
    steps: [
      {
        order: 1, delayValue: 0,  delayUnit: "m", label: "Welcome + catalog",
        type: "whatsapp", messageType: "text",
        content: "Hi {{name}}! Welcome! 👋 I wanted to personally share our top products with you.\n\nBrowse our catalog: {{store_url}}\n\nAny questions — I'm right here!"
      },
      {
        order: 2, delayValue: 1,  delayUnit: "d", label: "Social proof",
        type: "whatsapp", messageType: "text",
        content: "Hey {{name}}! ⭐\n\nThought you'd like to know — over 1,000 happy customers love our products.\n\n\"Amazing quality!\" — Priya, Mumbai\n\"Fast delivery, great service\" — Rahul, Delhi\n\nShop now: {{store_url}}"
      },
      {
        order: 3, delayValue: 3,  delayUnit: "d", label: "Special offer",
        type: "whatsapp", messageType: "text",
        content: "Hi {{name}}! 🎁 I wanted to give you something special.\n\nUse *WELCOME10* for 10% off your first order.\n\nValid for 24 hours: {{store_url}}"
      },
      {
        order: 4, delayValue: 5,  delayUnit: "d", label: "Final follow-up",
        type: "whatsapp", messageType: "text",
        content: "{{name}}, this is my final nudge (I promise! 😄)\n\nIf you have any questions or want personalized recommendations, just reply to this message.\n\nI'd love to help you find the perfect product!"
      }
    ]
  },
  {
    id:          "tmpl_appointment_reminder",
    name:        "Appointment Reminder Sequence",
    description: "Reduce no-shows with timely reminders.",
    category:    "Service",
    channel:     "whatsapp",
    steps: [
      {
        order: 1, delayValue: 1440, delayUnit: "m",  // 24 hours before
        label: "24-hour reminder",
        type: "whatsapp", messageType: "text",
        content: "Hi {{name}}! 📅 Reminder: You have an appointment tomorrow.\n\nDate: *{{appointment_date}}*\nTime: *{{appointment_time}}*\nService: *{{service_name}}*\n\nNeed to reschedule? Reply here."
      },
      {
        order: 2, delayValue: 60,   delayUnit: "m",  // 1 hour before
        label: "1-hour reminder",
        type: "whatsapp", messageType: "text",
        content: "⏰ Your appointment is in 1 hour, {{name}}!\n\nService: *{{service_name}}*\nTime: *{{appointment_time}}*\n\nSee you soon! 😊"
      }
    ]
  }
];

module.exports = SEQUENCE_TEMPLATES;
