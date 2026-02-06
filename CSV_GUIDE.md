# CSV File Format Guide

This guide explains the CSV file formats required for uploading campaigns to the Chatbot Dashboard.

## 1. General / Birthday Campaign
Use this format for simple broadcasts or birthday wishes.

**Required Columns:**
- `phone` (The recipient's phone number, with or without country code)
- `name` (The recipient's name)

**Example:**
```csv
phone,name
919876543210,John Doe
919876543211,Jane Smith
```

---

## 2. Appointment Reminder Campaign
Use this format for sending appointment reminders.

**Required Columns:**
- `phone`
- `name`
- `date` (Format: YYYY-MM-DD)
- `time` (Format: HH:MM AM/PM or 24-hour)
- `summary` (Description of the service)
- `provider` (This column name changes based on your business type)

**Provider Column Name:**
- For **Clinics/Hospitals**: Use `doctor`
- For **Salons**: Use `stylist`
- For **Turfs/Gyms**: Use `coach`

**Example (Clinic):**
```csv
phone,name,date,time,summary,doctor
919876543210,Alice Brown,2024-03-25,10:00 AM,Dental Cleaning,Dr. Smith
919876543211,Bob White,2024-03-25,11:30 AM,Root Canal,Dr. Jones
```

**Example (Salon):**
```csv
phone,name,date,time,summary,stylist
919876543210,Alice Brown,2024-03-25,10:00 AM,Haircut,Sarah
919876543211,Bob White,2024-03-25,11:30 AM,Manicure,Jessica
```

**Example (Turf/Gym):**
```csv
phone,name,date,time,summary,coach
919876543210,Alice Brown,2024-03-25,10:00 AM,Personal Training,Coach Mike
919876543211,Bob White,2024-03-25,11:30 AM,Yoga Session,Coach Lisa
```

## Notes
- **Phone Numbers**: Can be 10 digits (e.g., `9876543210`) or include country code (e.g., `919876543210`). The system automatically adds `91` if missing.
- **File Type**: Must be `.csv`. Excel files (`.xlsx`) are not supported directly; please Save As CSV.
