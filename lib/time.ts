export function shanghaiDayStart(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 60 * 60 * 1000).toISOString();
}

export function isIdleTime(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).getUTCHours() < 8;
}
