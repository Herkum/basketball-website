// Small helpers shared between the public site (site.js) and the admin SPA
// (admin/app.js) — business rules like the season-boundary date and the
// Google Maps URL template, not just incidental code, so they live in one
// place instead of two copies that can silently drift.

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Basketball seasons span a calendar-year boundary (roughly Nov-Feb), so
// "this season" from July onward is year-(year+1); before that it's
// (year-1)-year.
function defaultSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}
