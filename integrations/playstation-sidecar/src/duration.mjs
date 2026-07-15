export function durationToMinutes(value) {
  if (typeof value !== "string") return 0;
  const match = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return 0;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const total = Number(days) * 1440 + Number(hours) * 60 + Number(minutes) + Number(seconds) / 60;
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
}
