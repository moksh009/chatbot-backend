const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// Input and output file paths
const inputFile = path.join(__dirname, 'public/images/contacts.csv');
const outputFile = path.join(__dirname, 'public/images/contacts.json');

const results = [];

// Helper function to sanitize phone numbers for WhatsApp API
function sanitizePhone(rawPhone) {
    if (!rawPhone) return null;

    // Split by ":::" and commas, handle multiple phone numbers in one field
    const parts = rawPhone.split(/:::|,/).map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length === 0) return null;

    for (const part of parts) {
        // Keep only numeric characters
        let digits = part.replace(/\D/g, '');

        // Sometimes numbers start with multiple zeros
        while (digits.startsWith('0')) {
            digits = digits.substring(1);
        }

        // Phone formatting logic
        if (digits.length === 10) {
            // Assuming Indian number if 10 digits
            return '91' + digits;
        } else if (digits.length === 12 && digits.startsWith('91')) {
            // Already has India country code
            return digits;
        } else if (digits.length > 10) {
            // It might be another country code, return as is. Or fallback
            if (digits.startsWith('91')) {
                return digits;
            }
            return digits;
        }
    }

    return null;
}

// Ensure the input file exists before continuing
if (!fs.existsSync(inputFile)) {
    console.error(`Error: Could not find input file at ${inputFile}`);
    process.exit(1);
}

console.log(`Starting to read ${inputFile}...`);

fs.createReadStream(inputFile)
    .pipe(csv())
    .on('data', (data) => {
        // Identify the columns
        const firstName = data['First Name'] ? data['First Name'].trim() : '';
        const middleName = data['Middle Name'] ? data['Middle Name'].trim() : '';
        const lastName = data['Last Name'] ? data['Last Name'].trim() : '';

        // Find Phone 1 - Value regardless of trailing spaces
        const phoneKey = Object.keys(data).find(k => k.trim() === 'Phone 1 - Value');
        const rawPhone = phoneKey ? data[phoneKey] : null;

        const sanitizedPhone = sanitizePhone(rawPhone);

        // Only add to list if there's a valid phone number
        if (sanitizedPhone) {
            results.push({
                firstName,
                middleName,
                lastName,
                phone: sanitizedPhone
            });
        }
    })
    .on('end', () => {
        // Filter duplicates by phone number
        const uniqueResults = [];
        const phoneSet = new Set();

        for (const item of results) {
            if (!phoneSet.has(item.phone)) {
                uniqueResults.push(item);
                phoneSet.add(item.phone);
            }
        }

        console.log(`Finished reading. Discovered ${results.length} total contacts.`);
        console.log(`Filtered down to ${uniqueResults.length} unique WhatsApp contacts.`);

        fs.writeFileSync(outputFile, JSON.stringify(uniqueResults, null, 2));
        console.log(`✅ Success! JSON file saved to: ${outputFile}`);
    })
    .on('error', (err) => {
        console.error('Error parsing CSV:', err);
    });
