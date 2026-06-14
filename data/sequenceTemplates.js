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
    description: "Reduce no-shows with timely reminders. Legacy service-industry playbook (gated by env).",
    category:    "Service",
    channel:     "whatsapp",
    deprecated:  true,
    steps: [
      {
        order: 1, delayValue: 1440, delayUnit: "m",
        label: "24-hour reminder",
        type: "whatsapp", messageType: "text",
        content: "Hi {{name}}! 📅 Reminder: You have an appointment tomorrow.\n\nDate: *{{appointment_date}}*\nTime: *{{appointment_time}}*\nService: *{{service_name}}*\n\nNeed to reschedule? Reply here."
      },
      {
        order: 2, delayValue: 60, delayUnit: "m",
        label: "1-hour reminder",
        type: "whatsapp", messageType: "text",
        content: "⏰ Your appointment is in 1 hour, {{name}}!\n\nService: *{{service_name}}*\nTime: *{{appointment_time}}*\n\nSee you soon! 😊"
      }
    ]
  },
  {
    id:          "post_purchase_email_3step",
    name:        "Post-Purchase Email Follow-up",
    description: "Thank you → Review request → Loyalty offer — pure email for Indian D2C.",
    category:    "Retention",
    channel:     "email",
    icon:        "mail",
    steps: [
      {
        order: 1, delayValue: 1, delayUnit: "h",
        label: "Order thank you",
        type: "email",
        subject: "Thank you for your order, {{first_name}}! 🎉",
        content: "<p>Hi {{first_name}},</p><p>Your order from {{store_name}} is confirmed. We are preparing it with care.</p><p>Order total: {{order_total}}</p><p>Track updates in your inbox. For COD orders, please keep ₹ ready at delivery.</p><p>— Team {{store_name}}</p>"
      },
      {
        order: 2, delayValue: 3, delayUnit: "d",
        label: "Review request",
        type: "email",
        subject: "How was your experience, {{first_name}}?",
        content: "<p>Hi {{first_name}},</p><p>We would love to hear how your recent order from {{store_name}} went.</p><p>Your feedback helps other shoppers across India choose with confidence.</p><p>Reply to this email or leave a review on our store.</p>"
      },
      {
        order: 3, delayValue: 7, delayUnit: "d",
        label: "Loyalty offer",
        type: "email",
        subject: "A special offer just for you, {{first_name}} 🎁",
        content: "<p>Hi {{first_name}},</p><p>As a valued customer, here is <strong>10% off</strong> your next order at {{store_name}}.</p><p>Use code <strong>COMEBACK10</strong> at checkout.</p><p>Shop now: {{store_url}}</p>"
      }
    ]
  },
  {
    id:          "cart_recovery_email_sequence",
    name:        "Cart Recovery Email Sequence",
    description: "3-touch email recovery for abandoned carts — 30 min, 2 hours, 24 hours (IST-friendly).",
    category:    "E-commerce",
    channel:     "email",
    icon:        "shopping-cart",
    steps: [
      {
        order: 1, delayValue: 30, delayUnit: "m",
        label: "Cart reminder",
        type: "email",
        subject: "You left something behind, {{first_name}}!",
        content: "<p>Hi {{first_name}},</p><p>Your cart at {{store_name}} is still waiting:</p>{{cart_items_html}}<p>Total: {{cart_total}}</p><p><a href=\"{{cart_url}}\">Complete your order</a></p>"
      },
      {
        order: 2, delayValue: 2, delayUnit: "h",
        label: "5% off nudge",
        type: "email",
        subject: "Still thinking about it? Here is 5% off",
        content: "<p>Hi {{first_name}},</p><p>We saved your cart — take <strong>5% off</strong> with code <strong>CART5</strong>.</p>{{cart_items_html}}<p><a href=\"{{cart_url}}\">Checkout now</a></p>"
      },
      {
        order: 3, delayValue: 24, delayUnit: "h",
        label: "Last chance",
        type: "email",
        subject: "Last chance — your cart expires today",
        content: "<p>Hi {{first_name}},</p><p>This is your final reminder before your saved items at {{store_name}} expire.</p>{{cart_items_html}}<p><a href=\"{{cart_url}}\">Complete order before midnight</a></p>"
      }
    ]
  },
  {
    id:          "hybrid_wa_email",
    name:        "WhatsApp + Email Hybrid (3 days)",
    description: "WhatsApp on Day 1, Email on Day 3 — maximum reach for Indian D2C.",
    category:    "Sales",
    channel:     "both",
    icon:        "layers",
    steps: [
      {
        order: 1, delayValue: 0, delayUnit: "m",
        label: "WhatsApp intro",
        type: "whatsapp",
        messageType: "text",
        content: "Hi {{name}}! 👋 Thanks for connecting with {{store_name}}. We will follow up on WhatsApp and email so you never miss an update."
      },
      {
        order: 2, delayValue: 3, delayUnit: "d",
        label: "Email follow-up",
        type: "email",
        subject: "A quick note from {{store_name}}, {{first_name}}",
        content: "<p>Hi {{first_name}},</p><p>We reached out on WhatsApp — here is the same update by email in case you missed it.</p><p>Browse our latest picks: {{store_url}}</p><p>— {{store_name}}</p>"
      }
    ]
  }
];

module.exports = SEQUENCE_TEMPLATES;
