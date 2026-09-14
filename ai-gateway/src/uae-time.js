var UAE_TIME_ZONE = "Asia/Dubai";
function parsedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("valid UAE date required");
  return date;
}
function isoToUaeLocalInput(value) {
  if (!value)
    return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: UAE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(parsedDate(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function uaeLocalInputToIso(value) {
  const text = String(value || "").trim();
  if (!text)
    return null;
  const match2 = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match2)
    throw new Error("valid UAE date required");
  const [, year, month, day, hour, minute] = match2.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour - 4, minute));
  if (isoToUaeLocalInput(date.toISOString()) !== text)
    throw new Error("valid UAE date required");
  return date.toISOString();
}
function formatUaeTime(value) {
  if (!value)
    return "\u2014";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UAE_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(parsedDate(value)) + " GST";
}
var UAE_TIME_CLIENT_SOURCE = `
const UAE_TIME_ZONE = ${JSON.stringify(UAE_TIME_ZONE)};
${parsedDate.toString()}
${isoToUaeLocalInput.toString()}
${uaeLocalInputToIso.toString()}
${formatUaeTime.toString()}
`;
export { UAE_TIME_ZONE, parsedDate, isoToUaeLocalInput, uaeLocalInputToIso, formatUaeTime, UAE_TIME_CLIENT_SOURCE };
