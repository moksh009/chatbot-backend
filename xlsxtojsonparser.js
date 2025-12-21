const xlsx = require('xlsx');
const fs = require('fs');

// Load workbook
const workbook = xlsx.readFile('./birthdays.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];

// Convert sheet to array of rows
const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

const result = [];

for (let i = 1; i < data.length; i++) {
  const row = data[i];
  const number = row[0];
  const mmdd = row[2];

  if (!number || !mmdd) continue;

  const [monthStr, dayStr] = mmdd.split('-');

  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  result.push({
    number: number.toString().trim(),
    month,
    day,
    isOpted: true,
    optedOutOn: ""
  });
}

fs.writeFileSync('birthdays.json', JSON.stringify(result, null, 2));
console.log("✅ Done: birthdays.json generated.");
