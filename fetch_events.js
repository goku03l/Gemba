// Runs inside GitHub Actions on a schedule. Not run in the browser.
// Calls Google Custom Search with secrets that never touch the client,
// writes results into data/events.json, and pings Telegram if configured.
//
// Hard stop: at most MAX_RUNS_PER_DAY actual searches per calendar day (UTC).
// The count lives in data/events.json, so manual re-runs from the Actions tab
// can't blow past the daily cap.

const fs = require('fs');
const path = require('path');

const MAX_RUNS_PER_DAY = 2;

const API_KEY = process.env.GOOGLE_API_KEY;
const CX = process.env.GOOGLE_CX;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const queriesPath = path.join(__dirname, '..', 'data', 'queries.json');
const eventsPath = path.join(__dirname, '..', 'data', 'events.json');

async function main() {
  if (!API_KEY || !CX) {
    console.error('Missing GOOGLE_API_KEY or GOOGLE_CX repository secrets. Nothing fetched.');
    process.exit(1);
  }

  const queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
  const store = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

  // Enforce the daily run cap.
  const today = new Date().toISOString().slice(0, 10);
  if (store.runDate !== today) {
    store.runDate = today;
    store.runCount = 0;
  }
  if ((store.runCount || 0) >= MAX_RUNS_PER_DAY) {
    console.log(`Hard stop: already ran ${store.runCount} time(s) on ${today} (max ${MAX_RUNS_PER_DAY}). Nothing fetched.`);
    return;
  }
  store.runCount = (store.runCount || 0) + 1;
  console.log(`Run ${store.runCount} of ${MAX_RUNS_PER_DAY} for ${today}.`);

  const existingLinks = new Set(store.items.map(e => e.link));

  const found = [];

  for (const q of queries) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(API_KEY)}&cx=${encodeURIComponent(CX)}&q=${encodeURIComponent(q + ' 2026')}&num=5`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        console.error(`API error for "${q}": ${data.error.message || 'unknown error'}`);
        continue;
      }
      (data.items || []).forEach(item => {
        if (existingLinks.has(item.link)) return;
        existingLinks.add(item.link);
        found.push({
          title: item.title,
          link: item.link,
          snippet: item.snippet || '',
          query: q,
          fetchedAt: new Date().toISOString()
        });
      });
    } catch (e) {
      console.error(`Fetch failed for "${q}": ${e.message}`);
    }
  }

  if (found.length > 0) {
    store.items = store.items.concat(found);
    store.lastUpdated = new Date().toISOString();
    fs.writeFileSync(eventsPath, JSON.stringify(store, null, 2));
    console.log(`Added ${found.length} new result(s).`);

    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      const list = found.slice(0, 5).map(f => `• ${f.title}`).join('\n');
      const more = found.length > 5 ? `\n...and ${found.length - 5} more` : '';
      const text = `Gemba found ${found.length} new result(s) today:\n${list}${more}`;
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
        });
        console.log('Telegram notification sent.');
      } catch (e) {
        console.error('Telegram send failed:', e.message);
      }
    } else {
      console.log('No Telegram secrets set — skipping notification.');
    }
  } else {
    // Still touch lastUpdated so the app can show "checked today, nothing new"
    store.lastUpdated = new Date().toISOString();
    fs.writeFileSync(eventsPath, JSON.stringify(store, null, 2));
    console.log('No new results today.');
  }
}

main();
