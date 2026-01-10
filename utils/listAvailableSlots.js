const { getAvailableSlots, getWorkingHours } = require('./getAvailableSlots');
const { DateTime } = require('luxon');

async function listAvailableSlotsForNext10WorkingDays() {
  let currentDate = DateTime.utc().setZone('Africa/Kampala').startOf('day');
  let workingDaysFound = 0;
  const maxWorkingDays = 10;

  console.log('================ AVAILABLE SLOTS FOR NEXT 10 WORKING DAYS ================\n');

  while (workingDaysFound < maxWorkingDays) {
    const dayOfWeek = currentDate.weekday % 7; // Luxon: Monday=1, Sunday=7
    const workingHours = getWorkingHours(dayOfWeek);
    if (!workingHours.isOpen) {
      currentDate = currentDate.plus({ days: 1 });
      continue;
    }
    const dateStr = currentDate.setZone('Africa/Kampala').toFormat('cccc, dd LLL yyyy');
    const result = await getAvailableSlots(dateStr, 0);
    console.log(`📅 ${dateStr} (${workingHours.start} - ${workingHours.end})`);
    if (result.totalSlots === 0) {
      console.log('   ❌ Fully booked (no available slots)');
    } else {
      result.slots.forEach((slot, idx) => {
        if (slot.slot) {
          console.log(`   ${idx + 1}. ${slot.title} (${slot.slot.startTime} - ${slot.slot.endTime})`);
        }
      });
    }
    console.log('');
    workingDaysFound++;
    currentDate = currentDate.plus({ days: 1 });
  }
  console.log('==========================================================================\n');
}

if (require.main === module) {
  listAvailableSlotsForNext10WorkingDays()
    .then(() => {
      console.log('✅ Done listing available slots for next 10 working days.');
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Error:', err);
      process.exit(1);
    });
} 