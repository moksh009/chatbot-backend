const { getAvailableSlots } = require('./utils/getAvailableSlots');
require('dotenv').config();

async function run() {
  try {
    const result = await getAvailableSlots('2026-03-05', 0, 'a209d6ace47f63e9ae6396119244ffe83eb76271250bd5aecb1e093c1ce5a328@group.calendar.google.com'); 
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("ERROR", err.message);
  } finally {
    process.exit(0);
  }
}
run();
