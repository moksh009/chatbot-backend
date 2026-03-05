const { DateTime } = require('luxon');

const workingHours = { start: '10:00', end: '24:00', isOpen: true };
const dateIST = DateTime.now().setZone('Asia/Kolkata').startOf('day');

const slots = [];
const [startHour, startMinute] = workingHours.start.split(':').map(Number);
const [endHour, endMinute] = workingHours.end.split(':').map(Number);

let slotStart = dateIST.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });
const endOfDay = (endHour >= 24) 
  ? dateIST.endOf('day') 
  : dateIST.set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 });

console.log('Start', slotStart.toISO());
console.log('End', endOfDay.toISO());

let iters = 0;
while (slotStart.isValid && slotStart < endOfDay && iters < 50) {
  iters++;
  let slotEnd = slotStart.plus({ minutes: 30 });
  console.log('Iter', iters, slotStart.toFormat('HH:mm'), '->', slotEnd.toFormat('HH:mm'));
  if (!slotEnd.isValid || slotEnd > endOfDay) break;

  // Safety catch to prevent infinite loops if slotEnd evaluates incorrectly
  if (slotEnd <= slotStart) break;

  slots.push(slotEnd);
  slotStart = slotEnd;
}
console.log('Finished with', slots.length, 'slots');
