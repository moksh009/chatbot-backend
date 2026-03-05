const { getAvailableSlots } = require('./utils/getAvailableSlots');
require('dotenv').config();

async function run() {
  try {
    console.log("Starting test...");
    const result = await getAvailableSlots('2026-03-05', 0, 'a209d6ace47f63e9ae6396119244ffe83eb76271250bd5aecb1e093c1ce5a328@group.calendar.google.com');
    console.log("Result slots length:", result.slots.length);
  } catch (e) {
    console.error("Failed:", e);
  } finally {
    process.exit(0);
  }
}
run();
