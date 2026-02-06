# Multi-Client Chatbot Onboarding Guide

This guide details how to onboard new clients to the multi-client chatbot system. The system supports various business types (e.g., `salon`, `turf`, `ecommerce`, `clinic`) and allows dynamic configuration of credentials, calendars, and marketing templates per client.

## 1. Client Configuration (MongoDB)

Each client must have a document in the `clients` collection in MongoDB. This document controls their credentials, business logic, and integrations.

### Basic Structure
```json
{
  "clientId": "client_unique_id",
  "name": "Client Business Name",
  "email": "client@example.com",
  "businessType": "salon", // Options: 'salon', 'turf', 'ecommerce', 'clinic'
  "isActive": true,
  "config": {
    "timezone": "Asia/Kolkata",
    "currency": "INR"
  }
}
```

### Credentials & Integrations
You can store API tokens directly in the client document. If omitted, the system falls back to global `.env` variables (useful for testing or single-tenant setups).

```json
{
  "whatsappToken": "permanent_token_here",
  "verifyToken": "webhook_verify_token",
  "phoneNumberId": "whatsapp_phone_number_id",
  "openaiApiKey": "sk-...",
  "googleCalendarId": "primary" // or specific calendar ID
}
```

### Multi-Calendar Configuration (For Clinics/Salons)
For businesses with multiple resources (doctors, stylists), configure calendars in the `config` object:

```json
"config": {
  "calendars": {
    "Dr. Smith": "calendar_id_1@group.calendar.google.com",
    "Dr. Jones": "calendar_id_2@group.calendar.google.com"
  }
}
```

### Admin Phone Numbers
Configure who receives admin notifications (new leads, orders, etc.):

```json
"config": {
  "adminPhoneNumber": "919876543210", // Primary admin
  "adminPhones": ["919876543210", "918765432109"] // List of all admins
}
```

## 2. Marketing & Campaigns

The system supports CSV-based marketing campaigns.

### CSV Format
Upload a CSV file with the following headers:
- `phone`: (Required) The recipient's phone number (with or without country code).
- `name`: (Optional) Recipient's name for personalization.
- `date`: (Optional) For appointment reminders.
- `time`: (Optional) For appointment reminders.
- `doctor` / `stylist`: (Optional) For appointment reminders.

### Template Configuration
Map the internal template names to the actual template names created in WhatsApp Manager:

```json
"config": {
  "templates": {
    "birthday": "actual_birthday_template_name",
    "appointment": "actual_appointment_reminder_template_name",
    "general_offer": "actual_marketing_template_name"
  }
}
```

## 3. Environment Variables & Fallbacks

The system uses a tiered configuration approach:
1.  **Client Database Config**: Checked first.
2.  **Client-Specific Env**: `WHATSAPP_TOKEN_CLIENTID` (Legacy support).
3.  **Global Env**: `WHATSAPP_TOKEN` (Fallback for testing/temp tokens).

### Temporary Token Setup
For immediate testing with temporary tokens:
1.  Add `WHATSAPP_TOKEN` to your Render/System environment variables.
2.  Ensure the Client document exists in MongoDB.
3.  The system will automatically use the global token if the client document doesn't have one.

## 4. Onboarding Checklist

1.  [ ] **Create Client in MongoDB**: Insert the JSON document with `clientId` and `businessType`.
2.  [ ] **Configure Webhook**: Set the Callback URL in Meta Developer Portal to `https://your-url.com/webhook/client_id`.
3.  [ ] **Verify Token**: Ensure the `verifyToken` matches between MongoDB (or env) and Meta Portal.
4.  [ ] **Subscribe to Webhooks**: In Meta Portal, subscribe to `messages` field for the phone number.
5.  [ ] **Test Connection**: Send "Hi" to the number.
6.  [ ] **Upload Flow (Optional)**: If using Flows, ensure the Flow JSON is updated with the correct flow ID.
